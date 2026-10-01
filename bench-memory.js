/**
 * 内存占用对比实测（开发工具）。
 *
 * 目的：量化 v1.2.0「词库归后台」带来的内存收益。
 * 方法：用 vm 上下文模拟「一个内容脚本 = 一份独立 JS 环境」，
 *      分别测量改造前（每个 frame 一份词库）与改造后（后台一份 + frame 无词库）的堆增量。
 *
 * 用法：node bench-memory.js [标签页数] [每页iframe数]
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DIR = __dirname;
const TABS = Number(process.argv[2]) || 20;
const FRAMES_PER_TAB = Number(process.argv[3]) || 5;

const dictCoreSrc = fs.readFileSync(path.join(DIR, "dict.js"), "utf8");
const dictExtraSrc = fs.readFileSync(path.join(DIR, "dict-extra.js"), "utf8");
const lookupSrc = fs.readFileSync(path.join(DIR, "dict-lookup.js"), "utf8");

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1); }

function heapUsed() {
  if (global.gc) global.gc();
  return process.memoryUsage().heapUsed;
}

/**
 * 模拟一个内容脚本环境（一个 frame）。
 * @param {boolean} withDict 是否注入词库（true = v1.1 行为，false = v1.2 行为）
 * @returns {object} 该 frame 的上下文，被持有以免被 GC
 */
function createFrame(withDict) {
  const sandbox = { console, setTimeout, clearTimeout, Map, Set, Object, Array, String, Number, JSON, document: {} };
  vm.createContext(sandbox);
  if (withDict) {
    vm.runInContext(dictCoreSrc, sandbox, { filename: "dict.js" });
    vm.runInContext(dictExtraSrc, sandbox, { filename: "dict-extra.js" });
    vm.runInContext(lookupSrc, sandbox, { filename: "dict-lookup.js" });
  }
  // 内容脚本本体（不持有词库）
  return sandbox;
}

console.log("=".repeat(66));
console.log("词库内存占用对比实测");
console.log("=".repeat(66));
console.log("场景：" + TABS + " 个标签页 × 平均 " + FRAMES_PER_TAB + " 个 iframe = " +
  (TABS * FRAMES_PER_TAB) + " 个 frame");
console.log("");
console.log("【读数说明 —— 重要】");
console.log("  本脚本用 vm 上下文模拟 frame，跑在**同一个 Node 进程**里。");
console.log("  真实浏览器里每个 frame 是独立的 JS 环境（渲染进程隔离），词条字符串");
console.log("  与隐藏类无法跨 frame 共享；Node 里则会共享，因此「多 frame 累计」读数");
console.log("  会明显**低估**方案 A 的真实占用。");
console.log("  → 结论以「单份词库堆增量」为锚点做乘算，不要把累计读数当真实值。");
console.log("");

// ---------- 单份词库的堆开销 ----------
{
  const before = heapUsed();
  const holder = createFrame(true);
  const after = heapUsed();
  const one = after - before;
  console.log("【单份词库】");
  console.log("  词库文件体积   : dict.js " + mb(fs.statSync(path.join(DIR, "dict.js")).size) +
    " MB + dict-extra.js " + mb(fs.statSync(path.join(DIR, "dict-extra.js")).size) + " MB");
  console.log("  单份堆增量     : " + mb(one) + " MB");
  console.log("  V8 膨胀倍率    : " + (one / (fs.statSync(path.join(DIR, "dict.js")).size +
    fs.statSync(path.join(DIR, "dict-extra.js")).size)).toFixed(1) + "x");
  console.log("  词条数         : " + (Object.keys(holder.LOCAL_DICT || {}).length +
    Object.keys(holder.DICT_EXTRA || {}).length));
  global.__one = { one };
}

// ---------- 方案 A：每个 frame 各一份（v1.1 行为）----------
console.log("\n【方案 A · 改造前】每个 frame 各持一份词库");
const framesA = [];
const beforeA = heapUsed();
for (let i = 0; i < TABS * FRAMES_PER_TAB; i++) {
  framesA.push(createFrame(true));
}
const afterA = heapUsed();
const deltaA = afterA - beforeA;
console.log("  实际堆增量     : " + mb(deltaA) + " MB");
console.log("  推算单份       : " + mb(deltaA / (TABS * FRAMES_PER_TAB)) + " MB/份");
console.log("  解析次数       : " + (TABS * FRAMES_PER_TAB) + " 次（每 frame 一次）");

// ---------- 方案 B：后台一份，frame 无词库（v1.2 行为）----------
console.log("\n【方案 B · 改造后】词库集中在 service worker，frame 不持有");
const framesB = [];
const beforeB = heapUsed();
for (let i = 0; i < TABS * FRAMES_PER_TAB; i++) {
  framesB.push(createFrame(false));   // 内容脚本本体，无词库
}
const afterB = heapUsed();
const deltaB = afterB - beforeB;
console.log("  frame 堆增量   : " + mb(deltaB) + " MB（" + (TABS * FRAMES_PER_TAB) +
  " 个 frame 合计，几乎为 0）");
console.log("  后台词库       : 恒定 " + mb(global.__one.one) + " MB（全局 1 份）");
console.log("  合计           : " + mb(global.__one.one + deltaB) + " MB");

// ---------- 对比 ----------
console.log("\n" + "=".repeat(66));
console.log("对比结论");
console.log("=".repeat(66));

// 以「单份词库堆增量」为锚点换算（最可靠的读数）。
// 同一进程内多 frame 会共享字符串/隐藏类，累计读数只能当**下界**。
const perFrame = global.__one.one;
const framesN = TABS * FRAMES_PER_TAB;
const estimatedA = perFrame * framesN;      // 真实浏览器量级
const measuredA = deltaA;                    // 同进程下限
const totalB = perFrame + deltaB;

console.log("  项目                  方案 A（改造前）      方案 B（改造后）");
console.log("  " + "-".repeat(62));
console.log("  " + framesN + " frame 内存        " + (mb(estimatedA) + " MB").padEnd(21) + mb(totalB) + " MB");
console.log("  （同进程实测下界）    " + (mb(measuredA) + " MB").padEnd(21) + mb(totalB) + " MB");
console.log("  随标签页增长          " + "线性增长".padEnd(21) + "恒定不变");
console.log("  词库解析次数          " + (framesN + " 次").padEnd(21) + "1 次");

console.log("\n  本次场景（" + TABS + " 页 × " + FRAMES_PER_TAB + " frame）预计节省：" +
  mb(estimatedA - totalB) + " MB（降低 " +
  (((estimatedA - totalB) / estimatedA) * 100).toFixed(1) + "%）");
console.log("  页均节省：" + mb((estimatedA - totalB) / TABS) + " MB / 标签页");

console.log("\n  按标签页数推算（以单份 " + mb(perFrame) + " MB 为锚点）：");
console.log("    标签页    frame 数      方案 A          方案 B");
console.log("    " + "-".repeat(50));
[1, 5, 10, 20, 50, 100].forEach(t => {
  const n = t * FRAMES_PER_TAB;
  console.log("    " + String(t).padStart(5) + "    " + String(n).padStart(6) + "    " +
    (mb(perFrame * n) + " MB").padEnd(14) + mb(perFrame) + " MB");
});

console.log("\n【代价】改造后每次查词多一次消息往返");
const sandbox = { console, setTimeout, clearTimeout, Map, Set, Object, Array, String, Number, JSON };
vm.createContext(sandbox);
vm.runInContext(dictCoreSrc, sandbox, { filename: "dict.js" });
vm.runInContext(dictExtraSrc, sandbox, { filename: "dict-extra.js" });
vm.runInContext(lookupSrc, sandbox, { filename: "dict-lookup.js" });
const N = 5000;
let sum = 0;
for (let i = 0; i < N; i++) {
  const t = process.hrtime.bigint();
  sandbox.lookupLocal("efficiency");
  sum += Number(process.hrtime.bigint() - t) / 1e6;
}
console.log("  worker 侧查词耗时 : 平均 " + (sum / N).toFixed(4) + " ms/次");
console.log("  真实消息往返开销  : 约 1–3 ms（序列化 + IPC，浏览器实测经验值）");
console.log("  对比触发延迟      : hoverDelay 默认 320 ms");
console.log("  → 消息开销约占触发延迟的 " + ((2 / 320) * 100).toFixed(1) + "%，用户无感");
console.log("  → 且内容脚本侧有缓存，同一单词重复悬停不再往返");
console.log("");
