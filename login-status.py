#!/usr/bin/env python3
"""打印 NapCat 登录阶段；若最近一次流程是被风控拒绝则输出 risk-control。"""
import hashlib, json, pathlib, subprocess, urllib.request

BASE = "http://127.0.0.1:6099"
TOKEN = pathlib.Path("/opt/qq-bot/.webui_token").read_text().strip()
CRED = pathlib.Path("/tmp/qq-webui-cred")


def call(path, data, cred=""):
    headers = {"Content-Type": "application/json"}
    if cred:
        headers["Authorization"] = "Bearer " + cred
    req = urllib.request.Request(BASE + path, data=json.dumps(data).encode(), method="POST", headers=headers)
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode())


def credential(force=False):
    if not force and CRED.exists():
        cached = CRED.read_text().strip()
        if cached:
            return cached
    digest = hashlib.sha256((TOKEN + ".napcat").encode()).hexdigest()
    cred = call("/api/auth/login", {"hash": digest, "totpCode": ""})["data"]["Credential"]
    CRED.write_text(cred)
    CRED.chmod(0o600)
    return cred


def status():
    try:
        return call("/api/QQLogin/CheckLoginStatus", {}, credential())["data"]
    except Exception:
        return call("/api/QQLogin/CheckLoginStatus", {}, credential(force=True))["data"]


def last_flow_event():
    """最近一次二维码流程事件：发码 / 已扫码 / 风控拒绝。"""
    try:
        out = subprocess.run(["docker", "logs", "-t", "--since", "3m", "qq-napcat"],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, timeout=8)
        lines = [l for l in out.stdout.splitlines()
                 if "二维码已保存到" in l or "已被扫描" in l or "serverErrorCode" in l]
        return lines[-1] if lines else ""
    except Exception:
        return ""


data = status()
if data.get("isLogin"):
    print("logged-in")
elif "serverErrorCode" in last_flow_event():
    print("risk-control")
else:
    print(data.get("loginPhase", "unknown"))
