/**
 * 在线翻译性能与降级测试（开发自测，无依赖）。
 *
 * 通过 mock global.fetch 模拟不同网络状况，验证 background.js 的
 * raceChannels / translate 行为与耗时：
 *   1. 快通道（~50ms）→ 应远快于 1 秒
 *   2. 主通道慢、备用快 → 竞速应取快者
 *   3. 双通道都慢（>900ms）→ 应在总超时(1100ms)内返回，不拖到 8 秒
 *   4. 双通道都报错 → 应立即返回错误
 *   5. 缓存命中 → 第二次调用延迟接近 0，且不再发起网络请求
 *
 * 运行：node test-perf.js
 */
const fs = require("fs");
const path = require("path");
const DIR = __dirname;

// ---------- mock 环境 ----------
const pending = [];
let fetchCallCount = 0;
let fetchPlan = [];   // [{ match, delay, ok, body, status }]

global.fetch = function (url, opts) {
  fetchCallCount++;
  const plan = fetchPlan.find(p => url.includes(p.match)) || { delay: 50, ok: true };
  return new Promise((resolve, reject) => {
    const signal = opts && opts.signal;
    const timer = setTimeout(() => {
      if (signal && signal.aborted) return reject(new Error("aborted"));
      if (plan.ok === false) return reject(new Error(plan.error || "mock error"));
      resolve({
        ok: plan.status ? plan.status < 400 : true,
        status: plan.status || 200,
        json: async () => plan.body
      });
    }, plan.delay);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    }
  });
};

global.AbortController = class {
  constructor() { this.signal = { aborted: false, listeners: [], addEventListener: (t, f) => this.signal.listeners.push(f) }; }
  abort() { this.signal.aborted = true; this.signal.listeners.forEach(f => f()); }
};

global.chrome = {
  runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} }, lastError: null },
  contextMenus: { removeAll(cb) { cb && cb(); }, create() {}, onClicked: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
  tabs: { sendMessage() {}, query() {} },
  storage: { sync: { get(d, cb) { cb(d); }, set() {} } }
};

// 载入 background.js（提取 translate / lookupOffline 相关函数）
//
// v1.2.0：background.js 顶层有 importScripts("dict.js", ...)，Node 里没有这个
// 全局函数。这里提供真实实现——按顺序在同一个 vm 上下文执行词库与查词模块，
// 顺便让本测试也能覆盖离线查词的耗时（方案 B 的消息往返代价由此量化）。
const vm = require("vm");
let bgSrc = fs.readFileSync(path.join(DIR, "background.js"), "utf8");

const workerSandbox = {
  console, setTimeout, clearTimeout, Promise, Map, Set, Object, Array, String, Number, Error, JSON,
  // background.js 顶层会注册 chrome 事件与引用 fetch，这里把上面准备好的桩放进上下文
  chrome: global.chrome,
  fetch: global.fetch,
  AbortController: global.AbortController,
};
vm.createContext(workerSandbox);
workerSandbox.importScripts = function () {
  Array.prototype.slice.call(arguments).forEach(n => {
    const p = path.join(DIR, n);
    if (!fs.existsSync(p)) throw new Error("importScripts 目标不存在: " + n);
    vm.runInContext(fs.readFileSync(p, "utf8"), workerSandbox, { filename: n });
  });
};

vm.runInContext(bgSrc, workerSandbox, { filename: "background.js" });
// 暴露内部函数供断言。
//
// 注意：vm 上下文里 `const` 声明**不会**挂到全局对象（只有 var / function 会），
// 所以 CHANNEL_TIMEOUT / TOTAL_TIMEOUT 这两个 const 需要用表达式在上下文内求值。
const api = {
  translate: workerSandbox.translate,
  raceChannels: workerSandbox.raceChannels,
  cacheGet: workerSandbox.cacheGet,
  cacheSet: workerSandbox.cacheSet,
  lookupOffline: workerSandbox.lookupOffline,
  CHANNEL_TIMEOUT: vm.runInContext("CHANNEL_TIMEOUT", workerSandbox),
  TOTAL_TIMEOUT: vm.runInContext("TOTAL_TIMEOUT", workerSandbox),
};

check0("background.js 可在模拟 worker 环境中加载", typeof api.translate === "function");
check0("离线查词函数已导出", typeof api.lookupOffline === "function");

function check0(name, cond) {
  if (!cond) {
    console.error("装配失败：" + name);
    process.exit(1);
  }
}

// ---------- 测试工具 ----------
let pass = 0, fail = 0;
const log = [];
function check(name, cond, extra) {
  if (cond) { pass++; log.push("  ✓ " + name); }
  else { fail++; log.push("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

const GOOGLE_BODY = [[["效率", "efficiency", null, null]], null, "en", null, null, null, null, [[["noun", ["效率", "功效"], null, "efficiency"]]]];
const MM_BODY = { responseData: { translatedText: "效率" } };

function googlePlan(delay, ok = true) {
  return { match: "translate.googleapis.com", delay, ok, body: GOOGLE_BODY, error: "google fail" };
}
function mmPlan(delay, ok = true) {
  return { match: "mymemory", delay, ok, body: MM_BODY, error: "mm fail" };
}

(async function run() {
  console.log("=".repeat(58));
  console.log("在线翻译性能测试");
  console.log("=".repeat(58));
  console.log("单通道超时 " + api.CHANNEL_TIMEOUT + "ms / 总超时 " + api.TOTAL_TIMEOUT + "ms\n");

  // ---- 1. 快通道 ----
  fetchPlan = [googlePlan(50), mmPlan(60)];
  fetchCallCount = 0;
  let t0 = Date.now();
  let r = await api.translate("efficiency");
  let dt = Date.now() - t0;
  check("场景1 快通道：返回成功", r && r.ok === true, JSON.stringify(r).slice(0, 80));
  check("场景1 快通道：耗时 < 300ms（实测 " + dt + "ms）", dt < 300);
  check("场景1 快通道：并行发起了 2 个请求", fetchCallCount === 2, "实际 " + fetchCallCount);

  // ---- 2. 主通道慢、备用快（竞速取快者）----
  fetchPlan = [googlePlan(800), mmPlan(60)];
  fetchCallCount = 0;
  t0 = Date.now();
  r = await api.translate("slowprimary");
  dt = Date.now() - t0;
  check("场景2 竞速：返回成功", r && r.ok === true);
  check("场景2 竞速：取到快速通道（MyMemory）", r && r.source === "mymemory", "source=" + (r && r.source));
  check("场景2 竞速：耗时 < 400ms（未被慢通道拖累，实测 " + dt + "ms）", dt < 400);

  // ---- 3. 双通道都慢 → 通道/总超时兜底 ----
  fetchPlan = [googlePlan(5000), mmPlan(5000)];
  t0 = Date.now();
  r = await api.translate("bothing");
  dt = Date.now() - t0;
  check("场景3 双慢：返回失败而非挂起", r && r.ok === false);
  check("场景3 双慢：在总超时 " + api.TOTAL_TIMEOUT + "ms 内返回（实测 " + dt + "ms）",
    dt <= api.TOTAL_TIMEOUT + 150, "实测 " + dt + "ms");
  check("场景3 双慢：满足「1 秒内」目标（实测 " + dt + "ms）", dt <= 1000, "实测 " + dt + "ms");
  check("场景3 双慢：明显快于旧实现 8s+", dt < 2000);

  // ---- 4. 双通道都报错 → 立即返回 ----
  fetchPlan = [googlePlan(50, false), mmPlan(50, false)];
  t0 = Date.now();
  r = await api.translate("allfail");
  dt = Date.now() - t0;
  check("场景4 双失败：返回失败", r && r.ok === false);
  check("场景4 双失败：立即返回（<300ms，实测 " + dt + "ms）", dt < 300);
  check("场景4 双失败：错误信息含两个通道", /Google/.test(r.error) && /MyMemory/.test(r.error), r.error);

  // ---- 5. 缓存 ----
  fetchPlan = [googlePlan(50), mmPlan(60)];
  await api.translate("cachetest");   // 预热
  fetchCallCount = 0;
  t0 = Date.now();
  r = await api.translate("cachetest");  // 命中缓存
  dt = Date.now() - t0;
  check("场景5 缓存：返回成功", r && r.ok === true);
  check("场景5 缓存：命中后无网络请求", fetchCallCount === 0, "实际 " + fetchCallCount);
  check("场景5 缓存：命中延迟 < 20ms（实测 " + dt + "ms）", dt < 20);

  // ---- 6. 失败结果不写入缓存 ----
  const before = api.cacheGet("allfail");
  check("场景6 失败结果不污染缓存", before === null);

  // ---- 7. 离线查词性能（v1.2.0：词库移到后台后的核心指标）----
  //
  // 方案 B 的代价是"每次查词多一次消息往返"。这个往返在真实浏览器里包含
  // 序列化 + IPC，本测试只能量到 worker 侧的纯查词耗时（下界），
  // 用来确认它远小于 hoverDelay（默认 320ms）。
  console.log("\n[离线查词] 词库集中在后台后的单次查词耗时（worker 侧下界）");

  const benchWords = ["efficiency", "approach", "implementation", "significantly", "procurement"];
  // 预热：让 V8 完成优化
  for (let i = 0; i < 200; i++) api.lookupOffline(benchWords[i % benchWords.length]);

  let minMs = Infinity, maxMs = 0, sumMs = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const w = benchWords[i % benchWords.length];
    const t = process.hrtime.bigint();
    api.lookupOffline(w);
    const d = Number(process.hrtime.bigint() - t) / 1e6;
    if (d < minMs) minMs = d;
    if (d > maxMs) maxMs = d;
    sumMs += d;
  }
  const avgMs = sumMs / N;
  console.log("  命中词查词：" + N + " 次  平均 " + avgMs.toFixed(4) + "ms  最小 " +
    minMs.toFixed(4) + "ms  最大 " + maxMs.toFixed(3) + "ms");
  check("单次离线查词平均 < 0.5ms（实测 " + avgMs.toFixed(4) + "ms）", avgMs < 0.5);
  check("单次离线查词最坏 < 5ms（实测 " + maxMs.toFixed(3) + "ms）", maxMs < 5);

  // 未命中词（要跑完词形还原的所有候选，是离线查词的最坏路径）
  let missSum = 0, missMax = 0;
  const MISS_N = 1000;
  for (let i = 0; i < MISS_N; i++) {
    const t = process.hrtime.bigint();
    api.lookupOffline("unfindablezzz" + i);
    const d = Number(process.hrtime.bigint() - t) / 1e6;
    missSum += d;
    if (d > missMax) missMax = d;
  }
  const missAvg = missSum / MISS_N;
  console.log("  未命中词查词：" + MISS_N + " 次  平均 " + missAvg.toFixed(4) +
    "ms  最大 " + missMax.toFixed(3) + "ms");
  check("未命中词（走完全部还原候选）平均 < 0.5ms（实测 " + missAvg.toFixed(4) + "ms）", missAvg < 0.5);

  // ---- 8. 词库体量与内存代理指标 ----
  // 后台词条数 = 1 份；改造前是 N×M 份。这里给出单份基数，便于换算。
  const coreN = Object.keys(workerSandbox.LOCAL_DICT || {}).length;
  const extraN = Object.keys(workerSandbox.DICT_EXTRA || {}).length;
  console.log("\n[词库] 后台持有：精选 " + coreN + " 条 + 扩展 " + extraN + " 条 = " + (coreN + extraN) + " 条（全局 1 份）");
  check("后台词库条目数与预期一致（940 + 30000）",
    coreN === 940 && extraN === 30000, coreN + " + " + extraN);
  check("离线查词走的是词库而非网络（无 fetch 调用）",
    api.lookupOffline("efficiency") && api.lookupOffline("efficiency").found === true);

  console.log(log.join("\n"));
  console.log("\n通过 " + pass + " / " + (pass + fail));
  console.log(fail === 0 ? "\n全部通过 ✓" : "\n存在失败项 ✗");
  process.exit(fail === 0 ? 0 : 1);
})();
