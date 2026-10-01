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

// 载入 background.js（提取 translate 相关函数）
let bgSrc = fs.readFileSync(path.join(DIR, "background.js"), "utf8");
// 去掉对 chrome 事件注册的副作用调用（监听器注册是幂等的，但避免干扰）
const sandbox = { module: { exports: {} } };
const loader = new Function("chrome", "fetch", "AbortController",
  bgSrc + "\n; return { translate, raceChannels, cacheGet, cacheSet, CHANNEL_TIMEOUT, TOTAL_TIMEOUT };");

const api = loader(global.chrome, global.fetch, global.AbortController);

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

  console.log(log.join("\n"));
  console.log("\n通过 " + pass + " / " + (pass + fail));
  console.log(fail === 0 ? "\n全部通过 ✓" : "\n存在失败项 ✗");
  process.exit(fail === 0 ? 0 : 1);
})();
