// 验证：cleanup 关闭端口 + 可重复 init（老版本这里会 EADDRINUSE 静默失败）
import fs from "node:fs";

const PDIR = "/tmp/joiner-mock/plugin";
const tok = fs.readFileSync(PDIR + "/token", "utf8").trim();
const mkCtx = () => ({
  pluginPath: PDIR,
  logger: { info() {}, logError() {} },
  core: {
    apis: { GroupApi: { async getGroups() { return { groupList: [] }; } } },
    context: { session: { getGroupService: () => ({}) } },
  },
});

const m = await import(PDIR + "/index.mjs");
await m.plugin_init(mkCtx());
await new Promise((r) => setTimeout(r, 300));

let got;
try {
  const r = await fetch("http://127.0.0.1:19001/api/groups", { headers: { "X-Joiner-Token": tok } });
  got = r.status;
} catch (e) { got = "ERR:" + e.cause?.code; }
console.log("init 后首次请求:", got);

await m.plugin_cleanup();
await new Promise((r) => setTimeout(r, 100));
try {
  await fetch("http://127.0.0.1:19001/api/groups", { headers: { "X-Joiner-Token": tok } });
  console.log("cleanup 后: 仍可连接（未关闭，BAD）");
} catch (e) {
  console.log("cleanup 后: 连接被拒（已关闭，", e.cause?.code ?? "refused", "）");
}

// 同一个模块实例上二次 init：若旧 server 还活着会 EADDRINUSE → 页面 502
await m.plugin_init(mkCtx());
await new Promise((r) => setTimeout(r, 300));
const r2 = await fetch("http://127.0.0.1:19001/api/groups", { headers: { "X-Joiner-Token": tok } });
console.log("二次 init 后:", r2.status === 200 ? "可服务（端口复用成功）" : "失败 " + r2.status);
await m.plugin_cleanup();