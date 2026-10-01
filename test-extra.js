/**
 * 扩展词库验证（开发自测，无依赖）。
 *
 * 校验 dict-extra.js（ECDICT 生成）与 content.js 的两级查词逻辑：
 *   1. dict-extra.js 可解析、键全为纯小写字母、无重复键
 *   2. 词条结构完整（t 非空、p/k 为字符串）
 *   3. 精选词库 dict.js 优先于扩展词库（同词条时不被覆盖）
 *   4. 词形还原在扩展词库中同样生效（works -> work 走扩展库）
 *   5. 不污染原型链（__proto__ / constructor / toString 不应命中）
 *   6. 常用词覆盖率抽样（BNC 高频词应有释义）
 *
 * 运行：node test-extra.js
 */
const fs = require("fs");
const path = require("path");
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

// ---------- 载入两个词库 ----------
function loadDict(file, varName) {
  const src = fs.readFileSync(path.join(DIR, file), "utf8")
    .replace(/^(?:const|var|let)\s+(\w+)\s*=/m, "globalThis.$1 =");
  (new Function(src)).call(globalThis);
  return globalThis[varName];
}

const LOCAL_DICT = loadDict("dict.js", "LOCAL_DICT");
const extraPath = path.join(DIR, "dict-extra.js");
const hasExtra = fs.existsSync(extraPath);
const DICT_EXTRA = hasExtra ? loadDict("dict-extra.js", "DICT_EXTRA") : null;

check("dict-extra.js 存在", hasExtra);
check("LOCAL_DICT 可解析", !!LOCAL_DICT && typeof LOCAL_DICT === "object");

if (!hasExtra || !DICT_EXTRA) {
  console.log(log.join("\n"));
  console.log("\n通过 " + pass + " / " + (pass + fail) + "（缺 dict-extra.js，请先运行 build-dict.js）");
  process.exit(1);
}

const coreN = Object.keys(LOCAL_DICT).length;
const extraN = Object.keys(DICT_EXTRA).length;
console.log("精选词库：" + coreN + " 条   扩展词库：" + extraN + " 条   合计：" + (coreN + extraN) + " 条\n");

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

// ---------- 3/4. 两级查词逻辑（复刻 content.js 的 lookupLocal）----------
const IRREGULAR = {
  was: "be", were: "be", been: "be", is: "be", are: "be", am: "be",
  has: "have", had: "have", did: "do", does: "do", done: "do",
  went: "go", gone: "go", made: "make", took: "take", taken: "take",
  gave: "give", given: "give", found: "find", knew: "know", known: "know",
  thought: "think", saw: "see", seen: "see", said: "say", told: "tell",
  became: "become", left: "leave", kept: "keep", began: "begin", begun: "begin",
  ran: "run", brought: "bring", wrote: "write", written: "write",
  stood: "stand", lost: "lose", paid: "pay", met: "meet", led: "lead",
  understood: "understand", spoke: "speak", spoken: "speak", read: "read",
  spent: "spend", grew: "grow", grown: "grow", won: "win", built: "build",
  fell: "fall", sold: "sell", broke: "break", broken: "break",
  ate: "eat", eaten: "eat", caught: "catch", drew: "draw", drawn: "draw",
  chose: "choose", chosen: "choose", children: "child", men: "man",
  women: "woman", feet: "foot", teeth: "tooth", mice: "mouse",
  lives: "life", better: "good", best: "good", worse: "bad", worst: "bad",
  more: "much", most: "much", less: "little", least: "little",
  analyses: "analysis", indices: "index"
};

function lemmatize(word) {
  const w = word.toLowerCase();
  if (IRREGULAR[w]) return IRREGULAR[w];
  if (w.length <= 3) return w;
  const cands = [];
  if (w.endsWith("ies")) cands.push(w.slice(0, -3) + "y");
  if (w.endsWith("ves")) cands.push(w.slice(0, -3) + "f", w.slice(0, -3) + "fe");
  if (w.endsWith("ses") || w.endsWith("xes") || w.endsWith("zes") ||
      w.endsWith("ches") || w.endsWith("shes")) cands.push(w.slice(0, -2));
  if (w.endsWith("es")) cands.push(w.slice(0, -1), w.slice(0, -2));
  if (w.endsWith("s") && !w.endsWith("ss")) cands.push(w.slice(0, -1));
  if (w.endsWith("ying")) cands.push(w.slice(0, -4) + "ie", w.slice(0, -4) + "y");
  if (w.endsWith("ing")) {
    cands.push(w.slice(0, -3), w.slice(0, -3) + "e");
    const stem = w.slice(0, -3);
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) cands.push(stem.slice(0, -1));
  }
  if (w.endsWith("ied")) cands.push(w.slice(0, -3) + "y");
  if (w.endsWith("ed")) {
    cands.push(w.slice(0, -2), w.slice(0, -1));
    const stem = w.slice(0, -2);
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) cands.push(stem.slice(0, -1));
  }
  if (w.endsWith("ier")) cands.push(w.slice(0, -3) + "y");
  if (w.endsWith("iest")) cands.push(w.slice(0, -4) + "y");
  if (w.endsWith("er")) cands.push(w.slice(0, -2), w.slice(0, -1));
  if (w.endsWith("est")) cands.push(w.slice(0, -3), w.slice(0, -2));
  if (w.endsWith("ily")) cands.push(w.slice(0, -3) + "y");
  if (w.endsWith("ly")) cands.push(w.slice(0, -2), w.slice(0, -2) + "e");
  return cands.length ? cands : w;
}

function lookupInDict(dict, key) {
  if (!dict || typeof dict !== "object") return null;
  if (!Object.prototype.hasOwnProperty.call(dict, key)) return null;
  const entry = dict[key];
  return entry && typeof entry === "object" ? entry : null;
}

// 复刻 content.js 的 lookupLocal（含 inflected 标记）
function lookupLocal(raw) {
  const w = raw.toLowerCase();
  const dicts = [LOCAL_DICT, DICT_EXTRA];
  for (const d of dicts) {
    const h = lookupInDict(d, w);
    if (h) return { key: w, entry: h, tier: d === LOCAL_DICT ? "core" : "extra", inflected: false };
  }
  const res = lemmatize(w);
  const cands = typeof res === "string" ? [res] : (Array.isArray(res) ? res : []);
  for (const c of cands) {
    if (!c || c === w) continue;
    for (const d of dicts) {
      const h = lookupInDict(d, c);
      if (h) return { key: c, entry: h, tier: d === LOCAL_DICT ? "core" : "extra", inflected: true };
    }
  }
  return null;
}

// 同键时精选词库应优先
const overlap = keys.filter(k => Object.prototype.hasOwnProperty.call(LOCAL_DICT, k));
check("扩展词库与精选词库无同键冲突", overlap.length === 0,
  overlap.length ? "冲突键示例：" + overlap.slice(0, 5).join(", ") + "（共 " + overlap.length + " 个）" : "");

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
  if (r && r.key === expect) infPass++;
  else infFails.push(input + " → 期望 " + expect + "，实际 " + (r ? r.key : "未命中"));
}
check("词形还原在扩展库生效（" + inflectionCases.length + " 例）",
  infPass === inflectionCases.length, infFails.join("; "));

// 变体形式有独立词条时应"直命中变体"，这也是正确行为（ECDICT 的释义更精确）
const directHit = lookupLocal("negotiated");
check("库里已有变体词条时直命中变体（negotiated 而非 negotiate）",
  !!directHit && directHit.key === "negotiated" && !directHit.inflected,
  directHit ? "实际命中 " + directHit.key : "未命中");

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
