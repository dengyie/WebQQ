#!/usr/bin/env bash
# 打印 NapCat 最新登录二维码（ASCII + 解码 URL），并导出 PNG 到 /opt/qq-bot/qrcode.png
set -euo pipefail
docker logs --tail 200 qq-napcat 2>&1 | grep -E "二维码解码URL|▄" | tail -40 || true
if docker exec qq-napcat test -f /app/napcat/cache/qrcode.png 2>/dev/null; then
  docker cp qq-napcat:/app/napcat/cache/qrcode.png /opt/qq-bot/qrcode.png
  echo "PNG 已导出: /opt/qq-bot/qrcode.png"
fi
