// 取证：同一群并发两次 /api/join 是否会重复提交加群申请
import fs from "node:fs";
import path from "node:path";

// 源码目录默认取仓库里的插件，可用 JOINER_SRC 覆盖（与 queue-check 保持一致）
const SRC = process.env.JOINER_SRC || new URL("../napcat/plugins/napcat-plugin-joiner", import.meta.url).pathname;
const PDIR = "/tmp/joiner-mock/race-plugin";
fs.rmSync(PDIR, { recursive: true, force: true });
fs.mkdirSync(PDIR, { recursive: true });
for (const f of ["index.mjs", "page.html", "package.json"]) {
  fs.copyFileSync(path.join(SRC, f), path.join(PDIR, f));
}
fs.writeFileSync(path.join(PDIR, "history.json"), "", { mode: 0o600 });

const calls = { join: 0, search: 0 };
const ctx = {
  pluginPath: PDIR,
  logger: { info() {}, logError() {}, error() {}, log() {} },
  core: {
    apis: {
      GroupApi: {
        async getGroups() { return { groupList: [] }; },
        async searchGroup(kw) {
          calls.search++;
          await new Promise((r) => setTimeout(r, 300)); // 模拟搜索慢一点，放大竞态窗口
          return { searchGroupInfo: { groupCode: String(kw), groupName: "目标群", groupOption: 2, groupQuestion: "" } };
        },
      },
      MsgApi: {},
    },
    context: {
      session: {
        getGroupService: () => ({
          async reqToJoinGroup() { calls.join++; await new Promise((r) => setTimeout(r, 200)); return { result: 1, errMsg: "" }; },
        }),
      },
    },
  },
};

const { plugin_init, plugin_cleanup } = await import(path.join(PDIR, "index.mjs"));
await plugin_init(ctx);
const tok = fs.readFileSync(path.join(PDIR, "token"), "utf8").trim();
const B = "http://127.0.0.1:19001";

const fire = () => fetch(B + "/api/join", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Joiner-Token": tok },
  body: JSON.stringify({ group: "10000001" }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

const [a, b] = await Promise.all([fire(), fire()]);
console.log("A:", a.status, a.body?.data?.status || a.body?.error);
console.log("B:", b.status, b.body?.data?.status || b.body?.error);
console.log("reqToJoinGroup 实际调用次数 =", calls.join, "（期望 1，实际说明是否去重）");
await plugin_cleanup();
process.exit(calls.join > 1 ? 2 : 0);
