// napcat-plugin-joiner：在 NapCat 容器内起 HTTP 服务（0.0.0.0:19001），
// 提供「群搜索 / 申请加群 / 退群 / 群列表」页面与 API。
// 防呆原则：一律先 searchGroup 拿群设置再提交；groupOption 3 拒绝、4/5 必带答案；
// 口令鉴权 + 频率限制 + 历史留档；退群/加群支持 dryRun（不发真实请求）。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";

const HOST = "0.0.0.0";
const PORT = 19001;
const RATES = {
  search: { limit: 120, windowMs: 3600e3 },
  join: { limit: 10, windowMs: 3600e3 },
  leave: { limit: 10, windowMs: 3600e3 },
  send: { limit: 20, windowMs: 3600e3 },
};
const buckets = { search: [], join: [], leave: [], send: [] };

function now() { return new Date().toISOString(); }
function isDigits(s) { return /^\d{5,15}$/.test(String(s || "").trim()); }

// —— 环境变量解析 ——
// 裸 Number() + Math.max(x, NaN) 会返回 NaN，而 NaN 参与比较恒为 false：
// 鉴权窗口「永不过期」、队列上限「无界」、setTimeout(NaN) 变成 0ms 立即 503。
// 写错一个环境变量不该静默关掉安全阀，所以统一校验，启动时告警并回退默认值。
const ENV_WARNINGS = new Set();
function envInt(name, def, min) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return def;
  const s = String(raw).trim();
  const n = /^\d+(?:\.\d+)?$/.test(s) ? Number(s) : NaN;
  if (!Number.isFinite(n) || n < min) {
    ENV_WARNINGS.add(`${name}=${JSON.stringify(raw)} 非法（需要 ≥${min} 的数字），已回退默认值 ${def}`);
    return def;
  }
  return n;
}

function rcOf(res) {
  // 缺字段必须是「未知」(NaN) 而不是 0：0 在退群/加群里代表成功，
  // 内核没有给出 result 时把成功报出去等于假成功。
  const raw = res?.result ?? res?.errCode ?? NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

const JOIN_COOLDOWN_MS = 600e3; // 10 分钟：result=0/1（已提交/待审核）内不重复提交
const lastJoin = new Map();

// —— 口令换 cookie（v1.3.0）——
// 口令放 URL 会留在浏览器历史/书签/Referer 里。首次带 ?token= 打开页面时校验通过即种
// HttpOnly cookie 并 302 到干净地址，之后页面/接口都用 cookie 鉴权。
// Path=/joiner：页面与接口一律在 /joiner/ 前缀下（302 目标也是 /joiner/），所以够用；
// 同时不会把口令 cookie 带进同源的 NapCat WebUI 请求里。
const COOKIE_NAME = "joiner_token";
const COOKIE_MAX_AGE = 30 * 24 * 3600;
const AUTH_FAIL_LIMIT = 20;
const AUTH_FAIL_WINDOW_MS = envInt("JOINER_AUTH_FAIL_WINDOW_MS", 600e3, 1000);
const authFails = new Map(); // ip -> { n, at }
let authPruneAt = 0;

// 只有受信反代（Cloudflare tunnel / 本机）才允许用转发头改写来源 IP。
// 否则 mesh 内任何一台机器都能伪造 cf-connecting-ip，把别人的 IP 锁掉。
// 生产用 JOINER_TRUSTED_PROXIES=<mesh 地址>；默认只信任 loopback。
const TRUSTED_PROXIES = new Set(
  (process.env.JOINER_TRUSTED_PROXIES || "127.0.0.1,::1")
    .split(",").map((x) => x.trim()).filter(Boolean),
);
function isTrustedPeer(addr) {
  const a = String(addr || "").replace(/^::ffff:/, "");
  return !!a && TRUSTED_PROXIES.has(a);
}
function clientIp(req) {
  const peer = req.socket?.remoteAddress || "";
  if (isTrustedPeer(peer)) {
    const cf = req.headers["cf-connecting-ip"];
    if (cf) return String(cf).trim();
    const xf = req.headers["x-forwarded-for"];
    if (xf) return String(xf).split(",")[0].trim();
  }
  return peer || "unknown";
}

// 路由统计的键必须有限：未鉴权请求也会写 STATS.routes/latency，
// 旧实现直接拿 pathname 当键，随机路径能把内存撑爆（容器与 NapCat 共享 1200m）。
const ROUTE_KEYS = new Set([
  "/api/search", "/api/join", "/api/leave", "/api/send",
  "/api/groups", "/api/history", "/api/stats",
]);
function routeKeyOf(p) {
  if (ROUTE_KEYS.has(p)) return p;
  if (p.startsWith("/api/")) return "/api/other";
  if (p === "/" || p.endsWith(".html")) return "/";
  return "other";
}

function cookieGet(header, name) {
  if (!header) return "";
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ""; }
  }
  return "";
}

function authBlocked(ip, t = Date.now()) {
  const r = authFails.get(ip);
  if (!r) return false;
  // 旧实现漏传 t：NaN 比较恒为 false，窗口形同虚设，锁定 10 分钟后仍不解封
  if (t - r.at > AUTH_FAIL_WINDOW_MS) { authFails.delete(ip); return false; }
  return r.n >= AUTH_FAIL_LIMIT;
}

function pruneAuthFails(t) {
  if (t - authPruneAt < 60e3) return;
  authPruneAt = t;
  for (const [k, v] of authFails) if (t - v.at > AUTH_FAIL_WINDOW_MS) authFails.delete(k);
}

function noteAuthFail(ip, t) {
  pruneAuthFails(t);
  const r = authFails.get(ip);
  if (!r || t - r.at > AUTH_FAIL_WINDOW_MS) authFails.set(ip, { n: 1, at: t });
  else { r.n += 1; r.at = t; }
  if (authFails.size > 500) { // 上限保护：先删最早的 50 条
    let i = 0;
    for (const k of authFails.keys()) { authFails.delete(k); if (++i >= 50) break; }
  }
}

// —— 历史记录：内存环形缓冲（上限 200）+ 800ms 合并异步落盘 ——
// 旧实现每条记录都同步「读全文件 → 全量重写」，在 NapCat 主线程上做阻塞 I/O；
// 现在只写内存，落盘合并成一次 fs.promises.writeFile，退出时 plugin_cleanup 兜底。
const HISTORY_KEEP = 200;
let SRV = null;
let STOP_WATCHES = [];
let LOGGER = null;
let cancelKernelWaiters = null;
const STATS = { startedAt: Date.now(), requests: 0, routes: {}, kernel: {}, kernelTimeouts: 0, kernelZombies: 0, groupsHit: 0, groupsMiss: 0, errors: 0, authFailures: 0, joinDedup: 0, historyWriteFailures: 0 };
const eventLoopHist = monitorEventLoopDelay({ resolution: 20 });
let histSince = 0; // 本实例直方图的起点（reset 时刻），用于 /api/stats 说明统计窗口
let PLUGIN_DIR = "";
let hbuf = null;      // null = 尚未从磁盘载入
let hTimer = null;
let hDirty = false;
let hWriting = null;  // 在途异步写：保证写盘顺序，cleanup 前要等它落地
let hFailLoggedAt = 0;

function historyFile() { return path.join(PLUGIN_DIR, "history.json"); }

function hload() {
  if (hbuf) return hbuf;
  try {
    const raw = fs.readFileSync(historyFile(), "utf8");
    hbuf = raw.split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean).slice(-HISTORY_KEEP);
  } catch { hbuf = []; }
  return hbuf;
}

function noteHistoryWriteFailure(e) {
  STATS.historyWriteFailures++;
  const t = Date.now();
  if (t - hFailLoggedAt < 60e3) return;
  hFailLoggedAt = t;
  try { LOGGER?.logError?.("joiner: history write failed", e); } catch {}
}

function hflush(sync) {
  // 同步 flush（cleanup）时也不能留下已排定的合并定时器：它会在实例卸载后再写一次盘。
  if (hTimer) { clearTimeout(hTimer); hTimer = null; }
  if (!hDirty || !hbuf) return;
  hDirty = false;
  const text = hbuf.map((x) => JSON.stringify(x)).join("\n") + (hbuf.length ? "\n" : "");
  if (sync) {
    try { fs.writeFileSync(historyFile(), text, { mode: 0o600 }); } catch (e) { noteHistoryWriteFailure(e); }
    return;
  }
  // 串行化：并发/乱序的 writeFile 会让旧快照覆盖新快照（丢最后几条审计记录）
  hWriting = (hWriting || Promise.resolve())
    .then(() => fs.promises.writeFile(historyFile(), text, { mode: 0o600 }))
    .catch((e) => noteHistoryWriteFailure(e));
}

function recordHistory(action, group, groupName, result, extra) {
  try {
    const buf = hload();
    let r = result;
    try {
      const str = typeof result === "string" ? result : JSON.stringify(result);
      if (str && str.length > 400) r = str.slice(0, 400) + "…";
    } catch {}
    buf.push({ ts: now(), action, group, groupName, result: r, ...extra });
    if (buf.length > HISTORY_KEEP) buf.splice(0, buf.length - HISTORY_KEEP);
    hDirty = true;
    if (!hTimer) {
      hTimer = setTimeout(hflush, 800);
      if (typeof hTimer.unref === "function") hTimer.unref();
    }
  } catch {}
}

export async function plugin_init(ctx) {
  const pluginPath = ctx.pluginPath || process.cwd();
  PLUGIN_DIR = pluginPath;
  LOGGER = ctx.logger || null;

  // 口令文件：不存在则生成（0600）；读取按 mtime 缓存，替换文件即热轮换
  const tokenFile = path.join(pluginPath, "token");
  try {
    if (!fs.existsSync(tokenFile)) {
      fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString("hex"), { mode: 0o600 });
      ctx.logger.info("joiner: generated token file");
    }
  } catch (e) { ctx.logger.logError("joiner: token file init failed:", e); }

  const pageHtml = path.join(pluginPath, "page.html");

  // 页面与口令常驻内存，用 fs.watchFile 异步失效（替换文件仍热生效）。
  // 这样 HTTP 热路径上不再有 statSync / readFileSync——旧版每请求 1~2 次同步 syscall。
  let pageHtmlText = "";
  let tokenValue = "";
  function loadPage() {
    try { pageHtmlText = fs.readFileSync(pageHtml, "utf8"); } catch { pageHtmlText = ""; }
  }
  function loadToken() {
    // 读到空/失败时保留上一次有效口令：轮换文件（truncate 后写入）的瞬间或误删文件
    // 不能把内存口令击穿成 ""，否则所有请求立刻 401，还会白耗鉴权失败次数。
    // 吊销口令的方式是写入新值，而不是删文件。
    try {
      const s = String(fs.readFileSync(tokenFile, "utf8")).trim();
      if (s) tokenValue = s;
    } catch {}
  }
  loadPage();
  loadToken();

  // 统计口径 = 当前实例：热重载后 requests/kernel/uptime 一起归零。
  // （限流 buckets 与鉴权失败表故意不重置——重载不该成为绕过限流或解锁 IP 的手段。）
  Object.assign(STATS, {
    startedAt: Date.now(), requests: 0, routes: {}, kernel: {}, kernelTimeouts: 0, kernelZombies: 0,
    groupsHit: 0, groupsMiss: 0, errors: 0, authFailures: 0, joinDedup: 0, historyWriteFailures: 0,
  });
  hFailLoggedAt = 0;
  // 历史缓冲也是「本实例」的状态：不清的话，上一实例遗留的未落盘记录
  // 会被带进新实例，且 hload() 可能返回旧快照。
  if (hTimer) { clearTimeout(hTimer); hTimer = null; }
  hbuf = null;
  hDirty = false;
  for (const m of ENV_WARNINGS) ctx.logger.logError("joiner: " + m);

  // 事件循环延迟直方图：不开 enable 的话读出来是空值（NaN→null），指标等于没有。
  // reset()：插件热重载后清掉上一实例的样本——否则 /api/stats 的 max 会一直带着上次的尖峰，
  // 让人误以为当前实例有问题。
  eventLoopHist.reset();
  eventLoopHist.enable();
  histSince = Date.now();

  STOP_WATCHES = [];
  function watchReload(file, reload, label) {
    try {
      fs.watchFile(file, { interval: 500, persistent: false }, (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
          reload();
          ctx.logger.info(`joiner: ${label} reloaded`);
        }
      });
      STOP_WATCHES.push(() => fs.unwatchFile(file));
    } catch (e) { ctx.logger.logError(`joiner: watch ${label} failed`, e); }
  }
  watchReload(pageHtml, loadPage, "page");
  watchReload(tokenFile, loadToken, "token");

  function readPageHtml() { return pageHtmlText; }
  function readToken() { return tokenValue; }
  function tokenEqual(got) {
    const want = readToken();
    if (!want || !got) return false;
    const a = crypto.createHash("sha256").update(String(got)).digest();
    const b = crypto.createHash("sha256").update(want).digest();
    return crypto.timingSafeEqual(a, b);
  }
  // 三个来源按优先级：?token=（首次进入）→ X-Joiner-Token（脚本）→ cookie（浏览器后续请求）
  // 注意：高优先级来源错了不能短路低优先级——旧书签里的旧 query token 不该压过有效 cookie。
  function authOf(req, url) {
    const q = url.searchParams.get("token") || "";
    const h = req.headers["x-joiner-token"] || "";
    const c = cookieGet(req.headers.cookie, COOKIE_NAME);
    if (q && tokenEqual(q)) return { ok: true, source: "query", badQuery: false };
    if (h && tokenEqual(h)) return { ok: true, source: "header", badQuery: !!q };
    if (c && tokenEqual(c)) return { ok: true, source: "cookie", badQuery: !!q };
    return { ok: false, source: q ? "query" : (h ? "header" : (c ? "cookie" : "none")), badQuery: !!q };
  }
  function cookieAttrs(req) {
    // x-forwarded-proto 只在受信反代后面才可信：否则直连的客户端可以自报 https，
    // 拿到一个 Secure cookie（随后在 http 上不再发送，只坑自己，但没有理由接受这种输入）。
    const proto = isTrustedPeer(req.socket?.remoteAddress)
      ? String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim()
      : "";
    const secure = proto === "https" || !!req.socket?.encrypted;
    return "HttpOnly; Path=/joiner; SameSite=Lax; Max-Age=" + COOKIE_MAX_AGE + (secure ? "; Secure" : "");
  }
  // cookie 鉴权引入后 POST 有 CSRF 面：浏览器跨站 POST 一定带 Origin，非浏览器（curl）不带。
  // 判据是「同源」而不是「域名白名单」——白名单曾经把 mesh 直连（http://<mesh-ip>:19001）
  // 的加群/退群/发消息全部 403，而它正是隧道抖动时的备用入口。
  // 同源比较是安全的：Host 由客户端连的目标决定，跨站攻击者无法让 Origin 等于它。
  // 额外允许的反代域名（同源之外的兜底）；用 JOINER_ALLOW_HOSTS='a.example.com,b.example.com' 注入
  const ALLOW_HOSTS = new Set(
    (process.env.JOINER_ALLOW_HOSTS || "qq.example.com").split(",").map((x) => x.trim()).filter(Boolean),
  );
  function originAllowed(req) {
    const o = req.headers.origin || "";
    if (!o) return true;
    let u;
    try { u = new URL(o); } catch { return false; }
    return u.host === String(req.headers.host || "") || ALLOW_HOSTS.has(u.host);
  }

  function rate(action) {
    const cfg = RATES[action]; if (!cfg) return true;
    const arr = buckets[action]; const t = Date.now();
    let drop = 0;
    while (drop < arr.length && t - arr[drop] > cfg.windowMs) drop++;
    if (drop) arr.splice(0, drop);
    if (arr.length >= cfg.limit) return false;
    arr.push(t); return true;
  }


  // 内核并发闸门：search/join/leave/send 都压 NapCat 主线程的 NTEvent，
  // 小时级限流管不住「同时几个」。这里最多 2 个并发，其余排队。
  //
  // v1.5.0 把「无界排队」改成有界：
  //   - 队列上限 8：满了直接 503，不堆栈——否则几十个请求会排成几分钟的积压，
  //     客户端早就断了，内核还在为没人要的结果干活；
  //   - 排队上限 10s：到点丢出队列并 503，绝不占着槽位；
  //   - 队列里的等待者可以被后续的 handoff 跳过（已超时/已取消），不会占着坑。
  // 路由延迟：每条路由保留最近 64 个样本，/api/stats 里算 p50/p99/max。
  // 只用一个短环形数组——排查「慢在哪条路由」够用，且不引第三方直方图依赖。
  const LAT_SAMPLES = 64;
  const latency = Object.create(null); // routeKey -> { n, samples: [] }
  function pct(sorted, q) {
    if (!sorted.length) return null;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
    return +sorted[i].toFixed(2);
  }

  const KERNEL_MAX = envInt("JOINER_KERNEL_MAX", 2, 1);
  const KERNEL_QUEUE_MAX = envInt("JOINER_KERNEL_QUEUE_MAX", 8, 1);
  const KERNEL_WAIT_MS = envInt("JOINER_KERNEL_WAIT_MS", 10000, 50);
  const KERNEL_TIMEOUT_OVERRIDE = envInt("JOINER_KERNEL_TIMEOUT_MS", 0, 0);
  // 僵尸槽位的硬上限：内核调用既不 resolve 也不 reject 时（NTEvent 挂死），
  // 「槽位只在底层 settle 后释放」会让 2 个槽位被永久占死、插件内核 API 一直 503。
  // 超时后再等这么久仍不 settle，就判定为僵尸、强制回收并计数告警（自愈）。
  // 0 = 按单次超时的 5 倍，且不少于 60s。
  const KERNEL_ZOMBIE_MS = envInt("JOINER_KERNEL_ZOMBIE_MS", 0, 0);
  const kernelTimeoutMs = (def) => KERNEL_TIMEOUT_OVERRIDE || def;
  const kernelZombieMs = (timeoutMs) => KERNEL_ZOMBIE_MS || Math.max(60000, timeoutMs * 5);
  let kernelActive = 0;
  let closing = false;
  let kernelQueueRejected = 0; // 队列满直接拒
  let kernelQueueTimeout = 0;  // 排队等到超时
  const kernelWaiters = []; // { grant, reject, timer, cancelled }
  const kernelZombies = new Set(); // { timer, release }：已超时但仍未 settle 的调用

  function kernelBusy(msg, extra) {
    const e = new Error(msg);
    e.statusCode = 503;
    e.busy = true;
    return Object.assign(e, extra || {});
  }

  // 交出槽位：有活着的等待者就「转交」（active 不变，槽位没消失），
  // 没人接手才真正释放（active--）。写反了会让 active 变负、闸门形同虚设——
  // 这也是 v1.5.0 第一版被 12 并发用例逮到的地方。
  function kernelHandoff() {
    while (kernelWaiters.length) {
      const w = kernelWaiters.shift();
      if (w.cancelled) continue;
      w.cancelled = true;
      if (w.timer) { clearTimeout(w.timer); w.timer = null; }
      w.grant();
      return;
    }
    kernelActive--;
  }

  async function kernelAcquire() {
    if (closing) throw kernelBusy("插件正在卸载，请稍后重试", { closing: true });
    if (kernelActive < KERNEL_MAX) { kernelActive++; return; }
    if (kernelWaiters.length >= KERNEL_QUEUE_MAX) {
      kernelQueueRejected++;
      throw kernelBusy("内核繁忙（排队已满），请稍后重试", { queueFull: true });
    }
    await new Promise((resolve, reject) => {
      const w = {
        cancelled: false,
        timer: null,
        grant: () => resolve(),
        reject,
      };
      w.timer = setTimeout(() => {
        if (w.cancelled) return;
        w.cancelled = true;
        const i = kernelWaiters.indexOf(w);
        if (i >= 0) kernelWaiters.splice(i, 1);
        kernelQueueTimeout++;
        reject(kernelBusy("内核排队超时，请稍后重试", { queueTimeout: true }));
      }, KERNEL_WAIT_MS);
      if (typeof w.timer.unref === "function") w.timer.unref();
      kernelWaiters.push(w);
    });
  }

  // cleanup 时把还在排队的请求全部拒掉：旧实现只关 server，队列里的 join/leave/send
  // 仍可能在插件卸载后拿到槽位并执行，向已经关闭的响应写数据。
  cancelKernelWaiters = () => {
    closing = true;
    for (const w of kernelWaiters.splice(0)) {
      if (w.cancelled) continue;
      w.cancelled = true;
      if (w.timer) { clearTimeout(w.timer); w.timer = null; }
      try { w.reject(kernelBusy("插件正在卸载，请稍后重试", { closing: true })); } catch {}
    }
    for (const z of kernelZombies) { clearTimeout(z.timer); z.timer = null; }
    kernelZombies.clear();
  };

  async function kernelCall(label, fn, timeoutMs, timeoutLabel) {
    await kernelAcquire(); // 超时/队列满都在这里抛 503，未拿到槽位就不会进 try
    // 槽位可能在排队期间被 cleanup 取消；拿到后要再确认一次，避免卸载后启动新调用。
    if (closing) { kernelHandoff(); throw kernelBusy("插件正在卸载，请稍后重试", { closing: true }); }
    STATS.kernel[label] = (STATS.kernel[label] || 0) + 1;
    let timer = null;
    let zombie = null; // 超时之后才存在的僵尸回收器
    // 槽位释放必须幂等：正常 settle 与僵尸回收都会走到这里，只能执行一次。
    let released = false;
    const release = () => { if (released) return; released = true; kernelHandoff(); };
    const disarmZombie = () => {
      if (!zombie) return;
      clearTimeout(zombie.timer);
      kernelZombies.delete(zombie);
      zombie = null;
    };
    const work = Promise.resolve().then(fn); // 底层内核 promise（不是超时包装）
    // 关键不变量：槽位只在底层 settle 后释放。超时只让 HTTP 先回 503，
    // 不能把仍在跑的内核调用当成已结束——否则「最多 2 个并发」失效。
    work.then(() => { disarmZombie(); release(); }, () => { disarmZombie(); release(); });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        STATS.kernelTimeouts++;
        // 但「永远不 settle」的调用（NTEvent 挂死）会永久占死槽位，实测 2 个之后
        // 插件所有内核 API 一直 503 到手动重载。所以再等一个硬上限，到期判定为僵尸、
        // 强制回收并计数——最坏情况是有界（约 1~2 分钟）的降级，而不是永久不可用。
        const ms = kernelZombieMs(timeoutMs);
        zombie = {
          timer: setTimeout(() => {
            kernelZombies.delete(zombie);
            zombie = null;
            STATS.kernelZombies++;
            try {
              LOGGER?.logError?.(`joiner: 内核调用 ${label} 超时后又 ${ms}ms 未返回，判定为僵尸并回收槽位`);
            } catch {}
            release();
          }, ms),
        };
        if (typeof zombie.timer.unref === "function") zombie.timer.unref();
        kernelZombies.add(zombie);
        reject(kernelBusy((timeoutLabel || label) + " 超时(" + timeoutMs + "ms)，请稍后重试", { kernelTimeout: true }));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) { clearTimeout(timer); timer = null; }
    }
  }

  async function doSearch(keyword) {
    const groupApi = ctx.core?.apis?.GroupApi;
    if (!groupApi || typeof groupApi.searchGroup !== "function") throw new Error("GroupApi.searchGroup unavailable");
    let searched;
    try {
      searched = await kernelCall("searchGroup", () => groupApi.searchGroup(String(keyword).trim()), kernelTimeoutMs(15000), "searchGroup");
    } catch (e) {
      // 配置/能力问题要原样上抛（500），容量/自身超时要保留 503，其余内核错误翻成友好文案：
      // 内核没给出可用答案是上游问题（502），不是插件缺陷，不该混进 500 的「插件 bug」信号里
      if (e?.busy || /unavailable/i.test(String(e?.message || ""))) throw e;
      const friendly = new Error("群号不存在或搜索超时，请稍后重试");
      friendly.statusCode = 502;
      throw friendly;
    }
    const info = [searched?.searchGroupInfo, searched?.data?.searchGroupInfo, searched?.data, searched]
      .find((x) => x && typeof x === "object" && (x.groupCode != null || x.group_id != null)
        && String(x.groupCode ?? x.group_id) === String(keyword).trim()) || null;
    if (!info) return null;
    return {
      groupCode: String(info.groupCode ?? info.group_id),
      groupName: String(info.groupName ?? info.group_name ?? info.groupCode),
      groupOption: Number(info.groupOption ?? -1),
      question: String(info.groupQuestion ?? info.question ?? "").trim(),
      auth: String(info.joinGroupAuth ?? info.auth ?? ""),
    };
  }

  // 群列表缓存：页面轮询（0s/8s/20s）与发送前的成员校验会反复打内核，
  // 4s 内复用同一份结果，并发请求共享同一个 in-flight Promise。
  const GROUPS_TTL_MS = 4000;
  let groupsCache = { at: 0, data: null };
  let groupsInflight = null;
  let groupsGen = 0; // 失效代际：在途请求回来后若代际已变，就不许回填缓存

  function groupsFresh() { return !!groupsCache.data && Date.now() - groupsCache.at < GROUPS_TTL_MS; }
  function invalidateGroups() { groupsGen++; groupsCache = { at: 0, data: null }; }

  async function doListGroups() {
    if (groupsFresh()) return groupsCache.data;
    if (groupsInflight) return groupsInflight;
    groupsInflight = (async () => {
      const gen = groupsGen;
      const groupApi = ctx.core?.apis?.GroupApi;
      if (!groupApi || typeof groupApi.getGroups !== "function") throw new Error("GroupApi.getGroups unavailable");
      const raw = await kernelCall("getGroups", () => groupApi.getGroups(false), kernelTimeoutMs(15000), "getGroups");
      const src = [raw?.groupList, raw?.groups, raw?.result?.groupList, Array.isArray(raw) ? raw : null].find(Array.isArray) || [];
      const data = src.map((g) => ({
        group_id: String(g.groupCode ?? g.groupId ?? g.group_id ?? ""),
        group_name: String(g.groupName ?? g.group_name ?? ""),
        member_count: Number(g.memberCount ?? g.member_count ?? null),
        max_member_count: Number(g.maxMemberCount ?? g.max_member_count ?? null),
      })).filter((g) => g.group_id);
      if (gen === groupsGen) groupsCache = { at: Date.now(), data };
      return data;
    })();
    try { return await groupsInflight; } finally { groupsInflight = null; }
  }

  // 同一群的并发请求共用一次提交：双击/双标签页不会向 QQ 发两份申请。
  // dryRun 不进闸门（只做预览、不进内核）；不同群互不影响。
  const joinInflight = new Map();
  async function doJoin(group, answer, dryRun) {
    const key = String(group);
    if (dryRun) return doJoinOnce(key, answer, true);
    const running = joinInflight.get(key);
    if (running) { STATS.joinDedup++; return running; }
    const p = doJoinOnce(key, answer, false);
    joinInflight.set(key, p);
    try { return await p; } finally { joinInflight.delete(key); }
  }

  async function doJoinOnce(group, answer, dryRun) {
    const session = ctx.core?.context?.session;
    if (!session) throw new Error("core session unavailable");
    const gs = session.getGroupService();
    if (!gs || typeof gs.reqToJoinGroup !== "function") throw new Error("GroupService.reqToJoinGroup unavailable");

    // 已在群：不重复提交
    const groups = await doListGroups();
    if (groups.some((g) => g.group_id === String(group))) {
      return { status: "joined", code: 0, message: "机器人已在该群", groupInfo: null, nativeResult: null, arity: 0 };
    }

    // 冷却去重：最近一次 result=0/1（已提交/待审核）且未过 10 分钟 → 直接回原状态，不重复发申请
    const prev = lastJoin.get(String(group));
    if (prev && Date.now() - prev.ts < JOIN_COOLDOWN_MS && (prev.code === 0 || prev.code === 1)) {
      const status = prev.status || (prev.code === 1 ? "pending" : "submitted");
      return {
        status,
        code: prev.code,
        message: prev.code === 1
          ? "申请已提交，等待管理员审核（冷却期内不重复提交）"
          : "加群申请已提交（冷却期内不重复提交）",
        groupInfo: prev.groupInfo || null,
        nativeResult: null,
        cached: true,
        cooldownMs: JOIN_COOLDOWN_MS - (Date.now() - prev.ts),
      };
    }

    const info = await doSearch(group);
    if (!info) { const e = new Error("搜不到该群(可能不存在或被限制)"); e.statusCode = 404; throw e; }
    if (info.groupOption === 3) { const e = new Error("该群设置了禁止任何人加入"); e.statusCode = 422; throw e; }
    if ((info.groupOption === 4 || info.groupOption === 5) && !answer.trim()) {
      const err = new Error("该群需要回答验证问题才能申请");
      err.answerRequired = true; err.question = info.question; err.groupInfo = info;
      throw err;
    }

    const req = {
      groupCode: Number(group),
      sourceId: 3,
      sourceSubId: 0,
      applyMsg: answer.trim() || "",
      auth: info.auth,
      token: "",
      noVerifyAuth: "",
    };
    if (dryRun) return { dryRun: true, wouldSend: req, groupInfo: info };
    // 限流放在所有「不产生外部副作用」的判断之后：点错群、点已在群、重复点都不吃 10/h 配额
    if (!rate("join")) { const err = new Error("加群请求过于频繁（10 次/小时），请稍后再试"); err.statusCode = 429; throw err; }

    const arity = gs.reqToJoinGroup.length ?? -1;
    const result = await kernelCall("reqToJoinGroup", () => (arity >= 2
      ? gs.reqToJoinGroup(String(group), req)
      : gs.reqToJoinGroup(req)), kernelTimeoutMs(20000), "reqToJoinGroup");

    const rc = rcOf(result);
    lastJoin.set(String(group), { ts: Date.now(), code: rc, status: rc === 1 ? "pending" : (rc === 0 ? "submitted" : "failed"), groupInfo: info });
    for (const [k, v] of lastJoin) if (Date.now() - v.ts > JOIN_COOLDOWN_MS) lastJoin.delete(k);

    if (Number.isNaN(rc)) throw new Error("加群返回无法识别，请稍后重试");
    if (rc !== 0) {
      recordHistory("join", String(group), info.groupName, { result: rc, errMsg: result?.errMsg || "" }, { groupOption: info.groupOption });
      if (rc === 1) return { status: "pending", code: 1, message: "申请已提交，等待管理员审核（过一会儿刷新群列表看是否通过）", groupInfo: info, nativeResult: result, arity };
      const WHY = { 2: "需要回答问题或验证信息", 3: "申请过于频繁，请稍后再试", 4: "已在群或申请重复", 5: "群不存在" };
      const err = new Error("加群失败：result=" + rc + (WHY[rc] ? "（" + WHY[rc] + "）" : "") + (result?.errMsg ? " " + result.errMsg : ""));
      err.statusCode = 422;
      throw err;
    }

    recordHistory("join", String(group), info.groupName, { result: rc, errMsg: "" }, { groupOption: info.groupOption });
    invalidateGroups(); // rc=0 视为加群成功：群列表的旧快照不再可信
    return { status: "submitted", code: 0, message: "加群申请已提交（部分群需管理员审核后入群）", groupInfo: info, nativeResult: result, arity };
  }

  async function doLeave(group, dryRun) {
    const session = ctx.core?.context?.session;
    if (!session) throw new Error("core session unavailable");
    const gs = session.getGroupService();
    if (!gs) throw new Error("GroupService unavailable");
    if (dryRun) return { dryRun: true, wouldLeave: String(group) };
    let result;
    if (typeof gs.quitGroup === "function") {
      result = await kernelCall("quitGroup", () => gs.quitGroup(String(group)), kernelTimeoutMs(20000), "quitGroup");
    } else {
      const groupApi = ctx.core?.apis?.GroupApi;
      if (!groupApi || typeof groupApi.quitGroup !== "function") throw new Error("quitGroup unavailable");
      // 兜底分支同样要超时：旧实现漏了 withTimeout，内核不 settle 会永久占槽
      result = await kernelCall("quitGroup", () => groupApi.quitGroup(String(group)), kernelTimeoutMs(20000), "quitGroup");
    }
    const lr = rcOf(result);
    if (lr !== 0) {
      const msg = String(result?.errMsg || "");
      recordHistory("leave", String(group), "", { result: Number.isNaN(lr) ? "unknown" : lr, errMsg: msg }, { ok: false });
      throw new Error("退群失败：" + (Number.isNaN(lr) ? "未知返回" : "result=" + lr) + (msg ? " " + msg : ""));
    }
    lastJoin.delete(String(group)); // 退群后允许重新申请，不被上次的加群冷却挡住
    recordHistory("leave", String(group), "", { result: 0, errMsg: "" }, { ok: true });
    invalidateGroups();
    return { status: "left", code: 0, message: "已退出该群", nativeResult: result };
  }

  async function doSend(group, userId, customText, dryRun) {
    const groups = await doListGroups();
    const g = groups.find((x) => x.group_id === String(group));
    if (!g) { const e = new Error("机器人不在这个群，无法发送（请先从群列表确认）"); e.statusCode = 404; throw e; }
    const text = customText || ("用户 ID：" + userId + "，申请体验额度");
    if (text.length > 500) { const e = new Error("消息过长（>500 字符）"); e.statusCode = 400; throw e; }
    const msgApi = ctx.core?.apis?.MsgApi;
    if (!msgApi || typeof msgApi.sendMsg !== "function") throw new Error("MsgApi.sendMsg unavailable");
    if (dryRun) return { dryRun: true, group: String(g.group_id), groupName: g.group_name, text };
    // 限流放在成员校验之后：对不在的群点 20 次不该耗光 20/h 配额
    if (!rate("send")) { const e = new Error("发送请求过于频繁（20 次/小时），请稍后再试"); e.statusCode = 429; throw e; }
    const peer = { chatType: 2, guildId: "", peerUid: String(g.group_id) };
    const elements = [{ elementType: 1, elementId: "", textElement: { content: text, atType: 0, atUid: "", atTinyId: "", atNtUid: "" } }];
    const r = await kernelCall("sendMsg", () => msgApi.sendMsg(peer, elements), kernelTimeoutMs(20000), "sendMsg");
    if (!r) throw new Error("发送消息失败（内核无返回）");
    const src = r?.data && typeof r.data === "object" ? r.data : r;
    const rc = rcOf(r);
    const msgId = String(src?.msgId ?? src?.message_id ?? src?.messageId ?? r?.msgId ?? r?.message_id ?? "").trim();
    if (Number.isFinite(rc) && rc !== 0) {
      const err = new Error("发送消息失败：result=" + rc + (r?.errMsg ? " " + r.errMsg : ""));
      err.statusCode = 502;
      throw err;
    }
    // 内核可能只返回 {}（请求被受理但没有回执）。这时不能报成功——消息可能没发出去。
    if (!msgId) {
      const err = new Error("发送消息结果无法确认（内核未返回 msgId）");
      err.statusCode = 502;
      throw err;
    }
    recordHistory("send", String(g.group_id), g.group_name, msgId, { userId });
    return { group: String(g.group_id), groupName: g.group_name, text, msgId };
  }

  const BASE_HEADERS = {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };

  function send(res, code, obj) {
    if (res.headersSent || res.writableEnded) return; // 已写过就不要再写（双写会抛 ERR_HTTP_HEADERS_SENT）
    if (code >= 400) STATS.errors++; // 错误响应统一计数：401/429/5xx 都算，不只是未捕获异常
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      ...BASE_HEADERS,
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  const BODY_LIMIT = 8 * 1024; // 实际 payload <1KB，8KB 足够且更早拒绝
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      let settled = false;
      const fail = (e) => { if (settled) return; settled = true; reject(e); };
      req.on("data", (c) => {
        if (settled) return;
        size += c.length;
        // 超限只停止累积并继续排空：直接 destroy 会让客户端拿到连接重置而不是错误信息
        if (size > BODY_LIMIT) { tooLarge = true; chunks.length = 0; return; }
        chunks.push(c);
      });
      req.on("end", () => {
        if (settled) return;
        settled = true;
        if (tooLarge) {
          const e = new Error("body too large");
          e.statusCode = 413;
          reject(e);
          return;
        }
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve(text ? JSON.parse(text) : {});
        } catch {
          // 客户端 payload 格式错误是 4xx，不是服务端 500（否则监控会把客户端
          // 错误算成故障，排障时会往内核/磁盘方向查错）。
          const e = new Error("invalid json");
          e.statusCode = 400;
          reject(e);
        }
      });
      req.on("error", fail);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let p = url.pathname.replace(/^\/joiner/, "") || "/";
    if (!p.startsWith("/")) p = "/" + p;

    STATS.requests++;
    const routeKey = routeKeyOf(p);
    STATS.routes[routeKey] = (STATS.routes[routeKey] || 0) + 1;
    const t0 = process.hrtime.bigint();
    res.once("finish", () => {
      let e = latency[routeKey];
      if (!e) e = latency[routeKey] = { n: 0, samples: [] };
      e.n++;
      e.samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
      if (e.samples.length > LAT_SAMPLES) e.samples.shift();
    });

    try {
      const ip = clientIp(req);
      if (authBlocked(ip, Date.now())) {
        send(res, 429, { ok: false, error: "too many auth failures, retry later" });
        return;
      }
      const auth = authOf(req, url);
      if (!auth.ok) {
        STATS.authFailures++;
        // 只有「带了口令但不对」才计入爆破计数。完全没带口令的请求多半是
        // 扫描器 / 健康检查 / 未鉴权的运维探针：回 401 就够，不该把该 IP
        // 锁 10 分钟（线上 smoke 曾因此把自己出口 IP 打成 429）。
        if (auth.source !== "none") noteAuthFail(ip, Date.now());
        send(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      authFails.delete(ip); // 成功即销账，避免偶发输错累积成封禁
      if (req.method === "POST" && auth.source === "cookie" && !originAllowed(req)) {
        send(res, 403, { ok: false, error: "bad origin" });
        return;
      }

      // 旧书签里的 query token 过期，但 cookie 仍有效：302 到干净地址，别让人卡在 401。
      // 只在「最终靠 cookie 通过」时跳转；header 脚本场景继续直接回页面。
      if ((p === "/" || p.endsWith(".html")) && auth.source === "cookie" && auth.badQuery) {
        res.writeHead(302, { "Location": p === "/" ? "/joiner/" : p.replace(/^\//, "/joiner/"), ...BASE_HEADERS });
        res.end();
        return;
      }

      if ((p === "/" || p.endsWith(".html")) && auth.source === "query") {
        // 口令换 cookie 后立刻跳转到不含 token 的地址（302 不缓存）
        res.writeHead(302, {
          "Location": p === "/" ? "/joiner/" : p.replace(/^\//, "/joiner/"),
          "Set-Cookie": COOKIE_NAME + "=" + encodeURIComponent(url.searchParams.get("token")) + "; " + cookieAttrs(req),
          ...BASE_HEADERS,
        });
        res.end();
        return;
      }

      if (p === "/" || p.endsWith(".html")) {
        const html = readPageHtml();
        if (!html) { send(res, 500, { ok: false, error: "page missing" }); return; }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...BASE_HEADERS });
        res.end(html);
        return;
      }

      if (p === "/api/history" && req.method === "GET") {
        send(res, 200, { ok: true, data: hload().slice(-50) });
        return;
      }

      if (p === "/api/stats" && req.method === "GET") {
        const el = eventLoopHist;
        const ms = (v) => (Number.isFinite(v) ? +(v / 1e6).toFixed(3) : null);
        send(res, 200, { ok: true, data: {
          uptimeMs: Date.now() - STATS.startedAt,
          requests: STATS.requests,
          routes: STATS.routes,
          kernel: STATS.kernel,
          kernelTimeouts: STATS.kernelTimeouts,
          kernelZombies: STATS.kernelZombies,
          cache: { groupsHit: STATS.groupsHit, groupsMiss: STATS.groupsMiss },
          errors: STATS.errors,
          authFailures: STATS.authFailures,
          joinDedup: STATS.joinDedup,
          historyWriteFailures: STATS.historyWriteFailures,
          authBlockedIps: authFails.size,
          rate: Object.fromEntries(Object.keys(RATES).map((k) => [k, buckets[k].length])),
          eventLoopDelayMs: { mean: ms(el.mean), p50: ms(el.percentile(50)), p99: ms(el.percentile(99)), max: ms(el.max) },
          eventLoopWindowMs: histSince ? Date.now() - histSince : null,
          kernelQueue: { active: kernelActive, waiting: kernelWaiters.length, rejected: kernelQueueRejected, timeout: kernelQueueTimeout, zombies: kernelZombies.size },
          latencyMs: Object.fromEntries(Object.entries(latency).map(([k, v]) => {
            const sorted = [...v.samples].sort((a, b) => a - b);
            return [k, { n: v.n, p50: pct(sorted, 0.5), p99: pct(sorted, 0.99), max: pct(sorted, 1) }];
          })),
          rssMB: +(process.memoryUsage().rss / 1048576).toFixed(1),
          historyInMemory: hload().length,
        } });
        return;
      }

      if (p === "/api/groups" && req.method === "GET") {
        // 命中缓存时不再计一次 search 配额（页面轮询否则会白吃 120/h 的限制）。
        // 已有在途 getGroups 时也不计：10 个并发应共享同一次内核调用、只吃 1 个配额。
        const fresh = groupsFresh();
        if (fresh) STATS.groupsHit++; else STATS.groupsMiss++;
        if (!fresh && !groupsInflight && !rate("search")) { send(res, 429, { ok: false, error: "rate limited" }); return; }
        try {
          send(res, 200, { ok: true, data: await doListGroups() });
        } catch (e) {
          send(res, e.statusCode || 500, { ok: false, error: String(e.message || e) });
        }
        return;
      }

      if (p.startsWith("/api/") && req.method === "POST") {
        let body;
        try {
          body = await readBody(req);
        } catch (e) {
          send(res, e.statusCode || 500, { ok: false, error: String(e.message || e) });
          return;
        }
        if (p === "/api/search") {
          const kw = String(body.group || "").trim();
          if (!isDigits(kw)) { send(res, 400, { ok: false, error: "group 需要是群号数字" }); return; }
          if (!rate("search")) { send(res, 429, { ok: false, error: "rate limited" }); return; }
          try {
            const info = await doSearch(kw);
            if (!info) { send(res, 404, { ok: false, error: "搜不到该群" }); return; }
            recordHistory("search", kw, info.groupName, "ok");
            send(res, 200, { ok: true, data: info });
          } catch (e) {
            send(res, e.statusCode || 500, { ok: false, error: String(e.message || e) });
          }
          return;
        }

        if (p === "/api/join") {
          const group = String(body.group || "").trim();
          const answer = String(body.answer || "").trim();
          const dryRun = !!body.dryRun;
          if (!isDigits(group)) { send(res, 400, { ok: false, error: "group 需要是群号数字" }); return; }
          try {
            const r = await doJoin(group, answer, dryRun);
            send(res, 200, { ok: true, data: r });
          } catch (e) {
            send(res, e.statusCode || (e.answerRequired ? 422 : 500), { ok: false, error: String(e.message || e), answerRequired: !!e.answerRequired, question: e.question || "", groupInfo: e.groupInfo || null });
          }
          return;
        }

        if (p === "/api/leave") {
          const group = String(body.group || "").trim();
          const dryRun = !!body.dryRun;
          if (!isDigits(group)) { send(res, 400, { ok: false, error: "group 需要是群号数字" }); return; }
          if (!dryRun && !rate("leave")) { send(res, 429, { ok: false, error: "rate limited" }); return; }
          try {
            const r = await doLeave(group, dryRun);
            send(res, 200, { ok: true, data: r });
          } catch (e) {
            send(res, e.statusCode || 500, { ok: false, error: String(e.message || e) });
          }
          return;
        }

        if (p === "/api/send") {
          const group = String(body.group || "").trim();
          const userId = String(body.userId || "").trim();
          const customText = String(body.text || "").trim();
          const dryRun = !!body.dryRun;
          if (!isDigits(group)) { send(res, 400, { ok: false, error: "group 需要是群号数字" }); return; }
          if (!userId) { send(res, 400, { ok: false, error: "userId 不能为空" }); return; }
          try {
            const r = await doSend(group, userId, customText, dryRun);
            send(res, 200, { ok: true, data: r });
          } catch (e) {
            send(res, e.statusCode || 400, { ok: false, error: String(e.message || e) });
          }
          return;
        }
      }

      send(res, 404, { ok: false, error: "not found" });
    } catch (e) {
      // 错误计数在 send() 里统一做（code>=400）；这里只兜未预期的抛错。
      send(res, e?.statusCode || 500, { ok: false, error: String(e?.message || e) });
    }
  });

  // 慢连接/慢头请求的兜底（默认 requestTimeout 300s，配合隧道容易长期占 socket）
  server.headersTimeout = 10000;
  // 单请求最坏预算：/api/join 会串行打 3 次内核（getGroups → search → reqToJoinGroup），
  // 每次都可能先排队（KERNEL_WAIT_MS）再超时。requestTimeout 小于这个上界时，
  // 内核一慢服务端就先掐连接，客户端拿不到干净的 503，/api/stats 也少一条样本。
  const KERNEL_CALLS_PER_REQUEST = 3;
  const KERNEL_CALL_MAX_MS = Math.max(KERNEL_TIMEOUT_OVERRIDE, 20000);
  server.requestTimeout = Math.max(20000, KERNEL_CALLS_PER_REQUEST * (KERNEL_WAIT_MS + KERNEL_CALL_MAX_MS) + 5000);
  server.keepAliveTimeout = 5000;

  SRV = server;
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => { if (settled) return; settled = true; if (err) reject(err); else resolve(); };
      const onErr = (e) => { server.removeListener("listening", onListening); done(e); };
      const onListening = () => { server.removeListener("error", onErr); done(); };
      server.once("listening", onListening);
      server.once("error", onErr);
      server.listen(PORT, HOST);
    });
  } catch (e) {
    SRV = null; // 端口没起来就不要留半成品引用
    throw e;
  }
  server.on("error", (e) => ctx.logger.logError("joiner: http error", e));
  ctx.logger.info(`joiner: listening on ${HOST}:${PORT}`);
  ctx.logger.info("napcat-plugin-joiner loaded");
}

export async function plugin_cleanup() {
  // 先拒绝仍在排队的 join/leave/send：否则 server.close() 后它们还能拿到槽位，
  // 在已卸载的实例上继续打内核、向已关闭的响应写数据。
  try { cancelKernelWaiters?.(); } catch {}
  cancelKernelWaiters = null;
  // 合并落盘的兜底：先等在途异步写落地，再同步写最终快照，避免旧快照覆盖新快照
  try { await hWriting; } catch {}
  try { hflush(true); } catch {}
  for (const stop of STOP_WATCHES) { try { stop(); } catch {} }
  STOP_WATCHES = [];
  try { eventLoopHist.disable(); } catch {}
  // 关服务器：否则重载插件时 19001 仍被旧实例占用（EADDRINUSE，新实例静默不监听）
  const s = SRV;
  SRV = null;
  if (!s) return;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      s.closeIdleConnections?.();
      s.close(finish);
    } catch { finish(); }
    const t = setTimeout(finish, 2000);
    if (typeof t.unref === "function") t.unref();
  });
}