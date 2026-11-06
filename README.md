# WebQQ

一套跑在 [NapCat](https://github.com/NapNeko/NapCatQQ) 之上的 **QQ 群操作台**：单页网页里完成「搜索群 / 申请加群 / 退群 / 看群列表 / 群内发消息」，后端就是一个常驻的 NapCat 插件。

项目由我们自己开发和维护：插件、页面、运维脚本、回归测试都在本仓库，**不含任何第三方源码**。NapCat 只是运行平台（第三方 Docker 镜像），OneBot v11 是它对外暴露的协议。

当前版本：**v1.6.0**

## 功能

**操作**
- 群号搜索：拿到群名、人数、加群方式（直接加入 / 需审核 / 需答题 / 禁止加入）
- 申请加群：支持 `dryRun` 预览；同群并发点击只提交一次
- 退群、群列表（4s TTL 缓存，退群后立即失效）
- 群内发消息：只能发给机器人已在的群，支持模板 `用户 ID：{ID}，申请体验额度`

**安全**
- 口令三种来源：首次 `?token=` → 种 `HttpOnly; SameSite=Lax` cookie（https 加 `Secure`，Path 收窄到插件前缀）→ 之后完全走 cookie，口令不再留在历史/书签/Referer
- cookie 来源的 POST 做 **CSRF 同源校验**（`Origin.host === Host`，另可用 `JOINER_ALLOW_HOSTS` 追加反代域名）
- 同 IP 鉴权失败 20 次 / 10 分钟 → 429 锁定（成功即销账）
- 限流：加群 10 次/小时、发消息 20 次/小时，且只在会产生外部副作用的路径上消耗配额
- 审计历史（内存环形 200 条 + 合并落盘），页面可查 `/api/history`
- 响应头统一 `no-store / noindex / no-referrer / nosniff / X-Frame-Options: DENY`

**工程**
- 内核并发闸门：`GroupApi` / `MsgApi` 同时最多 2 个在跑，其余排队；**队列有界**——上限 8 个、单次排队最长 10s，满了/超时立刻 503，不会堆成几分钟的积压（客户端早断了内核还在干活）
- 群列表缓存带**代际**：在途请求回来时代际已变就不回填，避免退群后仍显示旧列表
- 历史落盘串行化（promise 链 + cleanup 先 await 再同步写），不会旧快照覆盖新快照
- `/api/stats`：**按实例统计**（插件热重载后自动归零，直方图 `reset()`，不再继承上一次的尖峰）；请求/路由/内核/缓存命中/错误/事件循环延迟与窗口/**路由级延迟 p50/p99/max**（每条路由保留最近 64 个样本）/RSS/去重计数/队列水位与拒绝次数
- `npm test` 单入口把头五个回归打成一条命令：自动拷一份最新插件到临时目录、清端口占用，再依次跑 mock 套件 + `race-check` + `queue-check`，任何一段失败退出码非 0
- 页面与口令走 `fs.watchFile` 热更新（500ms），改文件即生效，无需重启容器

## 目录

```
compose.yml                     # NapCat 容器编排（端口、卷、日志轮转）
.env.example                    # 需要自己填的配置
patch-whitelist.sh              # 把本插件加进 NapCat 官方插件白名单（重建容器后必跑）
login-status.py / relogin.py    # 登录状态查看 / 掉线账密重登
show-qr.sh                      # 打印/导出登录二维码
sk-invite-accept.py             # 只接受指定一个群的邀请
napcat/plugins/
  napcat-plugin-joiner/         # ★ 群操作台：index.mjs + page.html（自研）
  sk-join-group/                # 一次性：主动申请加入指定群
tests/
  mock.test.mjs                 # 36 用例：假内核 + 真 HTTP，不连 QQ
  race-check.mjs                # 加群去重的独立取证脚本（JOINER_SRC 可指定源码）
  queue-check.mjs               # 有界内核队列的独立取证脚本（JOINER_SRC 可指定源码）
  run-all.mjs                   # npm test 入口：拷插件 + 三连跑
  port-check.mjs                # cleanup 关端口 / 二次 init
  timer-old.mjs / timer-new.mjs # withTimeout 定时器泄漏对照
  README.md                     # 测试说明与历史回归锚点
```

## 快速开始

```bash
cp .env.example .env          # 填 WEBUI_TOKEN / QQ_ACCOUNT / MESH_IP
docker compose up -d
bash patch-whitelist.sh && docker restart qq-napcat   # 白名单补丁不持久，重建容器后必须重跑

# 插件挂载在 napcat/plugins/napcat-plugin-joiner，首次启动会生成随机口令 token
cat napcat/plugins/napcat-plugin-joiner/token
```

浏览器打开 `http://<host>:19001/?token=<token>`：会 302 到不带口令的地址并种 cookie，之后直接用即可。

## 配置

| 变量 | 作用 | 默认 |
|---|---|---|
| `WEBUI_TOKEN` | NapCat WebUI 令牌（**自己设，别用示例值**） | 必填 |
| `QQ_ACCOUNT` | 登录的 QQ 号 | 必填 |
| `MESH_IP` | 端口发布到哪个地址（内网/mesh 入口） | `127.0.0.1` |
| `JOINER_ALLOW_HOSTS` | 同源之外额外允许的 Host，逗号分隔 | `qq.example.com` |
| `TARGET_GROUP` | `sk-join-group` / `sk-invite-accept.py` 的目标群号 | 空（不动作） |
| `JOINER_KERNEL_QUEUE_MAX` | 内核排队上限（超过即 503） | `8` |
| `JOINER_KERNEL_WAIT_MS` | 单次排队最长等待（超时即 503） | `10000` |

运行期还会用到（由程序自己生成，**不入库**）：插件目录下的 `token`、`history.json`，以及 `/opt/qq-bot` 下的 `.webui_token`、`.onebot_token`、`.qq_password`。

## 测试

```bash
npm test                 # 一条命令：拷插件 + mock 36 用例 + race-check + queue-check

# 或分段跑（调试时更直观）：
JOINER_DIR=../napcat/plugins/napcat-plugin-joiner \
  node --test --test-force-exit --test-timeout=30000 --test-reporter=spec tests/mock.test.mjs
node tests/race-check.mjs
node tests/queue-check.mjs
```

36/36 全绿，加上两个取证脚本共 3 段，总时长约 30s。回归锚点（旧版本应当红）见 `tests/README.md`。

## 上游与致谢

- **NapCat / NapCatQQ**：第三方 QQ 协议端，本项目只在它之上提供插件与运维工具，仓库内不包含其源码；容器镜像为 `mlikiowa/napcat-docker`。
- **OneBot v11**：插件与外部脚本之间的协议。

## License

MIT，见 [LICENSE](LICENSE)。
