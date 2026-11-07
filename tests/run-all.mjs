// 一条命令跑完全部回归：mock 套件 + 竞态取证 + 排队取证 + 重登策略。
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

// 清掉上一次残留的监听进程（端口占用是这类本地回归最常见的假失败）。
// 只杀 node 进程：19001 在生产上可能是 docker-proxy，误杀会中断线上端口转发。
// 没有 lsof 时不要静默继续——否则失败会呈现为莫名其妙的 EADDRINUSE。
function freePort() {
  const r = spawnSync("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  if (r.error) {
    console.log(`警告：没有可用的 lsof，无法清理 :${PORT} 的残留监听；若本段失败请手动检查端口`);
    return;
  }
  for (const pid of (r.stdout || "").split(/\s+/).filter(Boolean)) {
    const p = spawnSync("ps", ["-p", pid, "-o", "comm="], { encoding: "utf8" });
    const comm = String(p.stdout || "").trim();
    if (!/node/i.test(comm)) {
      console.log(`警告：:${PORT} 被非 node 进程占用（pid=${pid} ${comm || "?"}），不杀它，跳过`);
      continue;
    }
    try { process.kill(Number(pid), "SIGKILL"); } catch { /* 已退出 */ }
  }
}

function step(label, script, args, env, bin) {
  freePort();
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(bin || process.execPath, [script, ...args], {
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
results.push(["mock 回归", step("mock 回归（43 用例）", path.join(here, "mock.test.mjs"),
  ["--test", "--test-force-exit", "--test-timeout=120000", "--test-reporter=spec"],
  { JOINER_DIR: PDIR })]);
results.push(["竞态取证", step("竞态取证（race-check）", path.join(here, "race-check.mjs"), [], { JOINER_SRC: SRC })]);
results.push(["排队取证", step("排队取证（queue-check）", path.join(here, "queue-check.mjs"), [], { JOINER_SRC: SRC })]);
results.push(["超时取证", step("超时取证（timeout-check）", path.join(here, "timeout-check.mjs"), [], { JOINER_SRC: SRC })]);

// 重登策略是 Python：默认必须真跑。只有显式 ALLOW_PY_SKIP=1 才允许跳过，
// 否则「本机没装 python3」会被当成通过，等于静默丢掉一段回归。
const py = spawnSync("python3", ["-c", "print(1)"], { encoding: "utf8" });
if (py.status === 0) {
  results.push(["重登策略", step("重登策略（relogin-check）", path.join(here, "relogin-check.py"), [], {}, "python3")]);
} else {
  const allowSkip = process.env.ALLOW_PY_SKIP === "1";
  console.log("\n=== 重登策略（relogin-check）===\n" +
    (allowSkip ? "跳过：本机没有 python3（ALLOW_PY_SKIP=1）" : "失败：本机没有 python3；如需临时跳过请设 ALLOW_PY_SKIP=1"));
  results.push(["重登策略", allowSkip]);
}

console.log("\n=== 汇总 ===");
for (const [name, ok] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
const allOk = results.every(([, ok]) => ok);
console.log(allOk ? "\n全部通过" : "\n有失败，见上面各段输出");
process.exit(allOk ? 0 : 2);
