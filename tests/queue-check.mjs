// 取证：内核排队上限（JOINER_KERNEL_WAIT_MS）到点后是否立即 503，且不占住槽位。
// 用法：node queue-check.mjs
// 期望：第 3 个请求 ~300ms 拿到 503「排队超时」；慢请求结束后第 4 个请求仍能 200。
import fs from "node:fs";
import path from "node:path";

const SRC = process.env.JOINER_SRC || new URL("../napcat/plugins/napcat-plugin-joiner", import.meta.url).pathname;
const PDIR = "/tmp/joiner-mock/queue-plugin";

fs.rmSync(PDIR, { recursive: true, force: true });
fs.mkdirSync(PDIR, { recursive: true });
for (const f of ["index.mjs", "page.html", "package.json"]) {
  fs.copyFileSync(path.join(SRC, f), path.join(PDIR, f));
}
fs.writeFileSync(path.join(PDIR, "history.json"), "", { mode: 0o600 });

process.env.JOINER_KERNEL_WAIT_MS = "300"; // 排队上限压到 300ms，便于观测

const state = { delay: 1200 };
const ctx = {
  pluginPath: PDIR,
  logger: { info() {}, logError() {}, error() {}, log() {} },
  core: {
    apis: {
      GroupApi: {
        async getGroups() { return { groupList: [] }; },
        async searchGroup(kw) {
          await new Promise((r) => setTimeout(r, state.delay));
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
const p3 = fire("10000003");                  // 进队列 → 300ms 后应超时
const r3 = await p3;
const waited = Date.now() - t0;

const [r1, r2] = await Promise.all([p1, p2]);
state.delay = 0;
const r4 = await fire("10000004");            // 槽位没被泄漏，应立即成功

const st = (await (await fetch(B + "/api/stats", { headers: { "X-Joiner-Token": tok } })).json()).data;

console.log("第 3 个（排队）= ", r3.status, r3.body?.error || r3.body?.data?.groupName, `等待 ${waited}ms`);
console.log("慢请求 1/2  = ", r1.status, r2.status);
console.log("队列超时后第 4 个 = ", r4.status);
console.log("stats.kernelQueue =", JSON.stringify(st.kernelQueue));

await plugin_cleanup();

const okWait = r3.status === 503 && /排队超时/.test(r3.body?.error || "");
const okTime = waited >= 250 && waited < 1000;
const okDrain = r1.status === 200 && r2.status === 200;
const okNoLeak = r4.status === 200;
const okCount = st.kernelQueue.timeout >= 1 && st.kernelQueue.waiting === 0;

console.log(okWait && okTime && okDrain && okNoLeak && okCount ? "RESULT=OK" : "RESULT=FAIL");
process.exit(okWait && okTime && okDrain && okNoLeak && okCount ? 0 : 2);
