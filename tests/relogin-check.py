#!/usr/bin/env python3
"""relogin.py 的行为回归：用假 WebUI 验证退避、上限、恢复、验证码四条路径。

跑法：python3 -I tests/relogin-check.py
（不连真 NapCat：起一个本地 HTTP 假服务，按用例切换 isLogin / 登录返回。）
"""
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SRC = pathlib.Path(__file__).resolve().parent.parent / "relogin.py"

state = {"login": True, "mode": "success", "pw_calls": 0}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        if self.path == "/api/auth/login":
            body = {"code": 0, "data": {"Credential": "cred-1"}}
        elif self.path == "/api/QQLogin/CheckLoginStatus":
            body = {"code": 0, "data": {"isLogin": state["login"]}}
        elif self.path == "/api/QQLogin/PasswordLogin":
            state["pw_calls"] += 1
            mode = state["mode"]
            if mode == "success":
                data = None
            elif mode == "captcha":
                data = {"needCaptcha": True}
            elif mode == "newdevice":
                data = {"needNewDevice": True}
            else:
                data = {"foo": "bar"}
            body = {"code": 0, "data": data}
        else:
            self.send_response(404)
            self.end_headers()
            return
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

tmp = pathlib.Path(tempfile.mkdtemp(prefix="relogin-check-"))
(tmp / "token").write_text("test-token")
(tmp / "pass").write_text("10001:pw")
(tmp / "state").write_text("{}")

os.environ.update({
    "QQ_WEBUI_BASE": "http://127.0.0.1:%d" % server.server_address[1],
    "QQ_WEBUI_TOKEN_FILE": str(tmp / "token"),
    "QQ_PASSWORD_FILE": str(tmp / "pass"),
    "QQ_RELOGIN_STATE": str(tmp / "state"),
    "QQ_WEBUI_CRED_FILE": str(tmp / "cred"),
    "QQ_RELOGIN_MIN_INTERVAL": "1",
    "QQ_RELOGIN_MAX_TRIES": "2",
})

spec = importlib.util.spec_from_file_location("relogin", SRC)
relogin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relogin)

fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ((" | " + str(detail)) if detail else ""))
    if not ok:
        fails.append(name)


def reset():
    (tmp / "state").write_text("{}")
    state["pw_calls"] = 0


# 1. 在线：绝不碰登录接口
reset()
state["login"] = True
check("在线时不登录", relogin.tick() == "online" and state["pw_calls"] == 0, state["pw_calls"])

# 2. 刚掉线：立即尝试一次
state["login"] = False
r = relogin.tick()
check("掉线立即尝试", r == "success" and state["pw_calls"] == 1, r)

# 3. 退避期内不再尝试（成功也只算一次尝试，不因为清空状态而连打）
r = relogin.tick()
check("退避期内不重试", r == "cooling" and state["pw_calls"] == 1, f"{r} calls={state['pw_calls']}")
check("成功后仍保留计数", json.loads((tmp / "state").read_text()).get("tries") == 1,
      (tmp / "state").read_text())

# 4. 退避结束：第二次尝试
time.sleep(1.1)
r = relogin.tick()
check("退避结束再试", r == "success" and state["pw_calls"] == 2, f"{r} calls={state['pw_calls']}")

# 5. 达到本轮上限：不再尝试
r = relogin.tick()
check("达到上限即停", r == "capped" and state["pw_calls"] == 2, f"{r} calls={state['pw_calls']}")

# 6. 恢复登录：状态清空
state["login"] = True
r = relogin.tick()
check("恢复后清空状态", r == "recovered" and (tmp / "state").read_text() == "{}", r)
r = relogin.tick()
check("恢复后回到 online", r == "online", r)

# 7. 验证码：本轮放弃，且退出码 2
reset()
state["login"] = False
state["mode"] = "captcha"
r = relogin.tick()
check("滑块验证即停", r == "captcha" and state["pw_calls"] == 1, r)
reset()
state["mode"] = "captcha"
check("命令行退出码 2", relogin.main() == 2, "captcha")

# 8. 新设备验证
reset()
state["mode"] = "newdevice"
r = relogin.tick()
check("新设备验证即停", r == "newdevice", r)

# 9. 被拒：带上原因，退出码 1
reset()
state["mode"] = "rejected"
r = relogin.tick()
check("被拒带原因", r.startswith("rejected:") and "foo" in r, r)
reset()
state["mode"] = "rejected"
check("命令行退出码 1", relogin.main() == 1, "rejected")

# 10. WebUI 不可达：抛错而不是瞎登录（看门狗负责吞掉并等下一轮）
server.shutdown()
try:
    relogin.tick()
    unreachable_ok = False
except Exception:
    unreachable_ok = True
check("WebUI 不可达时抛错", unreachable_ok)

print("RESULT=%s" % ("OK" if not fails else "FAIL " + ",".join(fails)))
sys.exit(0 if not fails else 2)
