// napcat-plugin-joiner mock 测试：假内核 + 真 HTTP，不连 QQ/NapCat。
// 运行：node --test /tmp/joiner-mock-tests/mock.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const PDIR = process.env.JOINER_DIR || "/tmp/joiner-mock/plugin";
const B = "http://127.0.0.1:19001";

// ---------- 预置：250 条历史，用于验证「载入时只保留最近 200」 ----------
{
  const lines = [];
  for (let i = 0; i < 250; i++) {
    lines.push(JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", action: "seed", group: String(i), groupName: "", result: "ok" }));
  }
  fs.writeFileSync(path.join(PDIR, "history.json"), lines.join("\n") + "\n", { mode: 0o600 });
}

// ---------- 假内核 ----------
const calls = { getGroups: 0, searchGroup: 0, reqToJoinGroup: 0, quitGroup: 0, sendMsg: 0 };
const state = {
  groups: [{ groupCode: "111111", groupName: "已加入群", memberCount: 10, maxMemberCount: 200 }],
  search: { mode: "ok", info: { groupCode: "10000001", groupName: "Demo Group", groupOption: 2, groupQuestion: "" } },
  join: { result: 0, errMsg: "" },
  leave: { result: 0, errMsg: "success" },
  sent: [],
};

const GroupApi = {
  async getGroups() {
    calls.getGroups++;
    if (state.groupsDelay) await new Promise((r) => setTimeout(r, state.groupsDelay));
    return { groupList: state.groups.map((g) => ({ ...g })) };
  },
  async searchGroup(kw) {
    calls.searchGroup++;
    state.searchConcurrent = (state.searchConcurrent || 0) + 1;
    state.maxSearchConcurrent = Math.max(state.maxSearchConcurrent || 0, state.searchConcurrent);
    try {
      if (state.searchDelay) await new Promise((r) => setTimeout(r, state.searchDelay));
      if (state.search.mode === "throw") throw new Error("Timeout: NTEvent serviceAndMethod:NodeIKernelSearchService/searchGroup");
      if (state.search.mode === "null") return {};
      return { searchGroupInfo: { ...state.search.info, groupCode: String(kw) } };
    } finally {
      state.searchConcurrent--;
    }
  },
};
const MsgApi = {
  async sendMsg(peer, elements) {
    calls.sendMsg++;
    state.sent.push({ peer, elements });
    return { msgId: "mock-msg-" + calls.sendMsg };
  },
};
const session = {
  getGroupService: () => ({
    async reqToJoinGroup(req) {
      calls.reqToJoinGroup++;
      if (state.join.throw) throw new Error("kernel boom");
      return { ...state.join };
    },
    async quitGroup(code) { calls.quitGroup++; return { ...state.leave }; },
  }),
};
const ctx = {
  pluginPath: PDIR,
  logger: { info() {}, logError() {}, error() {}, log() {} },
  core: { apis: { GroupApi, MsgApi }, context: { session } },
};

// ---------- HTTP 助手 ----------
let token = "";
async function rq(p, { method = "GET", body, tok = token, rawBody, cookie } = {}) {
  const headers = {};
  if (tok) headers["X-Joiner-Token"] = tok;
  if (cookie) headers.Cookie = cookie;
  let payload;
  if (rawBody !== undefined) { headers["Content-Type"] = "application/json"; payload = rawBody; }
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const r = await fetch(B + p, { method, headers, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json, bytes: Buffer.byteLength(text), headers: r.headers };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch（undici）会按连接池限流，12 个并发实际只有 ~6 条连接同时在飞。
// 验证「队列上限」必须用真并发：每个请求单开一条 socket（agent:false）。
function rqRaw(p, body, tok = token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port: 19001, path: p, method: "POST", agent: false,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "X-Joiner-Token": tok,
      },
    }, (res) => {
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { d += c; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(d); } catch {}
        resolve({ status: res.statusCode, text: d, json });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

test("napcat-plugin-joiner v1.5.0 mock 回归", async (t) => {
  const { plugin_init, plugin_cleanup } = await import(path.join(PDIR, "index.mjs"));
  await plugin_init(ctx);
  token = fs.readFileSync(path.join(PDIR, "token"), "utf8").trim();
  assert.ok(token.length >= 32, "token 应已生成");
  const mode = (fs.statSync(path.join(PDIR, "token")).mode & 0o777).toString(8);
  assert.equal(mode, "600", "token 文件应为 0600");

  await t.test("历史载入：250 条只保留最近 200，接口回最近 50", async () => {
    const r = await rq("/api/history");
    assert.equal(r.status, 200);
    const d = r.json.data;
    assert.equal(d.length, 50);
    assert.equal(d[0].group, "200");
    assert.equal(d[49].group, "249");
  });

  await t.test("鉴权：无口令 401；query 口令 302 换 HttpOnly cookie；cookie/header 可复用", async () => {
    assert.equal((await rq("/", { tok: "" })).status, 401);
    assert.equal((await rq("/api/groups", { tok: "" })).status, 401);

    // 首次带 ?token= 打开页面：不再直接回 HTML，而是种 cookie + 302 到不含口令的地址
    const q = await fetch(B + "/?token=" + token, { redirect: "manual" });
    assert.equal(q.status, 302);
    assert.equal(q.headers.get("location"), "/joiner/");
    assert.equal(q.headers.get("cache-control"), "no-store");
    const setCookie = q.headers.get("set-cookie") || "";
    assert.match(setCookie, /joiner_token=/);
    assert.match(setCookie, /HttpOnly/, "token 不能给 JS 读");
    assert.match(setCookie, /SameSite=Lax/, "防 CSRF");
    assert.match(setCookie, /Path=\/joiner/);
    assert.doesNotMatch(setCookie, /Secure/, "纯 http（mesh 直连）不设 Secure");
    assert.doesNotMatch(q.headers.get("location"), /token=/, "跳转地址不能带口令");

    const ck = setCookie.split(";")[0];
    assert.equal((await rq("/api/groups", { tok: "", cookie: ck })).status, 200, "cookie 鉴权应通");
    assert.equal((await rq("/api/groups", { tok: "", cookie: "joiner_token=wrong" })).status, 401);

    // 带 header 的页面请求仍直接回 HTML（脚本/curl 场景不被 302 干扰）
    assert.equal((await rq("/")).status, 200);
    assert.match((await rq("/")).headers.get("content-type"), /text\/html/);
    assert.equal((await rq("/api/groups")).headers.get("cache-control"), "no-store");
    assert.equal((await rq("/api/groups")).headers.get("x-frame-options"), "DENY");

    // 旧书签里是过期口令，但 cookie 有效 → 302 到干净地址而不是 401
    const stale = await fetch(B + "/?token=" + "0".repeat(48), { redirect: "manual", headers: { Cookie: ck } });
    assert.equal(stale.status, 302);
    assert.equal(stale.headers.get("location"), "/joiner/");
    assert.equal(stale.headers.get("set-cookie"), null, "回落时不应重设 cookie");

    // 走 https 时 Cookie 必须带 Secure
    const sec = (await fetch(B + "/?token=" + token, { redirect: "manual", headers: { "x-forwarded-proto": "https" } })).headers.get("set-cookie");
    assert.match(sec, /Secure/);
  });

  await t.test("CSRF：cookie 来源的 POST 校验 Origin，query/header 来源不受限", async () => {
    const ck = (await fetch(B + "/?token=" + token, { redirect: "manual" })).headers.get("set-cookie").split(";")[0];
    const post = (headers) => fetch(B + "/api/join", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ group: "111111", dryRun: true }),
    }).then((r) => r.status);

    assert.equal(await post({ Cookie: ck, Origin: "https://evil.example" }), 403, "跨站 POST 必须拒");
    assert.equal(await post({ Cookie: ck, Origin: "https://qq.example.com" }), 200, "同站 POST 放行");
    assert.equal(await post({ Cookie: ck }), 200, "无 Origin（非浏览器）放行");
    assert.equal(await post({ "X-Joiner-Token": token, Origin: "https://evil.example" }), 200, "带口令的脚本场景不受 Origin 限制");
  });

  await t.test("鉴权失败闸门：同 IP 20 次失败后 429，其他 IP 不受影响", async () => {
    const badTok = "x".repeat(48);
    const IP = "203.0.113.9";
    let last = 0;
    for (let i = 0; i < 20; i++) {
      const r = await fetch(B + "/api/groups", { headers: { "X-Joiner-Token": badTok, "cf-connecting-ip": IP } });
      last = r.status;
      await r.text();
    }
    assert.equal(last, 401, "第 20 次仍是 401");
    const blocked = await fetch(B + "/api/groups", { headers: { "X-Joiner-Token": token, "cf-connecting-ip": IP } });
    assert.equal(blocked.status, 429, "封禁期内即使带对口令也 429");
    assert.equal((await rq("/api/groups")).status, 200, "其他 IP 不受影响");
    const stats = (await rq("/api/stats")).json.data;
    assert.ok(stats.authFailures >= 20, "失败次数应被统计，实际 " + stats.authFailures);
    assert.ok(stats.authBlockedIps >= 1);
  });

  await t.test("口令热轮换：替换 token 文件后旧口令失效（watch 失效 + 内存缓存）", async () => {
    const tf = path.join(PDIR, "token");
    const oldTok = token;
    const newTok = "b".repeat(48);
    fs.writeFileSync(tf, newTok, { mode: 0o600 });
    await sleep(1300); // fs.watchFile 轮询 500ms，等它触发重载
    assert.equal((await rq("/api/groups", { tok: oldTok })).status, 401, "旧口令应失效");
    assert.equal((await rq("/api/groups", { tok: newTok })).status, 200, "新口令应立即生效");
    assert.equal((await rq("/api/groups", { tok: "", cookie: "joiner_token=" + oldTok })).status, 401, "旧口令签发的 cookie 也要失效");
    fs.writeFileSync(tf, oldTok, { mode: 0o600 });
    await sleep(1300);
    assert.equal((await rq("/api/groups")).status, 200, "换回后旧口令恢复");
  });

  await t.test("CSRF：同源 Origin（非白名单 Host）也必须放行", async () => {
    const ck = (await fetch(B + "/?token=" + token, { redirect: "manual" })).headers.get("set-cookie").split(";")[0];
    const post = (origin) => fetch(B + "/api/join", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ck, Origin: origin },
      body: JSON.stringify({ group: "10000001", dryRun: true }),
    }).then((r) => r.status);

    // 浏览器从 127.0.0.1:19001 打开页面时，Origin 就是这个地址；白名单里没有它，但它是同源
    assert.equal(await post("http://127.0.0.1:19001"), 200, "同源 Origin 必须放行（mesh 入口的加群/退群/发消息靠它）");
    assert.equal(await post("https://evil.example"), 403, "跨站仍要拒");
    assert.equal(await post("null"), 403, "sandbox iframe 的 Origin: null 要拒");
  });

  await t.test("加群去重：同一群并发点击只向 QQ 提交一次", async () => {
    state.searchDelay = 300;           // 放大竞态窗口
    state.join = { result: 0, errMsg: "" };
    const g = "11111111";
    const fire = () => rq("/api/join", { method: "POST", body: { group: g } });
    const before = calls.reqToJoinGroup;
    const [a, b] = await Promise.all([fire(), fire()]);
    state.searchDelay = 0;
    assert.equal(calls.reqToJoinGroup - before, 1, "两次并发只应有一次真实内核提交");
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const st = (await rq("/api/stats")).json.data;
    assert.ok(st.joinDedup >= 1, "去重应被计数");
  });

  await t.test("已在群连点 12 次不消耗 10/h 加群配额", async () => {
    let codes = [];
    for (let i = 0; i < 12; i++) {
      const r = await rq("/api/join", { method: "POST", body: { group: "111111" } });
      codes.push(r.status);
    }
    assert.deepEqual([...new Set(codes)], [200], "全部应为 200 joined，实际 " + codes.join(","));
    const body = (await rq("/api/join", { method: "POST", body: { group: "111111" } })).json.data;
    assert.equal(body.status, "joined");
  });

  await t.test("内核没给 result 时必须是「未知」而不是成功", async () => {
    const oldLeave = state.leave;
    state.leave = {};                                  // 缺 result 字段
    const lv = await rq("/api/leave", { method: "POST", body: { group: "11111111" } });
    state.leave = oldLeave;
    assert.notEqual(lv.status, 200, "退群无 result 不能报成功");
    assert.match(lv.json.error, /未知/);

    const oldJoin = state.join;
    state.join = {};
    const jn = await rq("/api/join", { method: "POST", body: { group: "44444444" } });
    state.join = oldJoin;
    assert.notEqual(jn.status, 200, "加群无 result 不能报成功");
    assert.match(jn.json.error, /无法识别/);
  });

  await t.test("群列表缓存代际：退群后在途 getGroups 不许回填过期数据", async () => {
    state.groups = [{ groupCode: "333333", groupName: "待退群", memberCount: 5, maxMemberCount: 200 }];
    state.groupsDelay = 300;
    const p1 = rq("/api/groups");                       // 在途，代际 = 旧
    await sleep(60);
    state.groups = [];                                  // 退群后真实列表已空
    const lv = await rq("/api/leave", { method: "POST", body: { group: "333333" } });
    assert.equal(lv.status, 200);
    await p1;                                            // 旧请求回来了，但不该回填缓存
    state.groupsDelay = 0;
    const after = await rq("/api/groups");
    assert.equal(after.json.data.length, 0, "缓存不能被在途的旧结果回填");
    state.groups = [{ groupCode: "111111", groupName: "已加入群", memberCount: 10, maxMemberCount: 200 }];
  });

  await t.test("群列表缓存：4s 内复用，命中不再打内核", async () => {
    await sleep(4200); // 前面用例可能已预热缓存，先等 TTL 过期再计时
    calls.getGroups = 0;
    const a = await rq("/api/groups");
    assert.equal(a.status, 200);
    assert.equal(a.json.data.length, 1);
    assert.equal(calls.getGroups, 1);
    for (let i = 0; i < 5; i++) assert.equal((await rq("/api/groups")).status, 200);
    assert.equal(calls.getGroups, 1, "5 次缓存命中不应再调 getGroups");
  });

  await t.test("缓存命中不消耗 search 配额（130 次连打不应 429）", async () => {
    for (let i = 0; i < 130; i++) {
      const r = await rq("/api/groups");
      assert.equal(r.status, 200, `第 ${i + 1} 次被限流`);
    }
  });

  await t.test("TTL 4s 后重新打内核，且并发只打一次", async () => {
    await sleep(4200);
    calls.getGroups = 0;
    assert.equal((await rq("/api/groups")).status, 200);
    assert.equal(calls.getGroups, 1, "过期后应重新拉取");
    await sleep(4200);
    calls.getGroups = 0;
    const rs = await Promise.all(Array.from({ length: 10 }, () => rq("/api/groups")));
    rs.forEach((r) => assert.equal(r.status, 200));
    assert.equal(calls.getGroups, 1, "并发 10 个应共享同一次内核调用");
  });

  await t.test("页面内存缓存且能热更新（watch 失效）", async () => {
    const a = await rq("/");
    const f = path.join(PDIR, "page.html");
    const orig = fs.readFileSync(f, "utf8");
    assert.equal(a.bytes, Buffer.byteLength(orig));
    fs.appendFileSync(f, "\n<!-- mock-test -->\n");
    await sleep(1300);
    const b = await rq("/");
    assert.ok(b.bytes > a.bytes, "改文件后应立即重读");
    fs.writeFileSync(f, orig);
    await sleep(1300);
    const c = await rq("/");
    assert.equal(c.bytes, a.bytes);
  });

  await t.test("readBody：超 8KB 回 413（不打断连接），非法 JSON 回 500", async () => {
    const big = await rq("/api/search", { method: "POST", rawBody: JSON.stringify({ group: "1".repeat(70 * 1024) }) });
    assert.equal(big.status, 413, "超大 body 应回 413");
    assert.match(big.json.error, /body too large/);
    const alive = await rq("/api/groups");
    assert.equal(alive.status, 200, "被拒后服务器应仍可用");
    const justOver = await rq("/api/search", { method: "POST", rawBody: JSON.stringify({ group: "1".repeat(9 * 1024) }) });
    assert.equal(justOver.status, 413, "刚超 8KB 也应拒绝");
    const bad = await rq("/api/search", { method: "POST", rawBody: "{not json" });
    assert.equal(bad.status, 500);
    assert.match(bad.json.error, /invalid json/);
    const fine = await rq("/api/search", { method: "POST", body: { group: "10000001" } });
    assert.equal(fine.status, 200, "正常大小的 body 不受影响");
  });

  await t.test("搜索：正常 / 搜不到 / 内核抛错不外泄原文", async () => {
    state.search.mode = "ok";
    const ok = await rq("/api/search", { method: "POST", body: { group: "10000001" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.data.groupName, "Demo Group");

    state.search.mode = "null";
    const nf = await rq("/api/search", { method: "POST", body: { group: "999999999" } });
    assert.equal(nf.status, 404);

    state.search.mode = "throw";
    const er = await rq("/api/search", { method: "POST", body: { group: "888888888" } });
    assert.equal(er.status, 500);
    assert.match(er.json.error, /群号不存在或搜索超时/);
    assert.doesNotMatch(er.json.error, /NTEvent|Timeout:/);
    state.search.mode = "ok";
  });

  await t.test("加群：已在群不重复提交", async () => {
    calls.reqToJoinGroup = 0;
    const r = await rq("/api/join", { method: "POST", body: { group: "111111" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.status, "joined");
    assert.equal(calls.reqToJoinGroup, 0);
  });

  await t.test("加群：result=0 → submitted", async () => {
    state.join = { result: 0, errMsg: "" };
    const r = await rq("/api/join", { method: "POST", body: { group: "222222" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.status, "submitted");
    assert.equal(calls.reqToJoinGroup, 1);
  });

  await t.test("加群：result=1 → pending，且 10 分钟冷却内不重复提交", async () => {
    state.join = { result: 1, errMsg: "" };
    const a = await rq("/api/join", { method: "POST", body: { group: "333333" } });
    assert.equal(a.json.data.status, "pending");
    const before = calls.reqToJoinGroup;
    const b = await rq("/api/join", { method: "POST", body: { group: "333333" } });
    assert.equal(b.json.data.status, "pending");
    assert.equal(b.json.data.cached, true);
    assert.equal(calls.reqToJoinGroup, before, "冷却期内不应再发申请");
  });

  await t.test("加群：groupOption 3 直接拒绝", async () => {
    state.search.info = { groupCode: "444444", groupName: "拒加入群", groupOption: 3, groupQuestion: "" };
    const r = await rq("/api/join", { method: "POST", body: { group: "444444" } });
    assert.equal(r.status, 422, "业务拒绝用 422 而不是 500");
    assert.match(r.json.error, /禁止任何人加入/);
  });

  await t.test("加群：groupOption 4 无答案 → 422 answerRequired", async () => {
    state.search.info = { groupCode: "555555", groupName: "需答题群", groupOption: 4, groupQuestion: "口令是什么" };
    const r = await rq("/api/join", { method: "POST", body: { group: "555555" } });
    assert.equal(r.status, 422);
    assert.equal(r.json.answerRequired, true);
    assert.equal(r.json.question, "口令是什么");
  });

  await t.test("加群：result=2/3/5/NaN 都报错且带中文原因", async () => {
    state.search.info = { groupCode: "666666", groupName: "码值群", groupOption: 2, groupQuestion: "" };
    state.join = { result: 2, errMsg: "" };
    let r = await rq("/api/join", { method: "POST", body: { group: "666666", answer: "x" } });
    assert.equal(r.status, 422);
    assert.match(r.json.error, /result=2/);

    state.join = { result: 3, errMsg: "" };
    r = await rq("/api/join", { method: "POST", body: { group: "666666", answer: "x" } });
    assert.match(r.json.error, /频繁/);

    state.join = { result: 5, errMsg: "" };
    r = await rq("/api/join", { method: "POST", body: { group: "666666", answer: "x" } });
    assert.match(r.json.error, /result=5/);

    state.join = { result: "garbage", errMsg: "" };
    r = await rq("/api/join", { method: "POST", body: { group: "666666", answer: "x" } });
    assert.equal(r.status, 500);
    assert.match(r.json.error, /无法识别/);
    state.join = { result: 0, errMsg: "" };
  });

  await t.test("加群 dryRun 不发真实请求", async () => {
    const before = calls.reqToJoinGroup;
    const r = await rq("/api/join", { method: "POST", body: { group: "777777", dryRun: true } });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.dryRun, true);
    assert.equal(calls.reqToJoinGroup, before);
  });

  await t.test("退群：result=0 成功并失效群列表缓存", async () => {
    state.leave = { result: 0, errMsg: "success" };
    const r = await rq("/api/leave", { method: "POST", body: { group: "10000001" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.status, "left");
    calls.getGroups = 0;
    await rq("/api/groups");
    assert.equal(calls.getGroups, 1, "退群后缓存应失效");
  });

  await t.test("退群：result=20000 → 报错且历史记 ok:false", async () => {
    state.leave = { result: 20000, errMsg: "invoke trpc.group.cmd0x55b.Transporter error, type:business" };
    const r = await rq("/api/leave", { method: "POST", body: { group: "999000111" } });
    assert.equal(r.status, 500);
    assert.match(r.json.error, /退群失败/);
    const h = await rq("/api/history");
    const last = h.json.data.at(-1);
    assert.equal(last.action, "leave");
    assert.equal(last.ok, false);
  });

  await t.test("发消息：不在的群拒绝；在的群 dryRun 与实际发送都对", async () => {
    const bad = await rq("/api/send", { method: "POST", body: { group: "10000001", userId: "11" } });
    assert.equal(bad.status, 404, "不在的群用 404");
    assert.match(bad.json.error, /机器人不在这个群/);

    const dry = await rq("/api/send", { method: "POST", body: { group: "111111", userId: "11", dryRun: true } });
    assert.equal(dry.status, 200);
    assert.equal(dry.json.data.text, "用户 ID：11，申请体验额度");
    assert.equal(calls.sendMsg, 0);

    const real = await rq("/api/send", { method: "POST", body: { group: "111111", userId: "11" } });
    assert.equal(real.status, 200);
    assert.equal(real.json.data.msgId, "mock-msg-1");
    assert.equal(calls.sendMsg, 1);

    const { peer, elements } = state.sent[0];
    assert.deepEqual(peer, { chatType: 2, guildId: "", peerUid: "111111" });
    assert.equal(elements[0].elementType, 1);
    assert.equal(elements[0].textElement.content, "用户 ID：11，申请体验额度");
    assert.equal(elements[0].textElement.atType, 0);

    const long = await rq("/api/send", { method: "POST", body: { group: "111111", userId: "11", text: "x".repeat(501) } });
    assert.equal(long.status, 400);
  });

  await t.test("内核并发闸门：同时最多 2 个 search，其余排队", async () => {
    state.searchDelay = 150;
    state.maxSearchConcurrent = 0;
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      rq("/api/search", { method: "POST", body: { group: String(700000 + i) } })));
    state.searchDelay = 0;
    rs.forEach((r) => assert.equal(r.status, 200));
    assert.ok(state.maxSearchConcurrent <= 2, "并发应 ≤2，实际 " + state.maxSearchConcurrent);
    assert.ok(state.maxSearchConcurrent >= 2, "应实际用到 2 个并发");
  });

  await t.test("内核队列有界：排队满了立刻 503，不堆成几分钟积压", async () => {
    state.searchDelay = 400;
    const before = (await rq("/api/stats")).json.data.kernelQueue.rejected;
    // 2 个在跑 + 队列上限 8 = 10 个能进，第 11/12 个必须被立刻拒
    state.maxSearchConcurrent = 0;
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      rqRaw("/api/search", { group: String(710000 + i) })));
    state.searchDelay = 0;
    const busy = rs.filter((r) => r.status === 503);
    const ok = rs.filter((r) => r.status === 200);
    assert.ok(busy.length >= 1, "队列满应至少拒 1 个，实际状态：" + rs.map((r) => r.status).join(","));
    assert.ok(ok.length >= 1, "已拿到槽位的请求仍应成功");
    assert.match(busy[0].json.error, /繁忙/, "拒绝原因要说人话");
    const after = (await rq("/api/stats")).json.data.kernelQueue.rejected;
    assert.ok(after - before >= busy.length, "拒绝次数应被 /api/stats 统计");
    assert.equal((await rq("/api/stats")).json.data.kernelQueue.waiting, 0, "排空后队列应归零");
  });

  await t.test("/api/stats：请求/内核/缓存/事件循环指标可读", async () => {
    const r = await rq("/api/stats");
    assert.equal(r.status, 200);
    const d = r.json.data;
    assert.ok(d.requests > 10, "请求计数应已累积，实际 " + d.requests);
    assert.ok(d.kernel.searchGroup >= 1, "内核调用应被统计");
    assert.equal(typeof d.eventLoopDelayMs.p99, "number");
    assert.ok(d.rssMB > 0);
    assert.ok(d.historyInMemory > 0 && d.historyInMemory <= 200);
    assert.ok(d.cache.groupsHit > 0, "应有缓存命中记录");
    assert.equal(typeof d.authFailures, "number", "应暴露鉴权失败计数");
    assert.equal(typeof d.joinDedup, "number", "应暴露加群去重计数");
  });

  await t.test("历史：写入合并落盘，环形上限 200 不被突破", async () => {
    await sleep(1200);
    const disk = fs.readFileSync(path.join(PDIR, "history.json"), "utf8").split("\n").filter(Boolean);
    assert.ok(disk.length <= 200, `磁盘历史应 ≤200，实际 ${disk.length}`);
    const parsed = disk.map((l) => JSON.parse(l));
    assert.ok(parsed.some((x) => x.action === "send"), "send 应已落盘");
    const mode = (fs.statSync(path.join(PDIR, "history.json")).mode & 0o777).toString(8);
    assert.equal(mode, "600");
  });

  await t.test("withTimeout 不留残余定时器（否则进程活满 15~20s）", async () => {
    await rq("/api/search", { method: "POST", body: { group: "10000001" } });
    await sleep(1200); // 让 history 合并定时器先落地
    const res = process.getActiveResourcesInfo();
    assert.ok(!res.includes("Timeout"), "不应存在未清理的 Timeout 句柄：" + JSON.stringify(res));
  });

  await t.test("重载后直方图窗口归零（不继承上一实例的尖峰）", async () => {
    const a = (await rq("/api/stats")).json.data;
    assert.ok(a.eventLoopWindowMs > 1000, "本实例窗口应已累积，实际 " + a.eventLoopWindowMs);

    await plugin_cleanup();
    await sleep(60);
    await plugin_init(ctx);

    const b = (await rq("/api/stats")).json.data;
    assert.ok(b.eventLoopWindowMs < a.eventLoopWindowMs, "重载后统计窗口必须重新计时");
    assert.ok(b.eventLoopWindowMs <= 2000, "新实例窗口应只有几十 ms，实际 " + b.eventLoopWindowMs);
    assert.ok(b.uptimeMs <= 2000, "uptime 也应重置，实际 " + b.uptimeMs);
    // 注意：这里故意不 cleanup —— 后面的「cleanup 释放端口」用例需要 server 活着
  });

  await t.test("plugin_cleanup 同步落盘并释放端口（可重复 init）", async () => {
    // 产生一条待落盘记录后再 cleanup
    await rq("/api/search", { method: "POST", body: { group: "10000001" } });
    await plugin_cleanup();
    const disk = fs.readFileSync(path.join(PDIR, "history.json"), "utf8").split("\n").filter(Boolean);
    assert.ok(disk.length <= 200);
    assert.equal(JSON.parse(disk.at(-1)).action, "search", "cleanup 应同步写完最后一条");

    // 端口释放：能再次绑定说明 server 已关闭
    const net = await import("node:net");
    const ok = await new Promise((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.listen(19001, "0.0.0.0", () => s.close(() => resolve(true)));
    });
    assert.equal(ok, true, "plugin_cleanup 后 19001 应可重新绑定");
  });

  await t.test("listen 失败要抛错，不再静默 loaded", async () => {
    const net = await import("node:net");
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(19001, "0.0.0.0", r));
    let err = null;
    try { await plugin_init(ctx); } catch (e) { err = e; }
    await new Promise((r) => blocker.close(r));
    assert.ok(err, "端口被占时 plugin_init 应拒绝");
    assert.match(String(err.code || err.message), /EADDRINUSE/);
    await plugin_cleanup(); // 清掉 failed init 注册的 watch
  });
});
