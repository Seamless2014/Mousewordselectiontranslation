// 词组查询链路验证（开发工具）
const fs = require("fs");
const vm = require("vm");

const ctx = vm.createContext({});
for (const f of ["dict.js", "dict-extra.js", "dict-phrase.js", "dict-lookup.js"]) {
  vm.runInContext(fs.readFileSync(f, "utf8"), ctx, { filename: f });
}

const cases = [
  "look forward to", "nervous system", "abide by", "take care",
  "swimming pool", "in order to", "exclusion zone", "as soon as",
  "according to", "a bite to eat", "a bit", "come up with",
  "out of the blue", "up to date", "decision-maker", "running",
  "environment", "  Look   Forward   To  ", "look forward to,",
  "a variety of", "make up for"
];

const out = vm.runInContext(
  "(" + JSON.stringify(cases) + ").map(function(w){" +
  "  var hit = lookupLocal(w);" +
  "  if (!hit) return { in: w, found: false };" +
  "  var r = buildLocalResult(hit);" +
  "  return { in: w, found: true, matched: r.matched, tier: r.tier, plain: r.plain, phon: r.phonetic };" +
  "})",
  ctx
);

let ok = 0;
for (const r of out) {
  if (r.found) ok++;
  console.log(
    (r.found ? "✓" : "✗") + " " + JSON.stringify(r.in).padEnd(28) +
    (r.found
      ? " [" + r.tier + "]" + (r.phon ? " /" + r.phon + "/" : "") + "  " + r.plain
      : " 未命中")
  );
}
console.log("\n命中 " + ok + " / " + out.length);

// 词组不应抢走单词的查询
console.log("\n=== 单词查询未受影响（回归）===");
const words = ["environment", "procurement", "analyses", "decision-maker", "running"];
const wOut = vm.runInContext(
  "(" + JSON.stringify(words) + ").map(function(w){" +
  "  var h = lookupLocal(w);" +
  "  if (!h) return w + ' => 未命中';" +
  "  var r = buildLocalResult(h);" + // 合成词 entry 为 null，必须走 buildLocalResult
  "  return w + ' => [' + r.tier + '] 匹配=' + r.matched + '  ' + r.plain;" +
  "})",
  ctx
);
for (const l of wOut) console.log("  " + l);
