# napcat-plugin-joiner mock 测试

- 适用：v1.6.1（覆盖 1.2.1 的 cleanup 关端口 / 413 / 口令缓存，1.2.2 的并发闸门 / 超时 / listen 抛错 / 8KB 上限 / `/api/stats`，1.2.3 的直方图 `.enable()`，1.3.0 的口令换 cookie / CSRF / 爆破闸门，1.4.0 的同源 Origin / 加群去重 / rcOf 未知 / 缓存代际 / 落盘串行化，1.5.0 的有界内核队列 / 按实例统计，1.6.0 的路由级延迟 p50/p99 / `npm test` 单入口，1.6.1 的掉线检测触发重登）
- 原理：假内核（GroupApi/MsgApi/session）+ 真 `plugin_init` + 真 HTTP，**不连 QQ/NapCat**
- 宿主 VPS 无 node，须在任意有 node>=18 且 19001 空闲的机器复跑。**推荐一条命令**：

  ```bash
  npm test        # tests/run-all.mjs：自动拷最新插件到 /tmp/joiner-mock/plugin、清 19001、依次跑 mock + race + queue + relogin-check
  ```

  分段跑也行（调试时更直观）：
  1. 拉一份插件副本（避免污染线上数据）：`mkdir -p /tmp/j && cp napcat/plugins/napcat-plugin-joiner/{index.mjs,page.html,package.json} /tmp/j/`
  2. `JOINER_DIR=/tmp/j node --test --test-force-exit --test-timeout=30000 --test-reporter=spec mock.test.mjs`
  3. 若上一轮异常退出留下监听进程：`lsof -nP -iTCP:19001 -sTCP:LISTEN -t | xargs -r kill -9`（**必须先清**，否则新实例 listen 失败、请求全打到旧进程）
- 期望：**36 个用例全过**。历史回归锚点（跑旧版本时应当红的用例）：
  - v1.2.0：`超大 body 回 413`、`cleanup 释放端口可重复 init`
  - v1.2.1：`内核并发闸门（6 并发峰值 ≤2）`、`/api/stats 字段`、`listen 失败抛错`、`页面/口令 watch 热更新（8KB 上限）`
  - v1.2.2：`/api/stats` 的四个 eventLoopDelayMs 字段为 `null`（未 `.enable()`）
  - v1.2.3：`?token=` 直接回 200 HTML（v1.3.0 起是 302 + Set-Cookie）
  - v1.3.0：`同源 Origin（非白名单 Host）也必须放行` 会 403（白名单判据的 P1）、`加群去重：同一群并发点击只向 QQ 提交一次` 会提交 2 次、`内核没给 result 时必须是「未知」` 会假成功
  - v1.4.0：`内核队列有界` 会全 200（无限排队）、`重载后直方图窗口归零` 会继承上一实例的窗口
  - v1.5.0：`路由级延迟：/api/search 变慢体现在 p99` 的 `latencyMs` 为 `undefined`；`npm test` 不存在（要手动拷文件）
  - v1.6.0：`relogin.py` 成功登录后清空计数（内核迟迟不回时会每隔一次就再登一次，撞风控）；没有 `relogin-watch.py`，只有 5 分钟定时器
- 时序相关用例有 1.3–4.2s 的显式等待（口令/页面 watch 500ms 轮询、群列表 4s TTL），总时长约 25s，属正常
- `port-check.mjs`：单独验证 cleanup 关端口 + 同模块二次 init 复用端口
- `timer-old/new.mjs`：对照 withTimeout 定时器泄漏（旧 3003ms 才退出 vs 新 1ms）
- `queue-check.mjs`：**有界队列的独立取证脚本**（standalone，`JOINER_KERNEL_WAIT_MS=300` 注入）：2 个慢调用占满槽位后，第 3 个约 300ms 拿到 503「排队超时」，且慢调用结束后第 4 个仍能 200（槽位没泄漏）；输出 `RESULT=OK`、退出码 0
- `race-check.mjs`：**加群去重的独立取证脚本**（standalone，不进 `node --test`）：慢搜索 300ms 放大竞态，并发发 2 个 `/api/join`，打印 `reqToJoinGroup 实际调用次数`——去重生效时 **1**（退出码 0），未去重时 **2**（退出码 2）。用法：`node race-check.mjs`（源码目录默认取仓库相对路径，可用 `JOINER_SRC` 覆盖；自己拷进 `/tmp/joiner-mock/race-plugin/` 再跑）
- `run-all.mjs`：`npm test` 的实现——清端口 → 拷插件 → 跑 mock 套件 → `race-check` → `queue-check` → `relogin-check`（无 python3 则明示跳过），逐段打印 PASS/FAIL 并汇总，任一段失败退出码 2
- `relogin-check.py`：**重登策略回归**（`python3 -I tests/relogin-check.py`）：起假 WebUI（`/api/auth/login`、`CheckLoginStatus`、`PasswordLogin`），用 `QQ_RELOGIN_MIN_INTERVAL=1`、`MAX_TRIES=2` 验证——在线不登录、掉线立即尝试、退避期内不重试、**成功后仍保留计数**（防内核不回来时反复登录撞风控）、到上限即停、恢复后清空、滑块/新设备即停且 CLI 退出码 2、被拒退出码 1、WebUI 不可达时抛错；13 项断言输出 `RESULT=OK`
