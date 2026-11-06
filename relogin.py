#!/usr/bin/env python3
"""掉线自动账密重登：离线时经 WebUI API 用保存的账密重登 NapCat。

策略（防风控）：
- 已登录 → 直接退出，不碰登录接口；
- 离线 → 距上次尝试 ≥30 分钟才发起；每轮掉线（期间未登录过）最多尝试 3 次；
- 返回 needCaptcha / needNewDevice → 本轮放弃（需人工），计入失败次数。
状态文件 /opt/qq-bot/.relogin_state；凭据 /opt/qq-bot/.qq_password（uin:密码）。
"""
import hashlib, json, pathlib, sys, time, urllib.request

BASE = "http://127.0.0.1:6099"
TOKEN = pathlib.Path("/opt/qq-bot/.webui_token").read_text().strip()
PASS_FILE = pathlib.Path("/opt/qq-bot/.qq_password")
STATE_FILE = pathlib.Path("/opt/qq-bot/.relogin_state")
CRED_FILE = pathlib.Path("/tmp/qq-webui-cred")
MIN_INTERVAL = 30 * 60          # 两次尝试最小间隔
MAX_TRIES = 3                   # 一轮掉线最多尝试次数


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
    digest = hashlib.sha256((TOKEN + ".napcat").encode()).hexdigest()
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


def main():
    st = load_state()
    now = int(time.time())
    try:
        logged_in = call("/api/QQLogin/CheckLoginStatus", {}, credential())["data"].get("isLogin")
    except Exception:
        logged_in = call("/api/QQLogin/CheckLoginStatus", {}, credential(force=True))["data"].get("isLogin")

    if logged_in:
        if st.get("tries"):
            print(f"logged-in（本轮掉线结束，共尝试 {st['tries']} 次）")
        save_state({})
        return

    if now - st.get("last", 0) < MIN_INTERVAL:
        print(f"离线，冷却中（上次尝试 {now - st.get('last', 0)}s 前，第 {st.get('tries', 0)}/{MAX_TRIES} 次）")
        return
    if st.get("tries", 0) >= MAX_TRIES:
        print(f"离线，已达本轮上限 {MAX_TRIES} 次，等人工介入（账密/扫码）")
        return

    uin, pwd = PASS_FILE.read_text().strip().split(":", 1)
    md5 = hashlib.md5(pwd.encode()).hexdigest()
    st["tries"] = st.get("tries", 0) + 1
    st["last"] = now
    try:
        resp = call("/api/QQLogin/PasswordLogin", {"uin": uin, "passwordMd5": md5},
                    credential(force=True))["data"]
    except Exception as exc:
        save_state(st)
        print(f"第 {st['tries']} 次账密重登请求失败：{exc}")
        sys.exit(1)

    if resp is None:
        save_state({})
        print(f"第 {st['tries']} 次账密重登：成功，等待内核上线")
    elif resp.get("needCaptcha"):
        save_state(st)
        print(f"第 {st['tries']} 次账密重登：触发滑块验证，需人工")
        sys.exit(2)
    elif resp.get("needNewDevice"):
        save_state(st)
        print(f"第 {st['tries']} 次账密重登：触发新设备验证，需人工")
        sys.exit(2)
    else:
        save_state(st)
        print(f"第 {st['tries']} 次账密重登被拒：{resp}")
        sys.exit(1)


if __name__ == "__main__":
    main()
