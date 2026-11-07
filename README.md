# WebQQ

一套跑在 [NapCat](https://github.com/NapNeko/NapCatQQ) 之上的 **QQ 群操作台**：单页网页里完成「搜索群 / 申请加群 / 退群 / 看群列表 / 群内发消息」，后端就是一个常驻的 NapCat 插件。

项目由我们自己开发和维护：插件、页面、运维脚本、回归测试都在本仓库，**不含任何第三方源码**。NapCat 只是运行平台（第三方 Docker 镜像），OneBot v11 是它对外暴露的协议。

当前版本：**v1.6.4**

## 功能

**操作**
- 群号搜索：拿到群名、人数、加群方式（直接加入 / 需审核 / 需答题 / 禁止加入）
- 申请加群：支持 `dryRun` 预览；同群并发点击只提交一次
- 退群、群列表（4s TTL 缓存，退群后立即失效）
- 群内发消息：只能发给机器人已在的群，支持模板 `用户 ID：{ID}，申请体验额度`

**安全**
- 口令三种来源：首次 `?token=` → 种 `HttpOnly; SameSite=Lax` cookie（https 加 `Secure`，Path 收窄到插件前缀）→ 之后完全走 cookie，口令不再留在历史/书签/Referer；**高优先级来源错了不短路低优先级**（旧书签的过期 query token 不会压过有效 cookie/header），页面残留过期 token 会 302 到干净地址
- cookie 来源的 POST 做 **CSRF 同源校验**（`Origin.host === Host`，另可用 `JOINER_ALLOW_HOSTS` 追加反代域名）
- 同 IP **带错口令**失败 20 次 / 10 分钟 → 429 锁定（**锁定可过期**，成功即销账；完全不带口令的探测只回 401、不累计不锁 IP，运维/健康检查不会被自己锁死）
- 限流：加群 10 次/小时、发消息 20 次/小时，且只在会产生外部副作用的路径上消耗配额；群列表按属性共享 search 配额（命中缓存 / 已有在途请求不再计）
- 审计历史（内存环形 200 条 + 合并落盘，**写失败计数并限频告警**），页面可查 `/api/history`
- 响应头统一 `no-store / noindex / no-referrer / nosniff / X-Frame-Options: DENY`
- **路由统计键白名单**：未鉴权请求也会写 `/api/stats`，任意路径只归入有限键集，不会无限涨内存

**工程**
- 内核并发闸门：`GroupApi` / `MsgApi` 同时最多 2 个在跑（`JOINER_KERNEL_MAX` 可调），其余排队；**队列有界**——上限 8 个、单次排队最长 10s，满了/超时立刻 503；**单次调用也有超时**（搜索 15s / 加群·退群·发消息 20s，可注入覆盖），超时只回 503，**槽位随底层 promise settle 后释放**；内核调用既不返回也不报错（NTEvent 挂死）时，超过**僵尸硬上限**（默认 超时×5、且 ≥60s，`JOINER_KERNEL_ZOMBIE_MS` 可调）强制回收槽位 + 计数告警，插件自愈而不是永久 503；卸载时排队者被立刻取消，不会在已卸载的实例上继续打内核
- 群列表缓存带**代际**：在途请求回来时代际已变就不回填，避免退群后仍显示旧列表
- 历史落盘串行化（promise 链 + cleanup 先 await 再同步写），不会旧快照覆盖新快照
- `/api/stats`：**按实例统计**（插件热重载后自动归零，直方图 `reset()`，不再继承上一次的尖峰）；请求/路由/内核/缓存命中/**错误响应（≥400 统一计数）**/事件循环延迟与窗口/**路由级延迟 p50/p99/max**（每条路由保留最近 64 个样本）/RSS/去重计数/队列水位与拒绝次数/**超时、僵尸回收与历史写失败计数**/限流桶水位
- 加群去重 + **同群冷却**（提交成功或 pending 后 10 分钟不重复申请，退群即解除），`?token=`/`X-Joiner-Token` 失效来源之间正确回落
- `npm test` 单入口把全部回归打成一条命令：自动拷一份最新插件到临时目录、清端口占用，再依次跑 mock 套件 + `race-check` + `queue-check` + `timeout-check` + `relogin-check`，任何一段失败退出码非 0
- 页面与口令走 `fs.watchFile` 热更新（500ms），改文件即生效，无需重启容器

## 目录

```
compose.yml                     # NapCat 容器编排：只绑本机回环
compose.mesh.yml                # 可选覆盖：叠加发布到 mesh/内网网卡（MESH_IP）
.env.example                    # 需要自己填的配置
patch-whitelist.sh              # 把本插件加进 NapCat 官方插件白名单（重建容器后必跑）
login-status.py                 # 登录状态查看（复用 relogin 的鉴权逻辑）
relogin.py                      # 掉线账密重登（一次性 CLI，也可被看门狗调用）
relogin-watch.py                # 常驻看门狗：掉线检测触发重登（替代 5 分钟定时器）
show-qr.sh                      # 打印/导出登录二维码
sk-invite-accept.py             # 只接受指定一个群的邀请
napcat/plugins/
  napcat-plugin-joiner/         # ★ 群操作台：index.mjs + page.html（自研）
systemd/
  qq-relogin-watch.service    # 看门狗 unit（Type=simple + Restart=always）
tests/
  mock.test.mjs                 # 43 用例：假内核 + 真 HTTP，不连 QQ
  race-check.mjs                # 加群去重的独立取证脚本（JOINER_SRC 可指定源码）
  queue-check.mjs               # 有界内核队列的独立取证脚本（JOINER_SRC 可指定源码）
  timeout-check.mjs             # 内核超时不放槽的独立取证脚本
  relogin-check.py              # 重登策略回归：假 WebUI 验退避/上限/恢复/验证码/状态损坏
  online-smoke.sh               # 线上只读 smoke（VPS 上跑：鉴权/路由基数/dryRun/容器健康）
  online-iter.py                # 线上深度迭代验证（cookie/CSRF/代理头/并发/延迟/配额）
  run-all.mjs                   # npm test 入口：拷插件 + 五连跑
  port-check.mjs                # cleanup 关端口 / 二次 init
  README.md                     # 测试说明与历史回归锚点
```

## 快速开始

```bash
cp .env.example .env          # 填 WEBUI_TOKEN / QQ_ACCOUNT；本机用默认回环即可
docker compose up -d
bash patch-whitelist.sh && docker restart qq-napcat   # 白名单补丁不持久，重建容器后必须重跑
```

只在本机用就到此为止（compose.yml 只绑 127.0.0.1）。要走内网/mesh，叠加覆盖并填 `MESH_IP`：

```bash
# .env：MESH_IP=<本机 mesh 地址>（不能是 127.0.0.1）
docker compose -f compose.yml -f compose.mesh.yml up -d
```

插件挂载在 `napcat/plugins/napcat-plugin-joiner`，首次启动会生成随机口令 token：

```bash
cat napcat/plugins/napcat-plugin-joiner/token
```

浏览器打开 `http://<host>:19001/?token=<token>`：会 302 到不带口令的地址并种 cookie，之后直接用即可。公网经 cloudflared/反代时，记得把 `JOINER_TRUSTED_PROXIES` 配成隧道在容器里看到的源地址，否则 `cf-connecting-ip` 不会被信任，同 IP 限流会把真实的浏览器 IP 当成隧道 IP 合并计算。

## 掉线重登

NapCat 掉线后不会自己回到登录态。这里不用定时器盲目轮询，而是**常驻看门狗检测到掉线才动作**：

```bash
systemctl disable --now qq-relogin.timer      # 关掉旧的 5 分钟定时器
cp systemd/qq-relogin-watch.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now qq-relogin-watch
```

- `relogin-watch.py` 每 10s 读一次 `CheckLoginStatus`（本地 HTTP，<1ms；NapCat WebUI 自身也没有登录事件流），**只在登录态变化时打日志**；
- 检测到离线 → 调 `relogin.tick()`：距上次尝试 ≥30 分钟才发起、单轮最多 3 次、滑块/新设备验证立即停止等人工；
- 账密登录返回「成功」只代表请求被受理，**仍计一次尝试**并按 30 分钟退避——否则内核迟迟不回来时会被反复登录，直接撞风控；
- 恢复登录后状态自动清空，下一次掉线重新计数；WebUI/容器不可达时只记一行、不尝试登录。

## 配置

| 变量 | 作用 | 默认 |
|---|---|---|
| `WEBUI_TOKEN` | NapCat WebUI 令牌（**自己设，别用示例值**） | 必填 |
| `QQ_ACCOUNT` | 登录的 QQ 号 | 必填 |
| `MESH_IP` | `compose.mesh.yml` 里额外发布端口的网卡地址（**不能是 127.0.0.1**） | 空（不用 mesh） |
| `JOINER_ALLOW_HOSTS` | 同源之外额外允许的 Host，逗号分隔 | `qq.example.com` |
| `JOINER_TRUSTED_PROXIES` | 只有来自这些地址的请求才信任 `X-Forwarded-For` / `CF-Connecting-IP` | `127.0.0.1,::1` |
| `JOINER_KERNEL_MAX` | 内核并发上限 | `2` |
| `JOINER_KERNEL_QUEUE_MAX` | 内核排队上限（超过即 503） | `8` |
| `JOINER_KERNEL_WAIT_MS` | 单次排队最长等待（超时即 503） | `10000` |
| `JOINER_KERNEL_TIMEOUT_MS` | 单次内核调用超时（0 = 按调用类型默认 15s/20s） | `0` |
| `JOINER_KERNEL_ZOMBIE_MS` | 内核调用超时后仍不返回多久判定为僵尸并回收槽位（0 = 超时×5，且 ≥60000） | `0` |
| `JOINER_AUTH_FAIL_WINDOW_MS` | 鉴权失败锁定窗口（毫秒） | `600000` |
| `TARGET_GROUP` | `sk-invite-accept.py` 的目标群号 | 空（不动作） |
| `QQ_WATCH_INTERVAL` | 看门狗轮询登录态的间隔（秒） | `10` |
| `QQ_RELOGIN_MIN_INTERVAL` | 两次账密重登的最小间隔（秒） | `1800` |
| `QQ_RELOGIN_MAX_TRIES` | 单轮掉线最多尝试次数 | `3` |

运行期还会用到（由程序自己生成，**不入库**）：插件目录下的 `token`、`history.json`，以及 `/opt/qq-bot` 下的 `.webui_token`（0600）、`.webui_cred`（0600）、`.onebot_token`、`.qq_password`、`.relogin_state`（原子写 + 0600）。状态文件损坏时重登会**停手等人工**，不会盲目重登去撞风控。

## 测试

```bash
npm test                 # 一条命令：拷插件 + mock 43 用例 + race + queue + timeout + relogin

# 或分段跑（调试时更直观）：
JOINER_DIR=../napcat/plugins/napcat-plugin-joiner \
  node --test --test-force-exit --test-timeout=120000 --test-reporter=spec tests/mock.test.mjs
node tests/race-check.mjs
node tests/queue-check.mjs
node tests/timeout-check.mjs
python3 -I tests/relogin-check.py
```

43/43 全绿 + 竞态/排队/超时/重登四份取证，共 5 段，总时长约 35s。没有 `python3` 时重登那段会**判 FAIL**（不再静默跳过）；确实要临时跳过，用 `ALLOW_PY_SKIP=1 npm test`。回归锚点（旧版本应当红）见 `tests/README.md`。

上线后冒烟（在 VPS 上，只读 + dryRun，不打印 token）：`bash tests/online-smoke.sh`。仓库是公开的，真实 QQ/群号/内网与公网地址不入库——跑 VPS 前先注入：`SMOKE_MESH=<mesh 地址>`（受信代理闸门小节）、`SMOKE_PUB=<公网前缀>`（公网鉴权/路由小节）、`SMOKE_QQ_ID` / `SMOKE_GROUP`（可选，页面部署行与冒烟例群；不设则跳过对应检查）。

更深的线上语义验证用 `python3 -I tests/online-iter.py`：覆盖口令换 cookie、CSRF 同源、受信代理头、24+12 并发排水、路由延迟单调性与列表缓存配额共享，成功输出 `RESULT=OK`；同样从 `SMOKE_BASE` / `SMOKE_MESH` / `SMOKE_GROUP` / `SMOKE_TOKEN_FILE` 注入环境相关值。

## 上游与致谢

- **NapCat / NapCatQQ**：第三方 QQ 协议端，本项目只在它之上提供插件与运维工具，仓库内不包含其源码；容器镜像为 `mlikiowa/napcat-docker`。
- **OneBot v11**：插件与外部脚本之间的协议。

## License

MIT，见 [LICENSE](LICENSE)。
