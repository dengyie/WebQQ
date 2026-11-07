# napcat-plugin-joiner mock 测试

- 适用：v1.6.4（覆盖 1.2.1 的 cleanup 关端口 / 413 / 口令缓存，1.2.2 的并发闸门 / 超时 / listen 抛错 / 8KB 上限 / `/api/stats`，1.2.3 的直方图 `.enable()`，1.3.0 的口令换 cookie / CSRF / 爆破闸门，1.4.0 的同源 Origin / 加群去重 / rcOf 未知 / 缓存代际 / 落盘串行化，1.5.0 的有界内核队列 / 按实例统计，1.6.0 的路由级延迟 p50/p99 / `npm test` 单入口，1.6.1 的掉线检测触发重登，1.6.2 的路由键白名单 / 鉴权锁过期 / 槽位随底层 settle 释放 / cleanup 取消等待者 / quitGroup 兜底超时 / 加群冷却一致性 / authOf 回落 / 历史写失败计数 / groups 配额共享，1.6.3 的僵尸槽位回收 / 环境变量校验回退 / 口令空读保留 / 非法 JSON 400 / 错误响应统一计数 / requestTimeout 按内核预算对齐，1.6.4 的无口令探测不计入爆破锁，1.6.5 的内核错误上游语义 502）
- 原理：假内核（GroupApi/MsgApi/session）+ 真 `plugin_init` + 真 HTTP，**不连 QQ/NapCat**
- 宿主 VPS 无 node，须在任意有 node>=18 且 19001 空闲的机器复跑。**推荐一条命令**：

  ```bash
  npm test        # tests/run-all.mjs：自动拷最新插件到 /tmp/joiner-mock/plugin、清 19001、依次跑 mock + race + queue + timeout + relogin-check
  ```

  分段跑也行（调试时更直观）：
  1. 拉一份插件副本（避免污染线上数据）：`mkdir -p /tmp/j && cp napcat/plugins/napcat-plugin-joiner/{index.mjs,page.html,package.json} /tmp/j/`
  2. `JOINER_DIR=/tmp/j node --test --test-force-exit --test-timeout=120000 --test-reporter=spec mock.test.mjs`
  3. 若上一轮异常退出留下监听进程：`lsof -nP -iTCP:19001 -sTCP:LISTEN -t | xargs -r kill -9`（**必须先清**，否则新实例 listen 失败、请求全打到旧进程）
- 期望：**43 个用例全过**。历史回归锚点（跑旧版本时应当红的用例）：
  - v1.2.0：`超大 body 回 413`、`cleanup 释放端口可重复 init`
  - v1.2.1：`内核并发闸门（6 并发峰值 ≤2）`、`/api/stats 字段`、`listen 失败抛错`、`页面/口令 watch 热更新（8KB 上限）`
  - v1.2.2：`/api/stats` 的四个 eventLoopDelayMs 字段为 `null`（未 `.enable()`）
  - v1.2.3：`?token=` 直接回 200 HTML（v1.3.0 起是 302 + Set-Cookie）
  - v1.3.0：`同源 Origin（非白名单 Host）也必须放行` 会 403（白名单判据的 P1）、`加群去重：同一群并发点击只向 QQ 提交一次` 会提交 2 次、`内核没给 result 时必须是「未知」` 会假成功
  - v1.4.0：`内核队列有界` 会全 200（无限排队）、`重载后直方图窗口归零` 会继承上一实例的窗口
  - v1.5.0：`路由级延迟：/api/search 变慢体现在 p99` 的 `latencyMs` 为 `undefined`；`npm test` 不存在（要手动拷文件）
  - v1.6.0：`relogin.py` 成功登录后清空计数（内核迟迟不回时会每隔一次就再登一次，撞风控）；没有 `relogin-watch.py`，只有 5 分钟定时器
  - v1.6.1：`路由键基数`（任意路径都会新增 routes/latency 键，未鉴权也能写）、`鉴权失败闸门…窗口过期后应自动解锁`（锁永不失效）、`quitGroup 兜底分支受超时保护`（兜底分支无超时）、`TTL 4s … rate bucket 增 1`（并发 groups 各吃一次配额）、`内核调用…不留残余定时器`（超时即放槽，底层仍在跑）、`发消息` 的 502 断言（`{}` / 非 0 result 被报成功）、`加群：result=0 也进入冷却`（退群后仍被冷却挡住）、`历史写盘失败要计数`（写失败静默）
  - v1.6.2：`内核永不 settle：硬上限后强制回收僵尸槽位`（两个挂死调用把槽位永久占死，插件一直 503）、`非法 JOINER_* 环境变量回退默认值`（`Math.max(x, NaN)=NaN` 让并发上限/队列/等待全部失效）、`token 文件被清空/读失败的瞬间…`（内存口令被击穿成空，全员 401）、`readBody…非法 JSON 回 400`（曾被锁成 500）
  - v1.6.5：`搜索：…内核抛错不外泄原文` 断言 500（内核报错被翻译后丢进兜底 500，和插件自身缺陷混在一个信号里；v1.6.5 起应为 502）
- 时序相关用例有 1.3–8.4s 的显式等待（口令/页面 watch 500ms 轮询、群列表 4s TTL、鉴权锁定窗口 2.5s、内核超时 300ms/慢调用 1.2s、僵尸回收 400ms），总时长约 38s，属正常
- `port-check.mjs`：单独验证 cleanup 关端口 + 同模块二次 init 复用端口
- `queue-check.mjs`：**有界队列的独立取证脚本**（standalone，`JOINER_KERNEL_WAIT_MS=300` 注入）：2 个慢调用占满槽位后，第 3 个约 300ms 拿到 503「排队超时」，且慢调用结束后第 4 个仍能 200（槽位没泄漏）；输出 `RESULT=OK`、退出码 0
- `timeout-check.mjs`：**内核超时的独立取证脚本**（standalone，`JOINER_KERNEL_TIMEOUT_MS=300` + `JOINER_KERNEL_WAIT_MS=200` 注入）：2 个 1.2s 慢调用各约 300ms 回 503「超时」；排队者约 200ms 回 503「排队超时」；底层未 settle 前新请求仍拿不到槽位；settle 后恢复 200，`stats.kernelQueue.active === 0`、`kernelTimeouts >= 2`
- `race-check.mjs`：**加群去重的独立取证脚本**（standalone，不进 `node --test`）：慢搜索 300ms 放大竞态，并发发 2 个 `/api/join`，打印 `reqToJoinGroup 实际调用次数`——去重生效时 **1**（退出码 0），未去重时 **2**（退出码 2）。用法：`node race-check.mjs`（源码目录默认取仓库相对路径，可用 `JOINER_SRC` 覆盖；自己拷进 `/tmp/joiner-mock/race-plugin/` 再跑）
- `run-all.mjs`：`npm test` 的实现——清端口 → 拷插件 → 跑 mock 套件 → `race-check` → `queue-check` → `timeout-check` → `relogin-check`（无 python3 **判 FAIL**；只有显式 `ALLOW_PY_SKIP=1` 才允许跳过），逐段打印 PASS/FAIL 并汇总，任一段失败退出码 2
- `relogin-check.py`：**重登策略回归**（`python3 -I tests/relogin-check.py`）：起假 WebUI（`/api/auth/login`、`CheckLoginStatus`、`PasswordLogin`），用 `QQ_RELOGIN_MIN_INTERVAL=1`、`MAX_TRIES=2` 验证——在线不登录、掉线立即尝试、退避期内不重试、**成功后仍保留计数**（防内核不回来时反复登录撞风控）、到上限即停、恢复后清空、滑块/新设备即停且 CLI 退出码 2、被拒退出码 1、**状态文件损坏即停且不登录**（CLI 退出码 2）、原子写不留临时文件且 0600、WebUI 不可达时抛错；共 17 项断言输出 `RESULT=OK`
- `online-smoke.sh`：**线上只读 smoke**（在 VPS 上 `bash tests/online-smoke.sh`，需容器同机的 `/opt/qq-bot` 布局）：鉴权三路（回环 / mesh / 公网）、页面内容、groups/history/stats、**路由键基数（差值口径）**、dryRun 加群/退群/发消息、鉴权锁定 per-IP、内核队列水位、relogin 在线不登录、容器白名单/镜像/`JOINER_*` 注入。不打印任何 token；计数一律看前后差值（`/api/stats` 按实例累计）。注意：连跑时公网段可能因本机出口 IP 攒满鉴权失败而 429，属预期，等窗口过期（默认 10min）再测。**脱敏约定**：公开仓库不入真实 QQ/群号/内网与公网地址，相关小节的值从环境变量注入——`SMOKE_MESH`（mesh 地址，js 部分用它拼 `http://<M>:19001`，注意不带端口）、`SMOKE_PUB`（公网前缀，如 `https://…/joiner`）、`SMOKE_QQ_ID`（页面部署行检查）、`SMOKE_GROUP`（冒烟例群，dryRun/搜索/页面 placeholder 检查）；未注入就跳过该小节。
- `online-iter.py`：**线上深度迭代验证**（`python3 -I tests/online-iter.py`，同样只读 + dryRun）：补 smoke 未覆盖的语义分支——A 口令换 cookie 的 302/`Set-Cookie`、仅 cookie 放行、错误 cookie 不短路 header；B CSRF 只在 cookie 鉴权的 POST 校验 Origin（同源放行 / 跨站 403 / header 鉴权不受限）；C `x-forwarded-proto` 只在受信代理上采信（受信源带 https 头 → `Secure`）；D 24 并发 groups + 12 并发 search 的有界队列语义（结果必须落在 `{200,503,429}`——429 是脚本自身打满 search 限流配额的副作用，至少 2 个成功，排水后 `active/waiting/zombies` 归零）；E `latencyMs` 各路由 `p50≤p99≤max` 且数值有效；F 4s TTL 内重复 groups 不额外消耗 search 配额；G 响应头审计（200/401/404 都带 `no-store` 与安全头）；H 方法与状态矩阵（GET/POST/OPTIONS 错配 404、未知路径带/不带口令 404/401）；I 边界输入（9KB body 413、空 body 400、非法 group 校验文案不回显 payload）；J 内核错误语义（假群号不落 500：v1.6.5 起 502=上游没答案、404=确认搜不到，文案不外泄内核原文）；K stats 深度字段（`eventLoopDelayMs` 四元组、`rssMB`/`uptimeMs`/`cache`/`historyInMemory` 合理）；L 轻量 soak（混合负载后队列归零、无新增超时/僵尸，RSS 漂移只观测）。**脱敏约定**同 smoke：`SMOKE_BASE`（默认 `http://127.0.0.1:19001`）、`SMOKE_MESH`（受信代理源，未设则跳过 C）、`SMOKE_GROUP`（search 例群，缺省占位号）、`SMOKE_TOKEN_FILE`（默认容器内插件 `token` 路径）；不打印 token，成功输出 `RESULT=OK`。
