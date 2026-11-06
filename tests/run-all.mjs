// 一条命令跑完全部回归：mock 套件 + 竞态取证 + 排队取证。
// 用法：npm test   或   node tests/run-all.mjs
//
// 为什么需要这一层：
//   - mock 套件不自己拷源码（JOINER_DIR 指向临时目录），漏拷就会拿旧代码测；
//   - 三个脚本都抢 19001，上一个异常退出留下的监听会让下一个直接失败；
//   - 失败要能一眼看出是哪一段挂的，所以每段单独报结果，最后汇总。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "napcat", "plugins", "napcat-plugin-joiner");
const PDIR = "/tmp/joiner-mock/plugin";
const PORT = 19001;

// 清掉上一次残留的监听进程（端口占用是这类本地回归最常见的假失败）
function freePort() {
  const r = spawnSync("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  for (const pid of (r.stdout || "").split(/\s+/).filter(Boolean)) {
    try { process.kill(Number(pid), "SIGKILL"); } catch { /* 已退出 */ }
  }
}

function step(label, script, args, env) {
  freePort();
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(process.execPath, [script, ...args], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  return r.status === 0;
}

// 每次都用仓库里的最新源码铺一份，避免测到上一次的残留文件
fs.rmSync(PDIR, { recursive: true, force: true });
fs.mkdirSync(PDIR, { recursive: true });
for (const f of ["index.mjs", "page.html", "package.json"]) {
  fs.copyFileSync(path.join(SRC, f), path.join(PDIR, f));
}

const results = [];
results.push(["mock 回归", step("mock 回归（36 用例）", path.join(here, "mock.test.mjs"),
  ["--test", "--test-force-exit", "--test-timeout=30000", "--test-reporter=spec"],
  { JOINER_DIR: PDIR })]);
results.push(["竞态取证", step("竞态取证（race-check）", path.join(here, "race-check.mjs"), [], { JOINER_SRC: SRC })]);
results.push(["排队取证", step("排队取证（queue-check）", path.join(here, "queue-check.mjs"), [], { JOINER_SRC: SRC })]);

console.log("\n=== 汇总 ===");
for (const [name, ok] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
const allOk = results.every(([, ok]) => ok);
console.log(allOk ? "\n全部通过" : "\n有失败，见上面各段输出");
process.exit(allOk ? 0 : 2);
