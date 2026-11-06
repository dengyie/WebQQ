# napcat-plugin-joiner mock 测试

- 适用：v1.4.0（覆盖 1.2.1 的 cleanup 关端口 / 413 / 口令缓存，1.2.2 的并发闸门 / 超时 / listen 抛错 / 8KB 上限 / `/api/stats`，1.2.3 的直方图 `.enable()`，1.3.0 的口令换 cookie / CSRF / 爆破闸门，1.4.0 的同源 Origin / 加群去重 / rcOf 未知 / 缓存代际 / 落盘串行化）
- 原理：假内核（GroupApi/MsgApi/session）+ 真 `plugin_init` + 真 HTTP，**不连 QQ/NapCat**
- 宿主 VPS 无 node，须在任意有 node>=18 且 19001 空闲的机器复跑：
  1. 拉一份插件副本（避免污染线上数据）：`mkdir -p /tmp/j && cp /opt/qq-bot/napcat/plugins/napcat-plugin-joiner/{index.mjs,page.html} /tmp/j/`
  2. `JOINER_DIR=/tmp/j node --test --test-force-exit --test-timeout=30000 --test-reporter=spec mock.test.mjs`
  3. 若上一轮异常退出留下监听进程：`lsof -nP -iTCP:19001 -sTCP:LISTEN -t | xargs -r kill -9`（**必须先清**，否则新实例 listen 失败、请求全打到旧进程）
- 期望：**33 个用例全过**。历史回归锚点（跑旧版本时应当红的用例）：
  - v1.2.0：`超大 body 回 413`、`cleanup 释放端口可重复 init`
  - v1.2.1：`内核并发闸门（6 并发峰值 ≤2）`、`/api/stats 字段`、`listen 失败抛错`、`页面/口令 watch 热更新（8KB 上限）`
  - v1.2.2：`/api/stats` 的四个 eventLoopDelayMs 字段为 `null`（未 `.enable()`）
  - v1.2.3：`?token=` 直接回 200 HTML（v1.3.0 起是 302 + Set-Cookie）
  - v1.3.0：`同源 Origin（非白名单 Host）也必须放行` 会 403（白名单判据的 P1）、`加群去重：同一群并发点击只向 QQ 提交一次` 会提交 2 次、`内核没给 result 时必须是「未知」` 会假成功
- 时序相关用例有 1.3–4.2s 的显式等待（口令/页面 watch 500ms 轮询、群列表 4s TTL），总时长约 25s，属正常
- `port-check.mjs`：单独验证 cleanup 关端口 + 同模块二次 init 复用端口
- `timer-old/new.mjs`：对照 withTimeout 定时器泄漏（旧 3003ms 才退出 vs 新 1ms）
- `race-check.mjs`：**加群去重的独立取证脚本**（standalone，不进 `node --test`）：慢搜索 300ms 放大竞态，并发发 2 个 `/api/join`，打印 `reqToJoinGroup 实际调用次数`——去重生效时 **1**（退出码 0），未去重时 **2**（退出码 2）。用法：`node race-check.mjs`（它自己把 `/tmp/qq-joiner/` 拷进 `/tmp/joiner-mock/plugin/` 再跑）
