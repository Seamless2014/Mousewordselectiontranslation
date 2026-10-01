/**
 * 真实文本覆盖率测试（开发工具）。
 *
 * 用真实英文文本（技术文档 + 通用英文）统计：不同词库档位能覆盖多少 token。
 * 这是比 Zipf 估算更硬的证据——直接拿文本跑。
 *
 * 用法：node test-coverage.js <ecdict.csv>
 */
const fs = require("fs");

const CSV = process.argv[2] || "/tmp/ecdict/ecdict.csv";

function parseCsvLine(line) {
  const out = []; let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; }
    else { if (ch === '"') inQ = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch; }
  }
  out.push(cur); return out;
}

// ---------- 构造测试文本 ----------
// 混合三类文本，贴近"看英文网页文档"的真实场景：
// A. 技术文档（README / 论文风格）
// B. 通用英文（新闻 / 说明文）
// C. 商务邮件
const SAMPLES = {
  "技术文档": `
    The repository implements a distributed cache layer with consistent hashing.
    Each node maintains a replica set, and the coordinator propagates invalidation
    events asynchronously. Latency is bounded by the quorum timeout, which defaults
    to seven hundred milliseconds. Throughput degrades gracefully under partition,
    because writes are idempotent and the reconciliation loop converges deterministically.
    To deploy, build the artifact, provision the cluster, and apply the schema migration.
    Rollback is supported via the snapshot mechanism described in the appendix.
    The runtime exposes an endpoint for health checks and a webhook for alerting.
    Configure the quota, the token lifetime, and the pipeline parallelism in settings.
  `,
  "通用英文": `
    The committee reviewed the proposal and concluded that the evidence was insufficient
    to justify the expenditure. Nevertheless, the chairman argued that postponing the
    decision would incur greater cost. Several members expressed concern about the
    environmental impact, particularly regarding the discharge of untreated effluent
    into the adjacent wetland. The ministry subsequently commissioned an independent
    assessment, which recommended stricter monitoring and a phased implementation.
    Public consultation will commence next quarter, and the findings will inform the
    final regulatory framework.
  `,
  "商务邮件": `
    Dear Mr. Henderson, thank you for your prompt reply regarding the outstanding invoice.
    We have reconciled the ledger and confirmed that the discrepancy arose from a duplicate
    entry in the procurement record. Our finance department will issue a credit note and
    adjust the reimbursement accordingly. Please confirm whether the vendor has submitted
    the revised quotation, as we must finalize the budget before the audit. We appreciate
    your patience and look forward to a continued partnership.
  `,
  "学术摘要": `
    This study investigates the correlation between syntactic complexity and reading
    comprehension among intermediate learners. Participants completed a battery of
    assessments measuring lexical density, clause length, and inferential accuracy.
    Results indicate a statistically significant association, although the effect size
    diminishes when vocabulary knowledge is controlled. We argue that pedagogical
    interventions should prioritize explicit instruction in subordinating structures,
    and we outline directions for subsequent research.
  `
};

// ---------- 载入词库 ----------
function loadWords(csvPath, limit) {
  const existing = new Set();
  try {
    const src = fs.readFileSync(__dirname + "/dict.js", "utf8");
    const re = /^\s*([a-z][a-z0-9]*)\s*:\s*\{/gm;
    let m; while ((m = re.exec(src)) !== null) existing.add(m[1]);
  } catch (_) {}

  const lines = fs.readFileSync(csvPath, "utf8").split("\n");
  const header = parseCsvLine(lines[0]);
  const idx = {}; header.forEach((h, i) => { idx[h.trim()] = i; });

  const cands = [];
  for (let li = 1; li < lines.length; li++) {
    const line = lines[li]; if (!line) continue;
    const f = line.indexOf('"') >= 0 ? parseCsvLine(line) : line.split(",");
    const word = (f[idx.word] || "").trim();
    if (!/^[a-z]{2,24}$/.test(word)) continue;
    if (!(f[idx.translation] || "").trim()) continue;
    if (existing.has(word)) continue;
    const bnc = parseInt(f[idx.bnc] || "0", 10) || 0;
    const frq = parseInt(f[idx.frq] || "0", 10) || 0;
    const collins = parseInt(f[idx.collins] || "0", 10) || 0;
    const rank = bnc > 0 ? bnc : (frq > 0 ? frq + 100000 : 99999999);
    cands.push({ word, rank, collins });
  }
  cands.sort((a, b) => (a.rank - b.rank) || (b.collins - a.collins));
  return cands.slice(0, limit).map(c => c.word);
}

// ---------- 词形还原（复刻 content.js）----------
const IRREGULAR = {
  was:"be",were:"be",been:"be",is:"be",are:"be",am:"be",has:"have",had:"have",
  did:"do",does:"do",done:"do",went:"go",gone:"go",made:"make",took:"take",taken:"take",
  gave:"give",given:"give",found:"find",knew:"know",known:"know",thought:"think",
  saw:"see",seen:"see",said:"say",told:"tell",became:"become",left:"leave",kept:"keep",
  began:"begin",begun:"begin",ran:"run",brought:"bring",wrote:"write",written:"write",
  stood:"stand",lost:"lose",paid:"pay",met:"meet",led:"lead",understood:"understand",
  spoke:"speak",spoken:"speak",read:"read",spent:"spend",grew:"grow",grown:"grow",
  won:"win",built:"build",fell:"fall",sold:"sell",broke:"break",broken:"break",
  ate:"eat",eaten:"eat",caught:"catch",drew:"draw",drawn:"draw",chose:"choose",
  chosen:"choose",children:"child",men:"man",women:"woman",feet:"foot",teeth:"tooth",
  mice:"mouse",lives:"life",better:"good",best:"good",worse:"bad",worst:"bad",
  more:"much",most:"much",less:"little",least:"little",analyses:"analysis",indices:"index"
};
function lemmatize(w) {
  w = w.toLowerCase();
  if (IRREGULAR[w]) return w;
  if (w.length <= 3) return w;
  const c = [];
  if (w.endsWith("ies")) c.push(w.slice(0,-3)+"y");
  if (w.endsWith("ves")) c.push(w.slice(0,-3)+"f", w.slice(0,-3)+"fe");
  if (/s(es|xes|zes|ches|shes)$/.test(w)) c.push(w.slice(0,-2));
  if (w.endsWith("es")) c.push(w.slice(0,-1), w.slice(0,-2));
  if (w.endsWith("s") && !w.endsWith("ss")) c.push(w.slice(0,-1));
  if (w.endsWith("ying")) c.push(w.slice(0,-4)+"ie", w.slice(0,-4)+"y");
  if (w.endsWith("ing")) {
    c.push(w.slice(0,-3), w.slice(0,-3)+"e");
    const s = w.slice(0,-3);
    if (s.length>2 && s[s.length-1]===s[s.length-2]) c.push(s.slice(0,-1));
  }
  if (w.endsWith("ied")) c.push(w.slice(0,-3)+"y");
  if (w.endsWith("ed")) {
    c.push(w.slice(0,-2), w.slice(0,-1));
    const s = w.slice(0,-2);
    if (s.length>2 && s[s.length-1]===s[s.length-2]) c.push(s.slice(0,-1));
  }
  if (w.endsWith("ier")) c.push(w.slice(0,-3)+"y");
  if (w.endsWith("iest")) c.push(w.slice(0,-4)+"y");
  if (w.endsWith("er")) c.push(w.slice(0,-2), w.slice(0,-1));
  if (w.endsWith("est")) c.push(w.slice(0,-3), w.slice(0,-2));
  if (w.endsWith("ily")) c.push(w.slice(0,-3)+"y");
  if (w.endsWith("ly")) c.push(w.slice(0,-2), w.slice(0,-2)+"e");
  return null;
}

// content.js 的查词逻辑：原词直命中 > 词形还原
function isCovered(word, dictSet, lemmaCache) {
  const w = word.toLowerCase();
  if (dictSet.has(w)) return true;
  let lemma = lemmaCache.get(w);
  if (lemma === undefined) {
    const r = lemmatize(w);
    lemma = r === w ? null : r;
    lemmaCache.set(w, lemma);
  }
  if (!lemma) return false;
  const cands = Array.isArray(lemma) ? lemma : [lemma];
  return cands.some(c => c && dictSet.has(c));
}

// ---------- 主流程 ----------
console.log("=".repeat(74));
console.log("真实文本覆盖率测试");
console.log("=".repeat(74));

const TIERS = [10000, 20000, 30000, 50000, 100000, 200000, 330000];

// 预分词
const docs = {};
for (const [name, text] of Object.entries(SAMPLES)) {
  const tokens = text.toLowerCase().match(/[a-z][a-z'-]*/g) || [];
  docs[name] = tokens;
}
const allTokens = Object.values(docs).flat();
console.log("测试文本：" + Object.keys(docs).length + " 类，共 " + allTokens.length + " 个英文 token\n");

// 载入精选词库
const coreSet = new Set();
{
  const src = fs.readFileSync(__dirname + "/dict.js", "utf8");
  const re = /^\s*([a-z][a-z0-9]*)\s*:\s*\{/gm;
  let m; while ((m = re.exec(src)) !== null) coreSet.add(m[1]);
}

console.log("精选词库：" + coreSet.size + " 词");

// 逐档位测覆盖率
console.log("\n" + "-".repeat(74));
console.log("档位".padEnd(10) + "词表大小".padEnd(11) + "总覆盖".padEnd(10) + "技术".padEnd(9) + "通用".padEnd(9) + "商务".padEnd(9) + "学术");
console.log("-".repeat(74));

let prevSet = null;
const rows = [];
for (const tier of TIERS) {
  const extra = loadWords(CSV, tier - coreSet.size);
  const dictSet = new Set(coreSet);
  for (const w of extra) dictSet.add(w);
  const size = dictSet.size;

  const lemmaCache = new Map();
  const per = {};
  let covered = 0;
  for (const [name, tokens] of Object.entries(docs)) {
    let c = 0;
    for (const t of tokens) if (isCovered(t, dictSet, lemmaCache)) c++;
    per[name] = c / tokens.length * 100;
    covered += c;
  }
  const total = covered / allTokens.length * 100;
  rows.push({ tier, size, total, per });

  console.log(
    String(tier).padEnd(10) +
    String(size).padEnd(11) +
    (total.toFixed(2) + "%").padEnd(10) +
    (per["技术文档"].toFixed(1) + "%").padEnd(9) +
    (per["通用英文"].toFixed(1) + "%").padEnd(9) +
    (per["商务邮件"].toFixed(1) + "%").padEnd(9) +
    (per["学术摘要"].toFixed(1) + "%")
  );
  prevSet = dictSet;
}
console.log("-".repeat(74));

// ---------- 边际收益 ----------
console.log("\n【边际收益】相邻档位之间，多花的体积换来的覆盖率提升：");
const BYTES_PER_WORD = 73.1;
for (let i = 1; i < rows.length; i++) {
  const a = rows[i-1], b = rows[i];
  const dWords = b.size - a.size;
  const dMB = dWords * BYTES_PER_WORD / 1024 / 1024;
  const dCov = b.total - a.total;
  console.log(
    String(a.tier/1000).padStart(5)+"k → "+String(b.tier/1000).padStart(5)+"k" +
    "  新增 "+String(dWords).padStart(7)+" 词" +
    "  体积 +"+dMB.toFixed(1)+"MB" +
    "  覆盖 +"+dCov.toFixed(3)+"%"
  );
}

// ---------- 未覆盖词分析 ----------
console.log("\n【3 万词库仍查不到的词】（这些就是要靠 10 万词去补的）");
const extra30 = loadWords(CSV, 30000 - coreSet.size);
const set30 = new Set(coreSet); extra30.forEach(w => set30.add(w));
const cache30 = new Map();
const missed = new Map();
for (const [name, tokens] of Object.entries(docs)) {
  for (const t of tokens) {
    if (!isCovered(t, set30, cache30)) missed.set(t, (missed.get(t) || 0) + 1);
  }
}
const missedArr = [...missed.entries()].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]));
console.log("  未覆盖的不同词形：" + missedArr.length + " 个");
console.log("  " + missedArr.slice(0, 25).map(x => x[0] + (x[1]>1?"×"+x[1]:"")).join(", "));

// 这些词在 10 万词库里能补上多少？
const extra100 = loadWords(CSV, 100000 - coreSet.size);
const set100 = new Set(coreSet); extra100.forEach(w => set100.add(w));
const cache100 = new Map();
let rescued = 0;
const stillMissed = [];
for (const [w, cnt] of missedArr) {
  const rb = new Set(); // 复用
  if (isCovered(w, set100, cache100)) rescued += cnt; else stillMissed.push(w);
}
console.log("\n  10 万词库能补回：" + rescued + " / " + [...missed.values()].reduce((a,b)=>a+b,0) + " 个 token");
console.log("  仍查不到：" + stillMissed.length + " 个词形 → " + stillMissed.slice(0, 20).join(", "));
