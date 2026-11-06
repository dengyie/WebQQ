// 取证：内核调用超时只让 HTTP 先回 503，槽位必须等底层 promise settle 才释放。
// 用法：node timeout-check.mjs
// 期望：2 个慢调用各 ~300ms 回 503「超时」；排队者 ~200ms 回 503「排队超时」；
//       底层没结束时新请求仍受限；底层 settle 后新请求恢复 200，active 归零。
import fs from "node:fs";
import path from "node:path";

const SRC = process.env.JOINER_SRC || new URL("../napcat/plugins/napcat-plugin-joiner", import.meta.url).pathname;
const PDIR = "/tmp/joiner-mock/timeout-plugin";

fs.rmSync(PDIR, { recursive: true, force: true });
fs.mkdirSync(PDIR, { recursive: true });
for (const f of ["index.mjs", "page.html", "package.json"]) {
  fs.copyFileSync(path.join(SRC, f), path.join(PDIR, f));
}
fs.writeFileSync(path.join(PDIR, "history.json"), "", { mode: 0o600 });

process.env.JOINER_KERNEL_TIMEOUT_MS = "300"; // 调用超时压到 300ms
process.env.JOINER_KERNEL_WAIT_MS = "200";    // 排队上限压到 200ms

const state = { delay: 1200 };
const ctx = {
  pluginPath: PDIR,
  logger: { info() {}, logError() {}, error() {}, log() {} },
  core: {
    apis: {
      GroupApi: {
        async getGroups() { return { groupList: [] }; },
        async searchGroup(kw) {
          const d = state.delay;
          if (d) await new Promise((r) => setTimeout(r, d));
          return { searchGroupInfo: { groupCode: String(kw), groupName: "目标群", groupOption: 2 } };
        },
      },
      MsgApi: {},
    },
    context: { session: { getGroupService: () => ({}) } },
  },
};

const { plugin_init, plugin_cleanup } = await import(path.join(PDIR, "index.mjs"));
await plugin_init(ctx);
const tok = fs.readFileSync(path.join(PDIR, "token"), "utf8").trim();
const B = "http://127.0.0.1:19001";
const fire = (g) => fetch(B + "/api/search", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Joiner-Token": tok },
  body: JSON.stringify({ group: g }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

const t0 = Date.now();
const p1 = fire("10000001");
const p2 = fire("10000002");
await new Promise((r) => setTimeout(r, 60)); // 让前两个拿到槽位
const p3 = fire("10000003");                  // 排队 → 200ms 后排队超时
const r3 = await p3;
const waited3 = Date.now() - t0;

// 槽位仍被底层调用占着：再来一个也只能排队并超时
const p4 = fire("10000004");
const r4 = await p4;

const [r1, r2] = await Promise.all([p1, p2]);

// 等底层两个 1200ms 的 promise settle（handoff 在 settle 后才发生）
await new Promise((r) => setTimeout(r, Math.max(0, 1400 - (Date.now() - t0))));
state.delay = 0;
const r5 = await fire("10000005");            // 槽位应已释放

const st = (await (await fetch(B + "/api/stats", { headers: { "X-Joiner-Token": tok } })).json()).data;

console.log("慢调用 1/2 = ", r1.status, r2.status, r1.body?.error, "/", r2.body?.error);
console.log("排队第 3 个 = ", r3.status, r3.body?.error, `等待 ${waited3}ms`);
console.log("占用中第 4 个 = ", r4.status, r4.body?.error);
console.log("settle 后第 5 个 = ", r5.status);
console.log("stats =", JSON.stringify({ kernelTimeouts: st.kernelTimeouts, kernelQueue: st.kernelQueue }));

await plugin_cleanup();

const okTimeout = r1.status === 503 && r2.status === 503
  && /超时/.test(r1.body?.error || "") && /超时/.test(r2.body?.error || "");
const okQueue = r3.status === 503 && /排队超时/.test(r3.body?.error || "")
  && waited3 >= 150 && waited3 < 1000;
const okHeld = r4.status === 503 && /排队超时/.test(r4.body?.error || "");
const okRecover = r5.status === 200;
const okStats = st.kernelTimeouts >= 2 && st.kernelQueue.active === 0
  && st.kernelQueue.waiting === 0 && st.kernelQueue.timeout >= 1;

const pass = okTimeout && okQueue && okHeld && okRecover && okStats;
console.log(pass ? "RESULT=OK" : "RESULT=FAIL");
process.exit(pass ? 0 : 2);
