/**
 * 扩展词库验证（开发自测，无依赖）。
 *
 * 校验 dict-extra.js（ECDICT 生成）与两级查词逻辑：
 *   1. dict-extra.js 可解析、键全为纯小写字母、无重复键
 *   2. 词条结构完整（t 非空、p/k 为字符串）
 *   3. 精选词库 dict.js 优先于扩展词库（同词条时不被覆盖）
 *   4. 词形还原在扩展词库中同样生效
 *   5. 不污染原型链（__proto__ / constructor / toString 不应命中）
 *   6. 常用词覆盖率抽样（BNC 高频词应有释义）
 *
 * v1.2.0 起，查词逻辑只保留 **一份实现**（dict-lookup.js）。
 * 本测试直接加载该文件，不再复刻副本 —— 之前 test-extra.js / test-verify.js /
 * content.js 各存一份 lemmatize，改一处要同步三处，是明确的技术债。
 *
 * 运行：node test-extra.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const DIR = __dirname;

let pass = 0, fail = 0;
const log = [];
function check(name, cond, extra) {
  if (cond) { pass++; log.push("  ✓ " + name); }
  else { fail++; log.push("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

console.log("=".repeat(58));
console.log("扩展词库（ECDICT）验证");
console.log("=".repeat(58));

// ---------- 在同一个 vm 上下文中加载「词库 + 查词模块」，复刻后台装配 ----------
const extraPath = path.join(DIR, "dict-extra.js");
const hasExtra = fs.existsSync(extraPath);

const sandbox = { console };
vm.createContext(sandbox);
["dict.js", "dict-extra.js", "dict-lookup.js"].forEach(f => {
  const p = path.join(DIR, f);
  if (!fs.existsSync(p)) return; // dict-extra.js 缺失时后面单独断言
  vm.runInContext(fs.readFileSync(p, "utf8"), sandbox, { filename: f });
});

const LOCAL_DICT = sandbox.LOCAL_DICT;
const DICT_EXTRA = sandbox.DICT_EXTRA;
const lookupInDict = sandbox.lookupInDict;
const lemmatize = sandbox.lemmatize;

check("dict-extra.js 存在", hasExtra);
check("LOCAL_DICT 可解析", !!LOCAL_DICT && typeof LOCAL_DICT === "object");
check("dict-lookup.js 提供 lookupInDict", typeof lookupInDict === "function");
check("dict-lookup.js 提供 lemmatize", typeof lemmatize === "function");

if (!hasExtra || !DICT_EXTRA) {
  console.log(log.join("\n"));
  console.log("\n通过 " + pass + " / " + (pass + fail) + "（缺 dict-extra.js，请先运行 build-dict.js）");
  process.exit(1);
}

// 用共享实现查词（等价于后台 lookupLocal）
const lookupLocal = sandbox.lookupLocal;

const coreN = Object.keys(LOCAL_DICT).length;
const extraN = Object.keys(DICT_EXTRA).length;
console.log("精选词库：" + coreN + " 条   扩展词库：" + extraN + " 条   合计：" + (coreN + extraN) + " 条");
console.log("查词逻辑来源：dict-lookup.js（单一实现，无副本）\n");

check("扩展词库条目数 ≥ 10000", extraN >= 10000, "实际 " + extraN);

// ---------- 1. 键形状 ----------
const keys = Object.keys(DICT_EXTRA);
const badKeys = keys.filter(k => !/^[a-z]{2,24}$/.test(k));
check("键全为纯小写字母且长度 2-24", badKeys.length === 0,
  badKeys.length ? "异常键示例：" + badKeys.slice(0, 5).join(", ") + "（共 " + badKeys.length + " 个）" : "");

// 重复键（生成时是对象字面量，重复键会被 JS 静默覆盖，这里检查源码冗余）
const extraSrc = fs.readFileSync(extraPath, "utf8");
const declared = (extraSrc.match(/["']?([a-z]{2,24})["']?\s*:\s*\{/g) || []).length;
check("扩展词库无重复键声明", declared === extraN,
  "声明 " + declared + " 处，实际键 " + extraN + " 个，差 " + (declared - extraN));

// ---------- 2. 词条结构 ----------
let badStruct = 0, noTrans = 0;
for (const k of keys) {
  const e = DICT_EXTRA[k];
  if (!e || typeof e !== "object") { badStruct++; continue; }
  if (typeof e.t !== "string" || !e.t.trim()) noTrans++;
}
check("所有词条为对象且 t 非空", badStruct === 0 && noTrans === 0,
  "结构异常 " + badStruct + " 个，释义为空 " + noTrans + " 个");

let withPhon = 0;
for (const k of keys) if (DICT_EXTRA[k].k) withPhon++;
check("音标字段覆盖率 > 70%", withPhon / extraN > 0.7,
  (withPhon / extraN * 100).toFixed(1) + "% 带音标");

// 释义长度可控（过长会撑爆气泡）
let tooLong = 0, maxLen = 0;
for (const k of keys) {
  const L = DICT_EXTRA[k].t.length;
  if (L > maxLen) maxLen = L;
  if (L > 60) tooLong++;
}
check("释义长度受控（≤60 字）", tooLong === 0, "最长 " + maxLen + " 字，超限 " + tooLong + " 个");

// ---------- 3/4. 两级查词逻辑（直接来自 dict-lookup.js，非副本）----------
// 同键时精选词库应优先
const overlap = Object.keys(DICT_EXTRA).filter(k => Object.prototype.hasOwnProperty.call(LOCAL_DICT, k));
check("扩展词库与精选词库无同键冲突", overlap.length === 0,
  overlap.length ? "冲突键示例：" + overlap.slice(0, 5).join(", ") + "（共 " + overlap.length + " 个）" : "");

// 同词既在核心库也在扩展库时，tier 必须为 core
{
  const shared = Object.keys(DICT_EXTRA).find(k => Object.prototype.hasOwnProperty.call(LOCAL_DICT, k));
  if (shared) {
    const r = lookupLocal(shared);
    check("同键时精选词库优先（tier=core）", r && r.tier === "core",
      shared + " → " + (r ? r.tier : "未命中"));
  } else {
    check("同键时精选词库优先（无同键数据，跳过）", true);
  }
}

// 词形还原应能在扩展库命中。
//
// 注意：ECDICT 里大量变体形式（negotiated / audited / works …）**本身就有独立词条**，
// 会走"原词直命中"而非词形还原。因此这里专门挑选库里**只有原形、没有变体**的词，
// 才能真正验证还原逻辑。断言只看"是否命中到预期词根"，不管它来自哪个词库。
const inflectionCases = [
  ["procurements", "procurement"],   // 复数：procurement 在库，procurements 不在
  ["depreciated", "depreciate"],     // 过去式：走 -ed 规则
  ["depreciating", "depreciate"],    // 进行时：走 -ing 规则
  ["compliances", "compliance"],     // 复数（-es 规则）
  ["dashboards", "dashboard"],       // 复数
  ["endpoints", "endpoint"],         // 复数
  ["reconciling", "reconcile"],      // 进行时：走 -ing + e 规则
  ["variance", "variance"]           // 原形直查（对照项）
];
let infPass = 0; const infFails = [];
for (const [input, expect] of inflectionCases) {
  const r = lookupLocal(input);
  if (r && r.matched === expect) infPass++;
  else infFails.push(input + " → 期望 " + expect + "，实际 " + (r ? r.matched : "未命中"));
}
check("词形还原在扩展库生效（" + inflectionCases.length + " 例）",
  infPass === inflectionCases.length, infFails.join("; "));

// 变体形式有独立词条时应"直命中变体"，这也是正确行为（ECDICT 的释义更精确）
const directHit = lookupLocal("negotiated");
check("库里已有变体词条时直命中变体（negotiated 而非 negotiate）",
  !!directHit && directHit.matched === "negotiated" && !directHit.inflected,
  directHit ? "实际命中 " + directHit.matched : "未命中");

// ---------- 5. 原型链污染 ----------
// constructor 是 ECDICT 中的真实英文单词（建造者），因此会被收录；
// 关键是不能因为"键名撞上 Object.prototype 的属性"就误命中。
const protoCases = ["__proto__", "tostring", "valueof", "hasownproperty", "isprototypeof"];
const polluted = protoCases.filter(w => lookupLocal(w));
check("不误命中原型链属性", polluted.length === 0,
  polluted.length ? "误命中：" + polluted.join(", ") : "");

// 词库中若确实收录了 constructor，查它应拿到 ECDICT 的英文释义（而非 JS 内置构造函数）
const ctor = lookupLocal("constructor");
check("constructor 命中词库释义而非 JS 内置构造器",
  !ctor || (ctor.entry && typeof ctor.entry.t === "string"),
  "命中了非词条对象，说明原型链污染");
// 查一个既不在词库、也不在原型链上的词，应为 null
check("词库与原型链都无的词返回 null", lookupLocal("zzzzqqq") === null);

// ---------- 6. 高频词覆盖率抽样 ----------
// 这些是英文技术/商务文档中的常见词，扩展后应当都有释义
const coverage = [
  "cache", "runtime", "latency", "throughput", "deploy", "cluster",
  "schema", "migration", "rollback", "webhook", "token", "endpoint",
  "quota", "pipeline", "artifact", "dashboard", "tenant", "sla",
  "invoice", "procurement", "inventory", "ledger", "depreciation", "audit",
  "compliance", "reimbursement", "payroll", "vendor", "quotation", "reconcile"
];
const missing = coverage.filter(w => !lookupLocal(w));
check("技术/商务高频词覆盖 ≥ 28/" + coverage.length, coverage.length - missing.length >= 28,
  "未收录：" + missing.join(", "));

// ---------- 抽样展示 ----------
console.log(log.join("\n"));

console.log("\n扩展词库抽样：");
["cache", "runtime", "latency", "procurement", "depreciation", "reconcile", "negotiated", "audited"]
  .forEach(w => {
    const r = lookupLocal(w);
    if (r) {
      console.log("  " + w.padEnd(14) + "[" + (r.entry.p || "-") + "] " + r.entry.t +
        (r.entry.k ? "  /" + r.entry.k + "/" : "") + "  (" + r.tier + ")");
    } else {
      console.log("  " + w.padEnd(14) + "未收录 → 在线兜底");
    }
  });

console.log("\n通过 " + pass + " / " + (pass + fail));
console.log(fail === 0 ? "\n全部通过 ✓" : "\n存在失败项 ✗");
process.exit(fail === 0 ? 0 : 1);
