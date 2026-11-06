#!/usr/bin/env python3
"""群邀请自动接受器：只放行 TARGET_GROUP 指定的一个群，其余一律跳过。"""
import json, os, pathlib, sys, time, urllib.request

# 只接受这一个群的邀请/申请，其余全部跳过
GROUP = int(os.environ.get("TARGET_GROUP", "0") or 0)
TOKEN_FILE = pathlib.Path(os.environ.get("ONEBOT_TOKEN_FILE", "/opt/qq-bot/.onebot_token"))
STATE_FILE = pathlib.Path(os.environ.get("INVITE_STATE_FILE", "/opt/qq-bot/.invite_state.json"))

def ob(action, params=None):
    req = urllib.request.Request(
        f"http://127.0.0.1:3000/{action}",
        data=json.dumps(params or {}).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + TOKEN_FILE.read_text().strip()},
        method="POST")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())

def main():
    if not GROUP:
        print("TARGET_GROUP not set; refusing to act"); sys.exit(1)
    st = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}
    if st.get("done"):
        print("already-done", st.get("ts", ""))
        return
    if not ob("get_login_info").get("data"):
        print("not-logged-in"); sys.exit(1)
    msgs = ob("get_group_system_msg").get("data") or {}
    # invite_list → sub_type=invite；join_request_list → sub_type=add
    pending = [(it, "invite") for it in (msgs.get("invite_list") or [])] + \
              [(it, "add") for it in (msgs.get("join_request_list") or [])]
    acted = False
    for it, sub in pending:
        gid, flag = it.get("group_id"), it.get("flag")
        if gid == GROUP and flag:
            r = ob("set_group_add_request",
                   {"flag": flag, "sub_type": sub, "approve": True})
            if r.get("retcode") == 0:
                STATE_FILE.write_text(json.dumps(
                    {"done": True, "ts": time.strftime("%F %T")}))
                print("ACCEPTED", gid, sub)
                acted = True
            else:
                print("accept-failed", r.get("message", ""))
                sys.exit(1)
        else:
            print("skip non-target", gid)
    if not acted:
        print("no matching pending invite")

if __name__ == "__main__":
    main()
