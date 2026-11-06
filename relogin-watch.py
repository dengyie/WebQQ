#!/usr/bin/env python3
"""常驻登录看门狗：只由「掉线检测」触发重登，不再靠 5 分钟定时器盲目尝试。

为什么要它：
- 旧的 `qq-relogin.timer` 每 5 分钟无条件跑一次脚本：大多数时候只是空跑，
  真掉线时要等最多 5 分钟才发起第一次重登；
- NapCat WebUI 本身没有登录事件流（官方页面也是轮询 `CheckLoginStatus`），
  所以检测只能是便宜的本地轮询（默认 10s，一次 <1ms 的本地 HTTP）；
- 本进程常驻后，只有「登录态发生变化」时才真正调 `relogin.tick()` 里那条
  账密登录路径，且沿用它的 30 分钟退避 / 每轮最多 3 次 / 验证码即停。

状态变化才打日志，离线期间不会每 10s 刷一行。退出由 systemd 负责重启。
"""
import os
import sys
import time

import relogin

INTERVAL = int(os.environ.get("QQ_WATCH_INTERVAL", 10))


def main():
    last = None
    while True:
        try:
            result = relogin.tick()
        except Exception as exc:  # WebUI/容器不可达时不要疯狂重试
            if last != "unreachable":
                print(f"watch: 登录态检查失败（{exc}），继续等待", flush=True)
                last = "unreachable"
            time.sleep(INTERVAL)
            continue

        if result != last:
            print(f"watch: {last or 'start'} -> {result}", flush=True)
            last = result
        time.sleep(INTERVAL)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
