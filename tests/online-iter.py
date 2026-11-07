#!/usr/bin/env python3
"""线上迭代验证：只读 + dryRun，不产生真实加退群/发消息副作用。

覆盖 online-smoke.sh 之外的链路，且严格按实现语义断言：
  A. query -> 302 + Set-Cookie；仅 cookie 能过；错误 cookie 不短路 header
  B. CSRF：仅 cookie 鉴权的 POST 才校验 Origin（同源放行 / 跨站 403）
  C. x-forwarded-proto 只在受信代理上采信 -> Set-Cookie 带 Secure
  D. 24 并发 groups + 12 并发 search：有界队列语义（200 或 503）+ 排水后水位归零
  E. latencyMs 数值单调 p50<=p99<=max
  F. 4s TTL 内重复 groups 不额外消耗 search 配额
  G. 响应头审计：200/401/404 都带 no-store 与安全头
  H. 方法与状态矩阵：GET/POST 错配 404、未知路径带/不带口令 404/401
  I. 边界输入：9KB body 413、空 body 400、非法 group 校验文案不回显
  J. 内核错误语义：假群号不落 500（v1.6.5 起 502=上游，404=搜不到），文案不外泄内核原文
  K. stats 深度字段：eventLoopDelayMs 五元组、rssMB/uptimeMs/cache/historyInMemory 合理
  L. 轻量 soak：混合负载后队列归零、无新增超时/僵尸（RSS 漂移只打印不断言）

公开仓库不入真实地址/账号，故：
  - 回环地址固定 127.0.0.1；受信代理源用 SMOKE_MESH（如 10.x.y.z）
  - 冒烟例群用 SMOKE_GROUP（缺省用占位号，search 可能 404，D 节自动放宽）
用法（VPS 上）：
  SMOKE_MESH=<mesh 地址> SMOKE_GROUP=<例群> python3 -I tests/online-iter.py
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

BASE = os.environ.get("SMOKE_BASE", "http://127.0.0.1:19001")
MESH_IP = os.environ.get("SMOKE_MESH", "")
MESH = f"http://{MESH_IP}:19001" if MESH_IP else ""
GROUP = os.environ.get("SMOKE_GROUP", "1111111111")
TOKEN_PATH = os.environ.get(
    "SMOKE_TOKEN_FILE", "/opt/qq-bot/napcat/plugins/napcat-plugin-joiner/token")
TOK = open(TOKEN_PATH).read().strip()
FAILS = []


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """302 原样返回，不跟随——否则「口令换 cookie」会被跟到无 cookie 的页面。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect())


def raw(path, method="GET", body=None, hdr=None, base=BASE, timeout=40):
    data = None if body is None else json.dumps(body).encode()
    h = dict(hdr or {})
    if body is not None:
        h["Content-Type"] = "application/json"
    r = urllib.request.Request(base + path, data=data, method=method, headers=h)
    try:
        with _OPENER.open(r, timeout=timeout) as resp:
            b = resp.read().decode()
            return resp.status, dict(resp.headers), (json.loads(b) if b else None)
    except urllib.error.HTTPError as e:
        b = e.read().decode()
        try:
            return e.code, dict(e.headers), json.loads(b)
        except Exception:
            return e.code, dict(e.headers), b


def check(name, cond, detail=""):
    print(("PASS" if cond else "FAIL"), name, ("" if cond else detail))
    if not cond:
        FAILS.append(name)


def stats():
    c, _, d = raw("/api/stats", hdr={"X-Joiner-Token": TOK})
    assert c == 200 and d and "data" in d, (c, d)
    return d["data"]


print("== A 口令换 cookie：302 落地 + 来源回落 ==")
c, h, _ = raw("/joiner/?token=" + TOK)
sc = h.get("Set-Cookie", "")
check("query token 302", c == 302, f"code={c}")
check("302 带 Set-Cookie", sc.startswith("joiner_token=") and "Path=/joiner" in sc, sc[:160])
check("Location 不含 token", "token=" not in h.get("Location", ""), h.get("Location"))
c2, _, d2 = raw("/api/groups", hdr={"Cookie": "joiner_token=" + TOK})
check("仅 cookie 放行", c2 == 200 and d2 and d2.get("ok") is True, f"code={c2} {d2}")
c3, _, d3 = raw("/api/groups", hdr={"Cookie": "joiner_token=wrong", "X-Joiner-Token": TOK})
check("错误 cookie 不短路 header", c3 == 200 and d3 and d3.get("ok") is True, f"code={c3} {d3}")

print("== B CSRF：cookie 鉴权下的 POST 才校验 Origin ==")
cookie = {"Cookie": "joiner_token=" + TOK}
c4, _, d4 = raw("/api/leave", "POST", {"group": GROUP, "dryRun": True},
                hdr={**cookie, "Origin": BASE})
check("同源 Origin 放行", c4 == 200 and d4 and d4.get("ok") is True, f"code={c4} {d4}")
c5, _, d5 = raw("/api/leave", "POST", {"group": GROUP, "dryRun": True},
                hdr={**cookie, "Origin": "https://evil.example"})
check("跨站 Origin 403", c5 == 403, f"code={c5} {d5}")
c6, _, d6 = raw("/api/leave", "POST", {"group": GROUP, "dryRun": True},
                hdr={"X-Joiner-Token": TOK, "Origin": "https://evil.example"})
check("header 鉴权不受 Origin 限制（脚本场景）", c6 == 200 and d6 and d6.get("ok") is True,
      f"code={c6} {d6}")

if MESH:
    print("== C x-forwarded-proto 只在受信代理上采信 ==")
    c7, h7, _ = raw("/joiner/?token=" + TOK, base=MESH, hdr={"X-Forwarded-Proto": "https"})
    sc7 = h7.get("Set-Cookie", "")
    check("受信源 + https proto -> Secure cookie", c7 in (301, 302) and "Secure" in sc7,
          f"code={c7} setcookie={sc7[:160]}")
    c8, h8, _ = raw("/joiner/?token=" + TOK, base=MESH)
    sc8 = h8.get("Set-Cookie", "")
    check("受信源无 proto 头 -> 不加 Secure", c8 in (301, 302) and "Secure" not in sc8,
          f"code={c8} setcookie={sc8[:160]}")
else:
    print("== C (skip: SMOKE_MESH 未设，转发头信任分支由 mock 用例覆盖) ==")

print("== D 并发排水 ==")


def ok_get(path):
    c, _, d = raw(path, hdr={"X-Joiner-Token": TOK})
    return c == 200 and d and d.get("ok") is True


def search_code(_):
    c, _, _ = raw("/api/search", "POST", {"group": GROUP}, hdr={"X-Joiner-Token": TOK})
    return c


t0 = time.time()
with ThreadPoolExecutor(24) as ex:
    gres = list(ex.map(lambda _: ok_get("/api/groups"), range(24)))
print(f"24 并发 groups: {sum(gres)}/24 通过，耗时 {time.time()-t0:.2f}s")
check("24 并发 groups 全 200", all(gres), str(gres))

# 有界队列：排队上限默认 8，并发打满时超出部分必须快速 503（不是挂起、不是 500）。
# 断言「全部落在 {200,503,429}」+「至少 2 个成功」+ 结束后水位归零。429 = 测试自身把
# search 限流配额（120/h 滚动窗口）打满，属脚本连跑副作用而非回归；真正要抓的是
# 500（插件 bug）与挂起。
t1 = time.time()
with ThreadPoolExecutor(12) as ex:
    scodes = list(ex.map(search_code, range(12)))
dist = Counter(scodes)
print(f"12 并发 search 状态分布: {dict(dist)}，耗时 {time.time()-t1:.2f}s")
check("并发 search 状态码健康（200/503/429，无 500/挂起）",
      set(scodes) <= {200, 503, 429}, str(scodes))
check("至少 2 个成功（内核确实在工作）", dist.get(200, 0) >= 2, str(dist))

time.sleep(1)
st = stats()
q = st["kernelQueue"]
print("kernelQueue:", q)
check("排水后 active=0 waiting=0 zombies=0",
      q["active"] == 0 and q["waiting"] == 0 and q["zombies"] == 0, str(q))
check("全程零超时零僵尸", st["kernelTimeouts"] == 0 and st["kernelZombies"] == 0,
      f"timeouts={st['kernelTimeouts']} zombies={st['kernelZombies']}")

print("== E latencyMs 健康 ==")
lat = stats()["latencyMs"]
ok = bool(lat)
for k, v in lat.items():
    if not isinstance(v, dict):
        ok = False
        continue
    if all(x in v for x in ("p50", "p99", "max")):
        vals = [v["p50"], v["p99"], v["max"]]
        ok = ok and all(isinstance(x, (int, float)) and x >= 0 for x in vals)
        ok = ok and v["p50"] <= v["p99"] <= v["max"]
print("latency:", json.dumps(lat, ensure_ascii=False)[:300])
check("latency 数值有效且单调", ok)

print("== F 缓存命中不额外吃 search 配额 ==")
r0 = stats()["rate"]["search"]
for _ in range(3):
    ok_get("/api/groups")  # 必须带鉴权：无口令 401 不写配额，测不出配额变化
r1 = stats()["rate"]["search"]
check("4s TTL 内 3 次 groups 配额不增", r1 == r0, f"search {r0} -> {r1}")

print("== G 响应头审计 ==")
c, h, _ = raw("/api/groups", hdr={"X-Joiner-Token": TOK})
for k in ("Cache-Control", "X-Robots-Tag", "Referrer-Policy",
          "X-Content-Type-Options", "X-Frame-Options"):
    check(f"200 带 {k}", h.get(k) is not None, str(h))
check("200 Cache-Control=no-store", h.get("Cache-Control") == "no-store", h.get("Cache-Control"))
_, h401, _ = raw("/api/groups")
check("401 也带 no-store + DENY",
      h401.get("Cache-Control") == "no-store" and h401.get("X-Frame-Options") == "DENY",
      f"cc={h401.get('Cache-Control')} xfo={h401.get('X-Frame-Options')}")
_, h404, _ = raw("/api/iter-nope-probe", hdr={"X-Joiner-Token": TOK})
check("404 带 no-store", h404.get("Cache-Control") == "no-store", h404.get("Cache-Control"))

print("== H 方法与状态矩阵 ==")
c, _, _ = raw("/api/search", hdr={"X-Joiner-Token": TOK})
check("GET /api/search -> 404（POST-only）", c == 404, f"code={c}")
c, _, _ = raw("/api/groups", "POST", {"group": GROUP}, hdr={"X-Joiner-Token": TOK})
check("POST /api/groups -> 404", c == 404, f"code={c}")
c, _, _ = raw("/api/groups", method="OPTIONS", hdr={"X-Joiner-Token": TOK})
check("OPTIONS -> 404（不开 CORS 预检面）", c == 404, f"code={c}")
c, _, _ = raw("/api/iter-nope-probe", hdr={"X-Joiner-Token": TOK})
check("未知路径带口令 -> 404", c == 404, f"code={c}")
c, _, _ = raw("/api/iter-nope-probe")
check("未知路径无口令 -> 401（鉴权前置；无口令不计爆破）", c == 401, f"code={c}")

print("== I 边界输入 ==")
c, _, _ = raw("/api/search", "POST", {"group": "x" * 9000}, hdr={"X-Joiner-Token": TOK})
check("9KB body -> 413", c == 413, f"code={c}")
c, _, _ = raw("/api/search", method="POST", hdr={"X-Joiner-Token": TOK})
check("空 body POST -> 400", c == 400, f"code={c}")
c, _, d = raw("/api/search", "POST", {"group": "<script>alert(1)</script>"},
              hdr={"X-Joiner-Token": TOK})
check("非法 group 校验文案且不回显 payload",
      c == 400 and "<script" not in str(d), f"code={c} body={str(d)[:120]}")

print("== J 内核错误语义（假群号，约 5s） ==")
c, _, d = raw("/api/search", "POST", {"group": "9999999999"}, hdr={"X-Joiner-Token": TOK})
check("假群号 ok:false 且不落 500（v1.6.5：502=上游没答案，404=确认搜不到）",
      c in (404, 502) and isinstance(d, dict) and d.get("ok") is False, f"code={c} {str(d)[:160]}")
check("错误文案不外泄内核原文", "NTEvent" not in str(d), str(d)[:160])

print("== K stats 深度字段 ==")
st = stats()
el = st.get("eventLoopDelayMs") or {}
check("eventLoopDelayMs 四元组数值有效",
      all(isinstance(el.get(k), (int, float)) and el[k] >= 0 for k in ("mean", "p50", "p99", "max")),
      str(el))
check("eventLoopWindowMs 为正数", isinstance(st.get("eventLoopWindowMs"), (int, float))
      and st["eventLoopWindowMs"] > 0, str(st.get("eventLoopWindowMs")))
check("rssMB/uptimeMs 合理", isinstance(st.get("rssMB"), (int, float)) and st["rssMB"] > 0
      and st.get("uptimeMs", 0) > 0, f"rss={st.get('rssMB')} up={st.get('uptimeMs')}")
cache = st.get("cache") or {}
check("cache 命中/未命中计数存在",
      isinstance(cache.get("groupsHit"), int) and isinstance(cache.get("groupsMiss"), int), str(cache))
check("historyInMemory 在环形上限内", isinstance(st.get("historyInMemory"), int)
      and 0 <= st["historyInMemory"] <= 200, str(st.get("historyInMemory")))

print("== L 轻量 soak（15 groups + 3 search） ==")
s0 = stats()
r0rss, t0, z0 = s0["rssMB"], s0["kernelTimeouts"], s0["kernelZombies"]
for _ in range(3):
    for _ in range(5):
        ok_get("/api/groups")
    search_code(0)
time.sleep(1)
s1 = stats()
print(f"rssMB {r0rss} -> {s1['rssMB']}（GC 波动属正常，只观测）  kernelTimeouts {t0} -> {s1['kernelTimeouts']}")
q1 = s1["kernelQueue"]
check("soak 后队列归零", q1["active"] == 0 and q1["waiting"] == 0 and q1["zombies"] == 0, str(q1))
check("soak 无新增超时/僵尸", s1["kernelTimeouts"] == t0 and s1["kernelZombies"] == z0,
      f"timeouts {t0}->{s1['kernelTimeouts']} zombies {z0}->{s1['kernelZombies']}")

print()
if FAILS:
    print("FAILED:", FAILS)
    sys.exit(1)
print("RESULT=OK")