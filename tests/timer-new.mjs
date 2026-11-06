const t0 = Date.now();
process.on("exit", () => console.log("新写法退出耗时:", Date.now() - t0, "ms"));
let timer = null;
const timeout = new Promise((_, r) => { timer = setTimeout(() => r(new Error("x")), 3000); if (timer.unref) timer.unref(); });
Promise.race([Promise.resolve(1), timeout]).finally(() => { if (timer) clearTimeout(timer); }).then(() => console.log("promise 已完成"));
