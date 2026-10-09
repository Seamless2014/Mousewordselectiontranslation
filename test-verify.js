/**
 * 本地验证脚本（仅用于开发自测，非扩展运行时依赖）。
 * 校验：词库完整性、词形还原正确性、气泡渲染数据结构。
 *
 * v1.2.0 起，词形还原与查词逻辑只保留一份实现（dict-lookup.js）。
 * 本测试直接加载该文件，不再复刻副本 —— 之前这里有 60 行重复代码，
 * 与 content.js / test-extra.js 的实现漂移风险很高。
 *
 * 运行： node test-verify.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const DIR = __dirname;

// 在同一个上下文中按后台装配顺序加载：词库 -> 查词模块
const sandbox = { console };
vm.createContext(sandbox);
["dict.js", "dict-extra.js", "dict-lookup.js"].forEach(f => {
  const p = path.join(DIR, f);
  if (!fs.existsSync(p)) {
    if (f === "dict-extra.js") return; // 可选
    console.error("缺少文件：" + f);
    process.exit(1);
  }
  vm.runInContext(fs.readFileSync(p, "utf8"), sandbox, { filename: f });
});

if (!sandbox.LOCAL_DICT) {
  console.error("词库加载失败");
  process.exit(1);
}
const LOCAL_DICT = sandbox.LOCAL_DICT;
const lookupLocal = sandbox.lookupLocal;
const buildLocalResult = sandbox.buildLocalResult;

if (typeof lookupLocal !== "function" || typeof buildLocalResult !== "function") {
  console.error("dict-lookup.js 未正确导出 lookupLocal / buildLocalResult");
  process.exit(1);
}

// ---- 测试用例：输入 -> 期望命中的词条键 ----
//
// 注意（v1.1 起词库为两级）：
//  ECDICT 扩展库里大量变体形式**本身就有独立词条**（running / generated /
//  children / matched / provided …），查它们会"原词直命中"而不是词形还原。
//  这是正确行为——ECDICT 对这些变体给的释义往往比词根更贴切（例如 running
//  直接给"赛跑；流出；运转"）。因此本组用例只保留"变体不在库、必须靠还原"的词，
//  用它来验证还原逻辑真的活着。
const CASES = [
  ["analysis", "analysis"], ["analyses", "analysis"],
  ["implementations", "implementation"], ["configurations", "configuration"],
  ["studies", "study"], ["libraries", "library"],
  ["requirements", "requirement"], ["variables", "variable"],
  ["methods", "method"], ["words", "word"],
  ["compiled", "compile"], ["deployed", "deploy"],
  ["optimize", "optimize"], ["robust", "robust"],
  ["interface", "interface"], ["hypothesis", "hypothesis"],
  ["data", "data"], ["efficiency", "efficiency"],
  ["significantly", "significantly"], ["discussed", "discuss"],
  ["creating", "create"], ["effective", "effective"],
  ["sequential", "sequential"], ["maintains", "maintain"]
];

let pass = 0, fail = 0;
const fails = [];
for (const [input, expect] of CASES) {
  const r = lookupLocal(input);
  const got = r ? r.matched : null;
  if (got === expect) { pass++; }
  else { fail++; fails.push(`  ${input.padEnd(18)} 期望 ${expect}  实际 ${got || "未命中"}`); }
}

console.log("=".repeat(56));
console.log("本地词库与词形还原验证");
console.log("=".repeat(56));
console.log("词库条目数：" + Object.keys(LOCAL_DICT).length +
  "（查词实现来自 dict-lookup.js）");
console.log("测试用例：" + CASES.length + "  通过 " + pass + "  失败 " + fail);
if (fails.length) {
  console.log("\n失败明细：");
  fails.forEach(f => console.log(f));
}

// 抽样展示
console.log("\n抽样命中效果：");
["analyses", "running", "studies", "implementations", "children", "libraries", "significantly"]
  .forEach(w => {
    const r = lookupLocal(w);
    if (r) {
      const e = r.entry;
      const tag = r.inflected && r.matched !== w ? `（原形 ${r.matched}）` : "";
      console.log("  " + w.padEnd(18) + "[" + (e.p || "-") + "] " + e.t + tag);
    } else {
      console.log("  " + w.padEnd(18) + "未收录 → 走在线兜底");
    }
  });

// ---- 渲染结构验证（buildLocalResult 是内容脚本真正拿到的数据）----
console.log("\n气泡渲染数据结构（后台返回给内容脚本的形态）：");
const shapeCases = ["efficiency", "implementations"];
let shapeOk = 0;
for (const w of shapeCases) {
  const r = lookupLocal(w);
  if (!r) continue;
  const res = buildLocalResult(r);
  const ok = res.source === "local" &&
    typeof res.display === "string" &&
    Array.isArray(res.groups) && res.groups.length > 0 &&
    res.groups.every(g => typeof g.pos === "string" && typeof g.text === "string") &&
    typeof res.plain === "string" &&
    (res.tier === "core" || res.tier === "extra");
  if (ok) shapeOk++;
  console.log("  " + w.padEnd(18) + (ok ? "结构完整 ✓" : "结构异常 ✗") +
    "   tier=" + res.tier + "  groups=" + res.groups.length +
    "  phonetic=" + JSON.stringify(res.phonetic || ""));
}
const shapeFail = shapeCases.length - shapeOk;
if (shapeFail) { fail += shapeFail; }
else { pass++; }

// 未收录词检查（应走在线）。
// 注意：quantum / heuristic 这类词已被 3 万词扩展库收录（走本地命中更省钱），
// 所以这里只留真正查不到的词形——随机串与极少见的专名。
const unknown = ["zzzzqqq", "qwertyx", "blorptastic"];
console.log("\n未收录词（预期走在线兜底）：");
let unknownMiss = 0;
unknown.forEach(w => {
  const hit = lookupLocal(w);
  if (!hit) unknownMiss++;
  console.log("  " + w.padEnd(14) + (hit ? "意外命中 " + hit.matched : "未收录 ✓"));
});
if (unknownMiss === unknown.length) pass++;
else { fail++; fails.push("未收录词断言失败 " + unknownMiss + "/" + unknown.length); }

// ---- 正向锁定"变体直命中"行为 ----
// 这些词在 ECDICT 里有独立词条，应当直命中自身（inflected=false），
// 而不是被还原成词根。锁住它，避免将来有人改坏还原优先级。
console.log("\n变体形式有独立词条时直命中（正确行为，非缺陷）：");
let directOk = 0;
const directCases = ["running", "generated", "children", "matched", "provided"];
for (const w of directCases) {
  const r = lookupLocal(w);
  const isDirect = !!r && r.matched === w && !r.inflected;
  if (isDirect) directOk++;
  console.log("  " + w.padEnd(14) + (isDirect ? "直命中 ✓" : "被还原为 " + (r ? r.matched : "未命中") + " ✗") +
    (r ? "   → " + String(r.entry.t).slice(0, 30) : ""));
}
if (directOk === directCases.length) pass++;
else { fail++; fails.push("变体直命中用例失败 " + directOk + "/" + directCases.length); }

// ---- 连字符合成词拆词（v1.2.1）----
// 词库只收纯字母词，decision-maker 这类合成词整词查不到，原实现直接掉进
// 在线兜底，而在线通道在国内网络经常超时（表现为"有时报错、再悬停又正常"）。
// 拆词后各段全命中则本地合成释义，不再依赖网络。
console.log("\n连字符合成词拆词（本地合成，不走网络）：");
let compoundOk = 0;
const compoundCases = [
  // [输入, 期望段数, 期望各段至少都有释义]
  ["decision-maker", 2], ["real-time", 2], ["well-known", 2], ["mother-in-law", 3]
];
for (const [w, nParts] of compoundCases) {
  const r = lookupLocal(w);
  const ok = !!r && !!r.compound && r.compound.length === nParts &&
    r.compound.every(x => x.hit && x.hit.entry && String(x.hit.entry.t || "").trim());
  const res = ok ? buildLocalResult(r) : null;
  const shapeOk2 = res && res.tier === "compound" && res.groups.length === nParts &&
    res.groups.every(g => g.pos && g.text);
  if (ok && shapeOk2) compoundOk++;
  console.log("  " + w.padEnd(16) + (ok && shapeOk2
    ? "拆词命中 ✓  " + res.groups.map(g => g.pos + " " + g.text).join(" ｜ ")
    : "失败 ✗"));
}
if (compoundOk === compoundCases.length) pass++;
else { fail++; fails.push("合成词拆词用例失败 " + compoundOk + "/" + compoundCases.length); }

// 拆词的边界：任一段未命中就放弃（保持在线兜底），不硬凑释义
console.log("\n拆词边界（段未命中 → 维持在线兜底）：");
let boundaryOk = 0;
const boundaryCases = ["e-mail", "zzzz-qqq", "decision-makersx-blah"];
for (const w of boundaryCases) {
  const r = lookupLocal(w);
  const ok = !r || !r.compound; // 不应产生合成结果
  if (ok) boundaryOk++;
  console.log("  " + w.padEnd(22) + (ok ? "未合成 ✓" : "意外合成 ✗"));
}
if (boundaryOk === boundaryCases.length) pass++;
else { fail++; fails.push("拆词边界用例失败 " + boundaryOk + "/" + boundaryCases.length); }

console.log("\n通过 " + pass + " / " + (pass + fail));
console.log("\n" + (fail === 0 ? "全部通过 ✓" : "存在失败项 ✗"));
process.exit(fail === 0 ? 0 : 1);
