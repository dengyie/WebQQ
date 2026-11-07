#!/bin/bash
# cloudflared 隧道看门狗（复用腾讯云 Hermes 的成熟模式）：
# 兜住「进程活着但隧道连接全断」这个 systemd Restart=on-failure 覆盖不到的盲区。
#
# 信号优先级（宁可漏判不误杀）：
#   1. cloudflared 自带 HA 指标（--metrics 仅环回）：cloudflared_tunnel_ha_connections
#   2. 回退：按 unit MainPID 数本机到边缘 :7844 的连接。同机有多条隧道时不能全局数——
#      别的隧道（如 balatro）常驻 4 条连接，会把「全断」误判成「健康」
#   3. 两者都拿不到 → 跳过本轮
# 连续 MAX_STRIKES 轮为 0 才 systemctl restart；健康即清零计数。
# 部署：本脚本 -> /usr/local/bin/cloudflared-tunnel-watchdog.sh（root 700），
#       配套 systemd/cloudflared-watchdog.{service,timer} -> /etc/systemd/system/
#       daemon-reload && systemctl enable --now cloudflared-watchdog.timer
# 前置：connector 的 ExecStart 需带 --metrics 127.0.0.1:20242（仅环回；
#       同机多条隧道各用不同 metrics 端口）。
set -u
SERVICE=${WATCHDOG_SERVICE:-cloudflared-qq}
METRICS_URL=${WATCHDOG_METRICS_URL:-http://127.0.0.1:20242/metrics}
STRIKES_FILE=${WATCHDOG_STRIKES_FILE:-/run/cloudflared-watchdog-qq.strikes}
MAX_STRIKES=${WATCHDOG_MAX_STRIKES:-3}
DRY_RUN=${WATCHDOG_DRY_RUN:-0}
FALLBACK_CONNS=${WATCHDOG_FALLBACK_CONNS:-}   # 测试钩子：强制回退信号值（仅测试用）

log() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') cloudflared-watchdog: $*"; }

conns=""
src=""
if out=$(curl -s -m 5 "$METRICS_URL" 2>/dev/null) && [ -n "$out" ]; then
  conns=$(printf '%s\n' "$out" | awk '/^cloudflared_tunnel_ha_connections/{print $2; exit}')
  [ -n "$conns" ] && src="metrics"
fi
if [ -z "$conns" ] && [ -n "$FALLBACK_CONNS" ]; then
  conns=$FALLBACK_CONNS
  src="override"
fi
if [ -z "$conns" ]; then
  main=$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || true)
  if [ -n "$main" ] && [ "$main" != "0" ]; then
    tcp=$(ss -Htnp state established "( dport = :7844 )" 2>/dev/null | grep -c "pid=$main")
    udp=$(ss -Hunp 2>/dev/null | grep "pid=$main" | grep -c ":7844")
    conns=$((tcp + udp))
    src="ss:7844(pid=$main)"
  fi
fi
if [ -z "$conns" ]; then
  log "无信号（metrics 与 ss 回退都不可用）——跳过本轮，宁可不判不误杀"
  exit 0
fi
case "$conns" in
  ''|*[!0-9]*) log "信号非数值（$src: $conns）——跳过本轮"; exit 0 ;;
esac

strikes=$(cat "$STRIKES_FILE" 2>/dev/null || echo 0)
if [ "$conns" -gt 0 ]; then
  [ "$strikes" != "0" ] && log "恢复（$src conns=$conns），strike $strikes -> 0"
  echo 0 > "$STRIKES_FILE"
  exit 0
fi

strikes=$((strikes + 1))
echo "$strikes" > "$STRIKES_FILE"
log "隧道连接数为 0（$src）—— strike $strikes/$MAX_STRIKES"
if [ "$strikes" -ge "$MAX_STRIKES" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN: 将重启 $SERVICE（未执行）"
  else
    log "连续 $strikes 轮 0 连接，重启 $SERVICE"
    systemctl restart "$SERVICE" && echo 0 > "$STRIKES_FILE"
  fi
fi
