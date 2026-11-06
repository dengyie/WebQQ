#!/usr/bin/env python3
"""打印 NapCat 登录阶段；若最近一次流程是被风控拒绝则输出 risk-control。

凭据获取/状态检查直接复用 relogin.py，避免两处各写一份 /tmp 缓存与鉴权逻辑
（旧版本在这里硬编码 /tmp/qq-webui-cred，与 relogin 的缓存互不相认）。
"""
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from relogin import status  # noqa: E402


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
