const t0 = Date.now();
process.on("exit", () => console.log("旧写法退出耗时:", Date.now() - t0, "ms"));
Promise.race([Promise.resolve(1), new Promise((_, r) => setTimeout(() => r(new Error("x")), 3000))]).then(() => console.log("promise 已完成"));
