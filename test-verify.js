/**
 * 本地验证脚本（仅用于开发自测，非扩展运行时依赖）。
 * 校验：词库完整性、词形还原正确性、气泡渲染数据结构。
 * 运行： node test-verify.js
 */
const fs = require("fs");
const path = require("path");

// 载入词库到全局：把顶层 const 声明改写为全局赋值，使其可在本模块内直接访问
const dictSrc = fs
  .readFileSync(path.join(__dirname, "dict.js"), "utf8")
  .replace(/^(?:const|var|let)\s+LOCAL_DICT\s*=/m, "globalThis.LOCAL_DICT =");
(new Function(dictSrc)).call(globalThis);
if (!globalThis.LOCAL_DICT) {
  console.error("词库加载失败");
  process.exit(1);
}
const LOCAL_DICT = globalThis.LOCAL_DICT;

// 从 content.js 中抽取还原逻辑进行验证（复制而非导入，避免 DOM 依赖）
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
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      cands.push(stem.slice(0, -1));
    }
  }
  if (w.endsWith("ied")) cands.push(w.slice(0, -3) + "y");
  if (w.endsWith("ed")) {
    cands.push(w.slice(0, -2), w.slice(0, -1));
    const stem = w.slice(0, -2);
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      cands.push(stem.slice(0, -1));
    }
  }
  if (w.endsWith("ier")) cands.push(w.slice(0, -3) + "y");
  if (w.endsWith("iest")) cands.push(w.slice(0, -4) + "y");
  if (w.endsWith("er")) cands.push(w.slice(0, -2), w.slice(0, -1));
  if (w.endsWith("est")) cands.push(w.slice(0, -3), w.slice(0, -2));
  if (w.endsWith("ily")) cands.push(w.slice(0, -3) + "y");
  if (w.endsWith("ly")) cands.push(w.slice(0, -2), w.slice(0, -2) + "e");
  return cands.length ? cands : w;
}

function lookupLocal(raw) {
  const w = raw.toLowerCase();
  if (LOCAL_DICT[w]) return { word: w, entry: LOCAL_DICT[w], matched: w };

  const res = lemmatize(w);
  // lemmatize 命中不规则词表时返回字符串（唯一原形），否则返回候选数组
  const cands = typeof res === "string" ? [res] : (Array.isArray(res) ? res : []);

  for (const c of cands) {
    if (c && c !== w && LOCAL_DICT[c]) {
      return { word: w, entry: LOCAL_DICT[c], matched: c, inflected: true };
    }
  }
  return null;
}

// ---- 测试用例：输入 -> 期望命中的词条键 ----
const CASES = [
  ["analysis", "analysis"], ["analyses", "analysis"],
  ["running", "run"], ["compiled", "compile"], ["deployed", "deploy"],
  ["words", "word"], ["studies", "study"], ["implementations", "implementation"],
  ["generated", "generate"], ["distributed", "distributed"],
  ["configurations", "configuration"], ["children", "child"],
  ["built", "build"], ["read", "read"], ["methods", "method"],
  ["variables", "variable"], ["optimize", "optimize"], ["robust", "robust"],
  ["interface", "interface"], ["requirements", "requirement"],
  ["hypothesis", "hypothesis"], ["data", "data"],
  ["efficiency", "efficiency"], ["significantly", "significantly"],
  ["discussed", "discuss"], ["libraries", "library"], ["matched", "match"],
  ["creating", "create"], ["provided", "provide"], ["effective", "effective"],
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
console.log("词库条目数：" + Object.keys(LOCAL_DICT).length);
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

// 未收录词检查（应走在线）
const unknown = ["quantum", "heuristic", "serendipity", "blockchain"];
console.log("\n未收录词（预期走在线兜底）：");
unknown.forEach(w => console.log("  " + w.padEnd(14) + (lookupLocal(w) ? "意外命中" : "未收录 ✓")));

console.log("\n" + (fail === 0 ? "全部通过 ✓" : "存在失败项 ✗"));
process.exit(fail === 0 ? 0 : 1);
