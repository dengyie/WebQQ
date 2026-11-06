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

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(label + " 超时(" + ms + "ms)")), ms);
    if (typeof timer.unref === "function") timer.unref();
  });
  // 旧实现：promise 先完成时定时器不 clear，每次内核调用残留一个 15~20s 的 handle
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) { clearTimeout(timer); timer = null; }
  });
}

function rcOf(res) {
  // 缺字段必须是「未知」(NaN) 而不是 0：0 在退群/加群里代表成功，
  // 内核没有给出 result 时把成功报出去等于假成功。
  const raw = res?.result ?? res?.errCode ?? NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

const JOIN_COOLDOWN_MS = 600e3; // 10 分钟：pending(result=1) 内不重复提交
const lastJoin = new Map();

// —— 口令换 cookie（v1.3.0）——
// 口令放 URL 会留在浏览器历史/书签/Referer 里。首次带 ?token= 打开页面时校验通过即种
// HttpOnly cookie 并 302 到干净地址，之后页面/接口都用 cookie 鉴权。
// Path=/joiner：页面与接口一律在 /joiner/ 前缀下（302 目标也是 /joiner/），所以够用；
// 同时不会把口令 cookie 带进同源的 NapCat WebUI 请求里。
const COOKIE_NAME = "joiner_token";
const COOKIE_MAX_AGE = 30 * 24 * 3600;
const AUTH_FAIL_LIMIT = 20;
const AUTH_FAIL_WINDOW_MS = 600e3;
const authFails = new Map(); // ip -> { n, at }

function clientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (cf) return String(cf).trim();
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
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

function authBlocked(ip, t) {
  const r = authFails.get(ip);
  if (!r) return false;
  if (t - r.at > AUTH_FAIL_WINDOW_MS) { authFails.delete(ip); return false; }
  return r.n >= AUTH_FAIL_LIMIT;
}

function noteAuthFail(ip, t) {
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
const STATS = { startedAt: Date.now(), requests: 0, routes: {}, kernel: {}, groupsHit: 0, groupsMiss: 0, errors: 0, authFailures: 0, joinDedup: 0 };
const eventLoopHist = monitorEventLoopDelay({ resolution: 20 });
let PLUGIN_DIR = "";
let hbuf = null;      // null = 尚未从磁盘载入
let hTimer = null;
let hDirty = false;
let hWriting = null;  // 在途异步写：保证写盘顺序，cleanup 前要等它落地

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

function hflush(sync) {
  hTimer = null;
  if (!hDirty || !hbuf) return;
  hDirty = false;
  const text = hbuf.map((x) => JSON.stringify(x)).join("\n") + (hbuf.length ? "\n" : "");
  if (sync) {
    try { fs.writeFileSync(historyFile(), text, { mode: 0o600 }); } catch {}
    return;
  }
  // 串行化：并发/乱序的 writeFile 会让旧快照覆盖新快照（丢最后几条审计记录）
  hWriting = (hWriting || Promise.resolve())
    .then(() => fs.promises.writeFile(historyFile(), text, { mode: 0o600 }))
    .catch(() => {});
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
    try { tokenValue = String(fs.readFileSync(tokenFile, "utf8")).trim(); } catch { tokenValue = ""; }
  }
  loadPage();
  loadToken();

  // 事件循环延迟直方图：不开 enable 的话读出来是空值（NaN→null），指标等于没有
  eventLoopHist.enable();

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
  function authOf(req, url) {
    const q = url.searchParams.get("token") || "";
    if (q) return { ok: tokenEqual(q), source: "query" };
    const h = req.headers["x-joiner-token"] || "";
    if (h) return { ok: tokenEqual(h), source: "header" };
    const c = cookieGet(req.headers.cookie, COOKIE_NAME);
    if (c) return { ok: tokenEqual(c), source: "cookie" };
    return { ok: false, source: "none" };
  }
  function cookieAttrs(req) {
    const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
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
  // 小时级限流管不住「同时几个」。这里最多 2 个并发，其余排队，超时仍各自生效。
  const KERNEL_MAX = 2;
  let kernelActive = 0;
  const kernelWaiters = [];
  async function kernelCall(label, fn) {
    while (kernelActive >= KERNEL_MAX) await new Promise((r) => kernelWaiters.push(r));
    kernelActive++;
    STATS.kernel[label] = (STATS.kernel[label] || 0) + 1;
    try { return await fn(); }
    finally {
      kernelActive--;
      const next = kernelWaiters.shift();
      if (next) next();
    }
  }

  async function doSearch(keyword) {
    const groupApi = ctx.core?.apis?.GroupApi;
    if (!groupApi || typeof groupApi.searchGroup !== "function") throw new Error("GroupApi.searchGroup unavailable");
    let searched;
    try {
      searched = await kernelCall("searchGroup", () => withTimeout(Promise.resolve(groupApi.searchGroup(String(keyword).trim())), 15000, "searchGroup"));
    } catch (e) {
      // 配置/能力问题要原样上抛（500），只有内核超时才翻成友好文案
      if (/unavailable/i.test(String(e?.message || ""))) throw e;
      throw new Error("群号不存在或搜索超时，请稍后重试");
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

  async function doListGroups(force) {
    if (!force && groupsFresh()) return groupsCache.data;
    if (groupsInflight) return groupsInflight;
    groupsInflight = (async () => {
      const gen = groupsGen;
      const groupApi = ctx.core?.apis?.GroupApi;
      if (!groupApi || typeof groupApi.getGroups !== "function") throw new Error("GroupApi.getGroups unavailable");
      const raw = await kernelCall("getGroups", () => withTimeout(Promise.resolve(groupApi.getGroups(false)), 15000, "getGroups"));
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

    // 冷却去重：最近一次 result=1（待审核）且未过 10 分钟 → 直接回 pending，不重复发申请
    const prev = lastJoin.get(String(group));
    if (prev && Date.now() - prev.ts < JOIN_COOLDOWN_MS && prev.code === 1) {
      return { status: "pending", code: 1, message: "申请已提交，等待管理员审核（冷却期内不重复提交）", groupInfo: prev.groupInfo || null, nativeResult: null, cached: true, cooldownMs: JOIN_COOLDOWN_MS - (Date.now() - prev.ts) };
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
      ? withTimeout(Promise.resolve(gs.reqToJoinGroup(String(group), req)), 20000, "reqToJoinGroup")
      : withTimeout(Promise.resolve(gs.reqToJoinGroup(req)), 20000, "reqToJoinGroup")));

    const rc = rcOf(result);
    lastJoin.set(String(group), { ts: Date.now(), code: rc, groupInfo: info });
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
      result = await kernelCall("quitGroup", () => withTimeout(Promise.resolve(gs.quitGroup(String(group))), 20000, "quitGroup"));
    } else {
      const groupApi = ctx.core?.apis?.GroupApi;
      if (!groupApi || typeof groupApi.quitGroup !== "function") throw new Error("quitGroup unavailable");
      result = await kernelCall("quitGroup", () => groupApi.quitGroup(String(group)));
    }
    const lr = rcOf(result);
    if (lr !== 0) {
      const msg = String(result?.errMsg || "");
      recordHistory("leave", String(group), "", { result: Number.isNaN(lr) ? "unknown" : lr, errMsg: msg }, { ok: false });
      throw new Error("退群失败：" + (Number.isNaN(lr) ? "未知返回" : "result=" + lr) + (msg ? " " + msg : ""));
    }
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
    const r = await kernelCall("sendMsg", () => withTimeout(Promise.resolve(msgApi.sendMsg(peer, elements)), 20000, "sendMsg"));
    if (!r) throw new Error("发送消息失败（内核无返回）");
    recordHistory("send", String(g.group_id), g.group_name, String(r.msgId || ""), { userId });
    return { group: String(g.group_id), groupName: g.group_name, text, msgId: String(r.msgId || "") };
  }

  const BASE_HEADERS = {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };

  function send(res, code, obj) {
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
        } catch { reject(new Error("invalid json")); }
      });
      req.on("error", fail);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let p = url.pathname.replace(/^\/joiner/, "") || "/";
    if (!p.startsWith("/")) p = "/" + p;

    STATS.requests++;
    const routeKey = p.startsWith("/api/") ? p : (p === "/" || p.endsWith(".html") ? "/" : "other");
    STATS.routes[routeKey] = (STATS.routes[routeKey] || 0) + 1;

    try {
      const ip = clientIp(req);
      if (authBlocked(ip)) {
        send(res, 429, { ok: false, error: "too many auth failures, retry later" });
        return;
      }
      const auth = authOf(req, url);
      if (!auth.ok) {
        // 页面请求带过期口令（旧书签）但 cookie 仍有效：清掉地址栏里的旧 token，别让人卡在 401
        if ((p === "/" || p.endsWith(".html")) && auth.source === "query") {
          const c = cookieGet(req.headers.cookie, COOKIE_NAME);
          if (c && tokenEqual(c)) {
            res.writeHead(302, { "Location": p === "/" ? "/joiner/" : p.replace(/^\//, "/joiner/"), ...BASE_HEADERS });
            res.end();
            return;
          }
        }
        STATS.authFailures++;
        noteAuthFail(ip, Date.now());
        send(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      authFails.delete(ip); // 成功即销账，避免偶发输错累积成封禁
      if (req.method === "POST" && auth.source === "cookie" && !originAllowed(req)) {
        send(res, 403, { ok: false, error: "bad origin" });
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
          cache: { groupsHit: STATS.groupsHit, groupsMiss: STATS.groupsMiss },
          errors: STATS.errors,
          authFailures: STATS.authFailures,
          joinDedup: STATS.joinDedup,
          authBlockedIps: authFails.size,
          eventLoopDelayMs: { mean: ms(el.mean), p50: ms(el.percentile(50)), p99: ms(el.percentile(99)), max: ms(el.max) },
          rssMB: +(process.memoryUsage().rss / 1048576).toFixed(1),
          historyInMemory: hload().length,
        } });
        return;
      }

      if (p === "/api/groups" && req.method === "GET") {
        // 命中缓存时不再计一次 search 配额（页面轮询否则会白吃 120/h 的限制）
        const fresh = groupsFresh();
        if (fresh) STATS.groupsHit++; else STATS.groupsMiss++;
        if (!fresh && !rate("search")) { send(res, 429, { ok: false, error: "rate limited" }); return; }
        send(res, 200, { ok: true, data: await doListGroups() });
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
          const info = await doSearch(kw);
          if (!info) { send(res, 404, { ok: false, error: "搜不到该群" }); return; }
          recordHistory("search", kw, info.groupName, "ok");
          send(res, 200, { ok: true, data: info });
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
            send(res, 500, { ok: false, error: String(e.message || e) });
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
      STATS.errors++;
      send(res, 500, { ok: false, error: String(e?.message || e) });
    }
  });

  // 慢连接/慢头请求的兜底（默认 requestTimeout 300s，配合隧道容易长期占 socket）
  server.headersTimeout = 10000;
  server.requestTimeout = 20000;
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