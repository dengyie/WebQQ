#!/usr/bin/env python3
"""掉线自动账密重登：离线时经 WebUI API 用保存的账密重登 NapCat。

策略（防风控）：
- 已登录 → 直接退出，不碰登录接口；
- 离线 → 距上次尝试 ≥30 分钟才发起；每轮掉线（期间未登录过）最多尝试 3 次；
- 账密登录返回「成功」只代表请求被受理、内核在启动，**仍算一次尝试**并继续
  按 30 分钟退避等待，避免内核迟迟不回来时被反复登录（风控红线）；
- 返回 needCaptcha / needNewDevice → 本轮放弃（需人工），计入失败次数；
- 恢复正常登录后自动清空状态，下一轮掉线重新计数。

状态文件 /opt/qq-bot/.relogin_state；凭据 /opt/qq-bot/.qq_password（uin:密码）。
`relogin-watch.py` 常驻调用 `tick()`；本文件也保留一次性命令行用法。
"""
import hashlib
import json
import os
import pathlib
import tempfile
import time
import urllib.request

BASE = os.environ.get("QQ_WEBUI_BASE", "http://127.0.0.1:6099").rstrip("/")
TOKEN_FILE = pathlib.Path(os.environ.get("QQ_WEBUI_TOKEN_FILE", "/opt/qq-bot/.webui_token"))
PASS_FILE = pathlib.Path(os.environ.get("QQ_PASSWORD_FILE", "/opt/qq-bot/.qq_password"))
STATE_FILE = pathlib.Path(os.environ.get("QQ_RELOGIN_STATE", "/opt/qq-bot/.relogin_state"))
# 凭据缓存不能放 /tmp：同一台机器上任何用户都能预创建/替换，等于把 WebUI 凭据
# 交给本地竞争方。固定放在运维目录（0600），与 state/密码文件同源。
CRED_FILE = pathlib.Path(os.environ.get("QQ_WEBUI_CRED_FILE", "/opt/qq-bot/.webui_cred"))
MIN_INTERVAL = int(os.environ.get("QQ_RELOGIN_MIN_INTERVAL", 30 * 60))  # 两次尝试最小间隔
MAX_TRIES = int(os.environ.get("QQ_RELOGIN_MAX_TRIES", 3))              # 一轮掉线最多尝试次数


def atomic_write(path, text):
    """同目录临时文件 + fsync + rename：崩溃时不会留下半截状态/凭据。"""
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix="." + path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def call(path, data, cred=""):
    headers = {"Content-Type": "application/json"}
    if cred:
        headers["Authorization"] = "Bearer " + cred
    req = urllib.request.Request(BASE + path, data=json.dumps(data).encode(),
                                 method="POST", headers=headers)
    with urllib.request.urlopen(req, timeout=8) as resp:
        body = json.loads(resp.read().decode())
    if isinstance(body, dict) and body.get("code") == -1:
        raise RuntimeError(body.get("message", "unauthorized"))
    return body


def credential(force=False):
    if not force:
        try:
            cached = CRED_FILE.read_text().strip()
        except Exception:
            cached = ""
        if cached:
            return cached
    digest = hashlib.sha256((TOKEN_FILE.read_text().strip() + ".napcat").encode()).hexdigest()
    cred = call("/api/auth/login", {"hash": digest, "totpCode": ""})["data"]["Credential"]
    try:
        atomic_write(CRED_FILE, cred)
    except Exception:
        pass  # 缓存写不进去也不能影响本次调用
    return cred


def load_state():
    """状态缺失 = 全新；损坏 = fail-safe 标记，交由 tick 停止自动重登。"""
    try:
        raw = STATE_FILE.read_text()
    except FileNotFoundError:
        return {}
    except Exception:
        return {"corrupt": True}
    try:
        st = json.loads(raw)
    except Exception:
        return {"corrupt": True}
    return st if isinstance(st, dict) else {"corrupt": True}


def save_state(st):
    atomic_write(STATE_FILE, json.dumps(st))


def status():
    try:
        return call("/api/QQLogin/CheckLoginStatus", {}, credential())["data"]
    except Exception:
        return call("/api/QQLogin/CheckLoginStatus", {}, credential(force=True))["data"]


def attempt(st, now):
    """发起一次账密登录，返回 (结果, 详情)，同时把计数写回 st。"""
    try:
        uin, pwd = PASS_FILE.read_text().strip().split(":", 1)
    except Exception as exc:  # 密码文件缺失/格式错:不算一次尝试,也不碰登录接口
        return "error", exc
    md5 = hashlib.md5(pwd.encode()).hexdigest()
    st["tries"] = st.get("tries", 0) + 1
    st["last"] = now
    try:
        resp = call("/api/QQLogin/PasswordLogin", {"uin": uin, "passwordMd5": md5},
                    credential(force=True))["data"]
    except Exception as exc:
        save_state(st)
        return "error", exc

    save_state(st)
    if resp is None:
        return "success", None
    if resp.get("needCaptcha"):
        return "captcha", None
    if resp.get("needNewDevice"):
        return "newdevice", None
    return "rejected", resp


def tick():
    """看一次登录态;需要时尝试一次重登。返回状态字符串,供看门狗/命令行判断。"""
    st = load_state()
    now = int(time.time())
    data = status()

    if data.get("isLogin"):
        if st:
            save_state({})
            return "recovered"
        return "online"

    if st.get("corrupt"):
        return "corrupt"  # 状态文件损坏:不盲目重登,等人工处理
    if st.get("tries", 0) >= MAX_TRIES:
        return "capped"
    if now - st.get("last", 0) < MIN_INTERVAL:
        return "cooling"

    result, detail = attempt(st, now)
    if result == "error":
        return "error:%s" % detail
    if result == "rejected":
        return "rejected:%s" % json.dumps(detail, ensure_ascii=False)
    return result


MESSAGES = {
    "online": "在线",
    "cooling": "离线，冷却中",
    "capped": "离线，已达本轮上限，等人工介入（账密/扫码）",
    "success": "账密重登已受理，等待内核上线",
    "captcha": "触发滑块验证，需人工",
    "newdevice": "触发新设备验证，需人工",
    "corrupt": "状态文件损坏，已停止自动重登（等人工检查）",
}


def main():
    result = tick()
    st = load_state()
    if result == "cooling":
        now = int(time.time())
        print(f"离线，冷却中（上次尝试 {now - st.get('last', 0)}s 前，"
              f"第 {st.get('tries', 0)}/{MAX_TRIES} 次）")
        return 0
    if result == "corrupt":
        print("状态文件损坏，已停止自动重登，请人工检查 " + str(STATE_FILE))
        return 2
    if result.startswith("error:"):
        print(f"第 {st.get('tries', 0)} 次账密重登请求失败：{result[6:]}")
        return 1
    if result.startswith("rejected:"):
        print(f"第 {st.get('tries', 0)} 次账密重登被拒：{result[9:]}")
        return 1
    if result == "success":
        print(f"第 {st.get('tries', 0)} 次账密重登：成功，等待内核上线")
        return 0
    if result == "recovered":
        print("logged-in（已恢复登录，本轮掉线结束）")
        return 0
    print(MESSAGES.get(result, result))
    return 2 if result in ("captcha", "newdevice") else 0


if __name__ == "__main__":
    raise SystemExit(main())
