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
import time
import urllib.request

BASE = os.environ.get("QQ_WEBUI_BASE", "http://127.0.0.1:6099").rstrip("/")
TOKEN_FILE = pathlib.Path(os.environ.get("QQ_WEBUI_TOKEN_FILE", "/opt/qq-bot/.webui_token"))
PASS_FILE = pathlib.Path(os.environ.get("QQ_PASSWORD_FILE", "/opt/qq-bot/.qq_password"))
STATE_FILE = pathlib.Path(os.environ.get("QQ_RELOGIN_STATE", "/opt/qq-bot/.relogin_state"))
CRED_FILE = pathlib.Path(os.environ.get("QQ_WEBUI_CRED_FILE", "/tmp/qq-webui-cred"))
MIN_INTERVAL = int(os.environ.get("QQ_RELOGIN_MIN_INTERVAL", 30 * 60))  # 两次尝试最小间隔
MAX_TRIES = int(os.environ.get("QQ_RELOGIN_MAX_TRIES", 3))              # 一轮掉线最多尝试次数


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
    if not force and CRED_FILE.exists():
        cached = CRED_FILE.read_text().strip()
        if cached:
            return cached
    digest = hashlib.sha256((TOKEN_FILE.read_text().strip() + ".napcat").encode()).hexdigest()
    cred = call("/api/auth/login", {"hash": digest, "totpCode": ""})["data"]["Credential"]
    CRED_FILE.write_text(cred)
    CRED_FILE.chmod(0o600)
    return cred


def load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {}


def save_state(st):
    STATE_FILE.write_text(json.dumps(st))
    STATE_FILE.chmod(0o600)


def status():
    try:
        return call("/api/QQLogin/CheckLoginStatus", {}, credential())["data"]
    except Exception:
        return call("/api/QQLogin/CheckLoginStatus", {}, credential(force=True))["data"]


def attempt(st, now):
    """发起一次账密登录，返回 (结果, 详情)，同时把计数写回 st。"""
    uin, pwd = PASS_FILE.read_text().strip().split(":", 1)
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
    """看一次登录态；需要时尝试一次重登。返回状态字符串，供看门狗/命令行判断。"""
    st = load_state()
    now = int(time.time())
    data = status()

    if data.get("isLogin"):
        if st:
            save_state({})
            return "recovered"
        return "online"

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
}


def main():
    result = tick()
    st = load_state()
    if result == "cooling":
        now = int(time.time())
        print(f"离线，冷却中（上次尝试 {now - st.get('last', 0)}s 前，"
              f"第 {st.get('tries', 0)}/{MAX_TRIES} 次）")
        return 0
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
