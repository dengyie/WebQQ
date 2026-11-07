#!/bin/bash
# 线上 smoke：只读 + dryRun，不产生任何真实加退群/发消息副作用。
#
# 设计约束（都是真实踩过的坑）：
#  1. 绝不打印 token / 凭据；token 只进变量。
#  2. 计数类断言一律用「前后差值」：/api/stats 是按插件实例累计的，
#     直接读绝对值会被上一次运行污染，看不出本次到底发生了什么。
#  3. 路由基数探针带 token：未鉴权请求同样会写 STATS.routes（这条属性由
#     mock 用例覆盖），但线上连发 60 个未鉴权公网请求会把自己的出口 IP
#     打成 20 次鉴权失败 → 该 IP 被 429 锁 10 分钟，脚本失去幂等性。
#     「未鉴权也写路由统计」只发 1 个请求看差值即可。
#  4. 本仓库是公开仓库，真实 QQ/群号/内网地址/公网域名一律不入库：
#     相关值从环境变量注入（VPS 上自己 export，或放一份不进仓库的
#     env 文件再 source）。缺了就跳过对应小节，不影响其他段。
set -u
D=http://127.0.0.1:19001           # 容器外回环
M=${SMOKE_MESH:-}                  # mesh 地址（无则跳过 mesh 小节）
PUB=${SMOKE_PUB:-}                 # 公网地址（无则跳过公网小节）
QQ_ID=${SMOKE_QQ_ID:-}             # 页面部署行里的 QQ（无则跳过该检查）
G=${SMOKE_GROUP:-}                 # 冒烟例群（无则 dryRun/搜索用占位号）
TOK=$(cat /opt/qq-bot/napcat/plugins/napcat-plugin-joiner/token)
H="X-Joiner-Token: $TOK"
code() { curl -s -m 15 -o /dev/null -w "%{http_code}" "$@"; }
jget() { python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print($1)"; }

echo "== 1 鉴权：无口令 / 错误口令 / 对口令（直接+mesh+公网） =="
echo "no-token direct:        $(code $D/api/groups)   # 期望 401"
echo "bad-token direct:       $(code -H 'X-Joiner-Token: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' $D/api/groups)   # 期望 401"
echo "good-token direct:      $(code -H "$H" $D/api/groups)   # 期望 200"
[ -n "$M" ] && echo "good-token mesh:        $(code -H "$H" http://$M:19001/api/groups)   # 期望 200" || echo "good-token mesh:        (skip: SMOKE_MESH 未设)"
[ -n "$PUB" ] && echo "good-token pub:         $(code -H "$H" $PUB/api/groups)   # 期望 200" || echo "good-token pub:         (skip: SMOKE_PUB 未设)"
[ -n "$PUB" ] && echo "no-token pub:           $(code $PUB/api/groups)   # 期望 401" || echo "no-token pub:           (skip)"
echo "note: pub 若出现 429，是本机出口 IP 已攒够鉴权失败（脚本连跑的正常后果），"
echo "      不是故障；等窗口（JOINER_AUTH_FAIL_WINDOW_MS，默认 10min）过期再测。"
echo "note: 从 VPS 打自己的公网域名是**发夹**路径（VPS -> CF 边缘 -> 隧道 -> 回 VPS），"
echo "      往返都跨国，单请求常见 2–20s、部分直接超时（000）。这只反映 VPS 到边缘"
echo "      的链路质量，不代表用户侧；外部网络直连同一地址实测 0.4–1.3s 全成功。"
echo "      判断服务是否可用请看 direct / mesh 两行，pub 行只作链路观测。"

echo "== 2 页面：header 直接回 HTML，含部署行与 send 标签 =="
pg=$(curl -s -m 15 -H "$H" $D/joiner/)
[ -n "$QQ_ID" ] && echo "page has QQ:          $(echo "$pg" | grep -c "$QQ_ID")   # 期望 >=1（部署行）" || echo "page has QQ:          (skip: SMOKE_QQ_ID 未设)"
[ -n "$G" ] && echo "page has placeholder: $(echo "$pg" | grep -c "$G")   # 期望 >=1" || echo "page has placeholder: (skip: SMOKE_GROUP 未设)"
echo "page has send label:  $(echo "$pg" | grep -c "send: '发消息'")   # 期望 1"

echo "== 3 关键接口只读 =="
echo "groups: $(curl -s -m 15 -H "$H" $D/api/groups | head -c 160)"
echo "history: $(curl -s -m 15 -H "$H" $D/api/history | head -c 120)"
echo "stats: $(curl -s -m 15 -H "$H" $D/api/stats | python3 -c 'import json,sys;d=json.load(sys.stdin)["data"];print({"uptimeMs":d["uptimeMs"],"requests":d["requests"],"kernelTimeouts":d["kernelTimeouts"],"kernelZombies":d["kernelZombies"],"historyWriteFailures":d["historyWriteFailures"],"kernelQueue":d["kernelQueue"],"rate":d.get("rate")})')"

echo "== 3b 语义回归：非法 JSON 是 400（不是 500），错误响应统一计数 =="
b=$(curl -s -m 15 -o /dev/null -w "%{http_code}" -X POST -H "$H" -H 'Content-Type: application/json' --data-binary '{not json' $D/api/search)
echo "invalid json:         $b   # 期望 400"
err0=$(curl -s -m 15 -H "$H" $D/api/stats | jget 'd["errors"]')
code $D/api/definitely-missing >/dev/null
err1=$(curl -s -m 15 -H "$H" $D/api/stats | jget 'd["errors"]')
echo "errors:               $err0 -> $err1   # 404 应使计数 +1"
[ "$b" = "400" ] && [ "$err1" -gt "$err0" ] && echo "PASS 错误语义" || echo "FAIL 错误语义"

echo "== 4 路由键基数（差值口径）：60 个杂乱路径只允许进有限键 =="
# 必须打直连：公网隧道单请求可能 3–15s，串行 60 个会有大量 -m 4 超时，
# 请求没落到插件就数不出真实键增量（曾因此误报「未汇总进 /api/other」）。
# 公网只抽样 3 个，验证经隧道后路径同样被规范化。
before=$(curl -s -m 15 -H "$H" $D/api/stats | jget 'json.dumps(d["routes"])')
for i in $(seq 1 60); do curl -s -m 4 -o /dev/null -H "$H" $D/api/nope-$i; done
code $D/api/nope-unauth >/dev/null   # 1 个未鉴权请求：证明未鉴权也写路由统计
if [ -n "$PUB" ]; then
  for i in 1 2 3; do curl -s -m 20 -o /dev/null -H "$H" $PUB/api/pub-nope-$i; done
fi
after=$(curl -s -m 15 -H "$H" $D/api/stats | jget 'json.dumps(d["routes"])')
BEFORE="$before" AFTER="$after" python3 - <<'PY'
import json, os
b, a = json.loads(os.environ["BEFORE"]), json.loads(os.environ["AFTER"])
delta = {}
for k in set(a) | set(b):
    v = a.get(k, 0) - b.get(k, 0)
    if v:
        delta[k] = v
known = {"/", "/api/search", "/api/join", "/api/leave", "/api/send",
         "/api/groups", "/api/history", "/api/stats", "/api/other", "other"}
unknown = sorted(set(a) - known)
print("本次增量:", json.dumps(delta, sort_keys=True, ensure_ascii=False))
print("键总数:", len(a), "未知键:", unknown or "无")
assert not unknown, "出现未知键！"
assert delta.get("/api/other", 0) >= 61, "杂乱路径未汇总进 /api/other"
assert not (delta.get("other", 0) >= 60), "路径没被 /joiner 前缀正确剥掉，退化进 other"
print("PASS 路由键基数有界")
PY
lat=$(curl -s -m 15 -H "$H" $D/api/stats | jget 'len(d["latencyMs"])')
echo "latency 键数: $lat   # 与 routes 同样有界"

echo "== 5 dryRun：加群/退群/发消息（不发生真实请求） =="
[ -n "$G" ] || G=1111111111          # 无冒烟例群时用占位号，只验证 dryRun 语义
echo "join dryRun:   $(curl -s -m 15 -X POST -H "$H" -H 'Content-Type: application/json' -d "{\"group\":\"$G\",\"dryRun\":true}" $D/api/join)"
echo "leave dryRun:  $(curl -s -m 15 -X POST -H "$H" -H 'Content-Type: application/json' -d "{\"group\":\"$G\",\"dryRun\":true}" $D/api/leave)"
echo "send dryRun:   $(curl -s -m 15 -X POST -H "$H" -H 'Content-Type: application/json' -d '{"group":"1111111111","userId":"99","dryRun":true}' $D/api/send)"
[ -n "$G" ] && echo "search:        $(curl -s -m 15 -X POST -H "$H" -H 'Content-Type: application/json' -d "{\"group\":\"$G\"}" $D/api/search | head -c 200)"

echo "== 6 鉴权闸门（mesh 源 = 受信代理）：伪造 IP 20 次失败后该 IP 429，其他 IP 不受影响 =="
if [ -n "$M" ]; then
  IP=198.51.100.77   # TEST-NET-3，不会打到真实客户端
  OTHER=198.51.100.78
  for i in $(seq 1 20); do curl -s -m 15 -o /dev/null -H 'X-Joiner-Token: wrongwrongwrongwrongwrongwrongwrongwrong' -H "cf-connecting-ip: $IP" http://$M:19001/api/groups; done
  echo "blocked IP correct token: $(code -H "$H" -H "cf-connecting-ip: $IP" http://$M:19001/api/groups)   # 期望 429"
  # 对照必须换「另一个伪造 IP」而不是本机回环：伪造只在本机回环上做会锁住
  # 后续所有回环测试（脚本自伤）。同样走 mesh + 受信代理，IP 才是可控的。
  echo "other IP correct token:   $(code -H "$H" -H "cf-connecting-ip: $OTHER" http://$M:19001/api/groups)   # 期望 200（锁 per-IP）"
  # 无口令探测不计入爆破计数：40 个无口令请求之后，同 IP 仍应能正常鉴权。
  for i in $(seq 1 40); do curl -s -m 15 -o /dev/null -H "cf-connecting-ip: $OTHER" http://$M:19001/api/groups; done
  echo "after 40 no-token:        $(code -H "$H" -H "cf-connecting-ip: $OTHER" http://$M:19001/api/groups)   # 期望 200（无口令不锁 IP）"
else
  echo "(skip: SMOKE_MESH 未设)"
fi
curl -s -m 15 -H "$H" $D/api/stats | python3 -c 'import json,sys;d=json.load(sys.stdin)["data"];print("authBlockedIps:",d["authBlockedIps"],"authFailures:",d["authFailures"])'

echo "== 7 内核状态：闸门统计（active/waiting 为 0 = 没有泄漏槽位） =="
curl -s -m 15 -H "$H" $D/api/stats | python3 -c 'import json,sys;d=json.load(sys.stdin)["data"];print("kernel:",d["kernel"],"queue:",d["kernelQueue"])'

echo "== 8 重登/登录态（在线时不触发登录，不打印任何凭据） =="
echo "relogin.py:      $(python3 -I /opt/qq-bot/relogin.py; echo "[exit $?]")   # 期望「在线」exit 0"
echo "login-status.py: $(python3 -I /opt/qq-bot/login-status.py)   # 期望 logged-in"
echo "cred file mode:  $(stat -c '%a' /opt/qq-bot/.webui_cred)   # 期望 600"

echo "== 9 容器健康：白名单 + 镜像固定 + JOINER_* 注入 =="
echo "whitelist hits:  $(docker exec qq-napcat sh -c 'grep -c napcat-plugin-joiner /app/napcat/napcat.mjs')   # 期望 1"
echo "image:           $(docker inspect qq-napcat --format '{{.Config.Image}}')"
echo "joiner env keys: $(docker inspect qq-napcat --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -c '^JOINER_')   # 期望 6（未重建）或 8（重建后）"