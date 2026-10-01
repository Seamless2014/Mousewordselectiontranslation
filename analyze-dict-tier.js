/**
 * 词库档位分析（开发工具，非扩展运行时依赖）。
 *
 * 回答「3 万词 vs 5 万 vs 10 万 vs 全量，到底值不值」：
 *   1. 各档位的语料覆盖率（用 ECDICT 的 bnc/frq 词频排名积分）
 *   2. 各档位的边际收益（新增覆盖 / 新增体积 / 新增解析耗时）
 *   3. 各档位的释义质量（空词性比例、超长释义比例、纯英文残留比例）
 *   4. 尾部词抽样（看第 7-10 万名的词实际长什么样）
 *
 * 用法：node analyze-dict-tier.js <ecdict.csv>
 */
const fs = require("fs");

const CSV = process.argv[2] || "/tmp/ecdict/ecdict.csv";
const TIERS = [10000, 30000, 50000, 100000, 200000, 340000];

function parseCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function cleanTranslation(raw) {
  if (!raw) return "";
  let s = raw.replace(/\\n/g, "\n");
  s = s.replace(/\[[^\]]{0,20}\]/g, "");
  s = s.replace(/\b(n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|aux|abbr)\s*\.\s*/gi, "");
  let lines = s.split("\n").map(x => x.trim()).filter(Boolean);
  if (!lines.length) return "";
  s = lines.slice(0, 2).join("；");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^[；;，,、:：\s]+|[；;，,、:：\s]+$/g, "");
  s = s.replace(/\s*[，,;；]\s*/g, "；");
  s = s.replace(/；{2,}/g, "；");
  s = s.replace(/^\d+[.、)]\s*/g, "").replace(/[①②③④⑤⑥⑦⑧⑨⑩]\s*/g, "");
  const parts = s.split("；").filter(Boolean);
  s = parts.slice(0, 3).join("；");
  if (s.length > 42) s = s.slice(0, 42) + "…";
  return s;
}

function cleanPos(raw) {
  if (!raw) return "";
  const items = String(raw).split("/").map(x => x.trim()).filter(Boolean);
  if (!items.length) return "";
  let best = "", bestVal = -1;
  for (const it of items) {
    const m = it.match(/^([a-zA-Z]+)\s*:?\s*(\d+)?%?$/);
    if (!m) continue;
    const tag = m[1].toLowerCase();
    const val = m[2] ? parseInt(m[2], 10) : 100;
    if (val > bestVal) { bestVal = val; best = tag; }
  }
  const map = {
    n: "n.", v: "v.", vt: "v.", vi: "v.", adj: "adj.", adv: "adv.",
    prep: "prep.", conj: "conj.", pron: "pron.", num: "num.",
    art: "art.", int: "int.", aux: "v.", abbr: "abbr.", suff: "suf.",
    pref: "pref.", u: "", j: "adj.", r: "adv."
  };
  return map[best] !== undefined ? map[best] : (best ? best + "." : "");
}

// 读入选词库已有的词，保持与 build-dict.js 一致的口径
function loadExisting() {
  const set = new Set();
  try {
    const src = fs.readFileSync(__dirname + "/dict.js", "utf8");
    const re = /^\s*([a-z][a-z0-9]*)\s*:\s*\{/gm;
    let m;
    while ((m = re.exec(src)) !== null) set.add(m[1]);
  } catch (_) {}
  return set;
}

console.log("=".repeat(72));
console.log("词库档位分析：覆盖收益 vs 体积/耗时代价");
console.log("=".repeat(72));

const existing = loadExisting();
const content = fs.readFileSync(CSV, "utf8");
const lines = content.split("\n");
const header = parseCsvLine(lines[0]);
const idx = {};
header.forEach((h, i) => { idx[h.trim()] = i; });

console.log("CSV 行数：" + lines.length);

const cands = [];
let skippedShape = 0, skippedNoTrans = 0, skippedDup = 0;
for (let li = 1; li < lines.length; li++) {
  const line = lines[li];
  if (!line) continue;
  const f = line.indexOf('"') >= 0 ? parseCsvLine(line) : line.split(",");
  const word = (f[idx.word] || "").trim();
  if (!/^[a-z]{2,24}$/.test(word)) { skippedShape++; continue; }
  const trans = f[idx.translation] || "";
  if (!trans.trim()) { skippedNoTrans++; continue; }
  if (existing.has(word)) { skippedDup++; continue; }
  const bnc = parseInt(f[idx.bnc] || "0", 10) || 0;
  const frq = parseInt(f[idx.frq] || "0", 10) || 0;
  const rank = bnc > 0 ? bnc : (frq > 0 ? frq + 100000 : 99999999);
  cands.push({
    word, trans, pos: f[idx.pos] || "", bnc, frq, rank,
    collins: parseInt(f[idx.collins] || "0", 10) || 0,
    oxford: parseInt(f[idx.oxford] || "0", 10) || 0
  });
}
console.log("筛选后候选：" + cands.length +
  "（形状不符 " + skippedShape + "，无释义 " + skippedNoTrans + "，精选库重复 " + skippedDup + "）");
cands.sort((a, b) => (a.rank - b.rank) || (b.collins - a.collins) || (b.oxford - a.oxford));

// ---------- 覆盖率估算 ----------
// 用词频排名做 Zipf 加权：排名 r 的词，在语料中占比 ∝ 1/r。
// 已收录集合的覆盖度 = Σ(1/r) / Σ_all(1/r)。这是标准的长尾覆盖率估算方法。
// 只统计有词频数据的词（真实文本中会出现的），无词频的词不计入分母。
const freqWords = cands.filter(c => c.rank < 99999999);
let totalWeight = 0;
for (const c of freqWords) totalWeight += 1 / c.rank;

console.log("\n有词频数据的候选：" + freqWords.length + "（分母权重 " + totalWeight.toFixed(3) + "）");

// ---------- 逐档位分析 ----------
console.log("\n" + "-".repeat(72));
console.log(
  "档位".padEnd(9) + "体积".padEnd(9) + "解析".padEnd(9) +
  "累计覆盖".padEnd(11) + "本档新增覆盖".padEnd(14) + "无词性%".padEnd(9) + "超长释%"
);
console.log("-".repeat(72));

let cumWeight = 0;
let prevTier = 0;
const BYTES_PER_WORD = 73.1;      // 实测（3 万词库 2141KB / 30000）
const MS_PER_WORD = 94 / 30000;   // 实测（解析 94ms / 30000）

const tierRows = [];
for (const tier of TIERS) {
  if (tier > cands.length) break;
  const slice = cands.slice(prevTier, tier);
  let segWeight = 0, noPos = 0, tooLong = 0, emptyTrans = 0;
  for (const c of slice) {
    if (c.rank < 99999999) segWeight += 1 / c.rank;
    if (!cleanPos(c.pos)) noPos++;
    const t = cleanTranslation(c.trans);
    if (t.length > 42) tooLong++;
    if (!t) emptyTrans++;
  }
  cumWeight += segWeight;
  const bytes = tier * BYTES_PER_WORD;
  const ms = tier * MS_PER_WORD;
  const coverage = cumWeight / totalWeight * 100;
  const segCoverage = segWeight / totalWeight * 100;
  const cnt = slice.length || 1;
  tierRows.push({ tier, bytes, ms, coverage, segCoverage, noPos: noPos / cnt * 100, tooLong: tooLong / cnt * 100, segWeight });

  console.log(
    String(tier).padEnd(9) +
    ((bytes / 1024 / 1024).toFixed(1) + "MB").padEnd(9) +
    (ms.toFixed(0) + "ms").padEnd(9) +
    (coverage.toFixed(2) + "%").padEnd(11) +
    ("+" + segCoverage.toFixed(3) + "%").padEnd(14) +
    (noPos / cnt * 100).toFixed(1).padEnd(9) +
    (tooLong / cnt * 100).toFixed(1)
  );
  prevTier = tier;
}

console.log("-".repeat(72));

// ---------- 边际效益 ----------
console.log("\n【边际效益】每多 1MB 体积 / 每多 100ms 解析，换来的新增覆盖：");
let p = tierRows[1] || tierRows[0];
for (let i = 1; i < tierRows.length; i++) {
  const a = tierRows[i - 1], b = tierRows[i];
  const dMB = (b.bytes - a.bytes) / 1024 / 1024;
  const dCov = b.segCoverage;
  const dWords = b.tier - a.tier;
  console.log(
    (a.tier / 1000) + "k → " + (b.tier / 1000) + "k".padEnd(4) +
    "  新增 " + String(dWords).padStart(6) + " 词" +
    "  体积 +" + dMB.toFixed(1) + "MB" +
    "  覆盖 +" + dCov.toFixed(3) + "%" +
    "  每MB换 " + (dCov / dMB).toFixed(3) + "%"
  );
}

// ---------- 尾部抽样 ----------
console.log("\n【尾部词抽样】第 3 万名之后（3 万词库查不到的词）实际质量：");
for (const rng of [[30000, 50000], [50000, 70000], [70000, 100000]]) {
  const seg = cands.slice(rng[0], rng[1]);
  if (!seg.length) continue;
  console.log("\n  第 " + (rng[0] / 1000) + "k-" + (rng[1] / 1000) + "k 名（共 " + seg.length + " 词）抽样 12 个：");
  const step = Math.max(1, Math.floor(seg.length / 12));
  for (let i = 0; i < seg.length && i / step < 12; i += step) {
    const c = seg[i];
    console.log("    " + c.word.padEnd(18) + "[" + (cleanPos(c.pos) || "无").padEnd(6) + "] " +
      cleanTranslation(c.trans).slice(0, 34) +
      "   (rank " + (c.rank < 99999999 ? c.rank : "无") + ")");
  }
}

// ---------- 长尾占比 ----------
console.log("\n【长尾结构】");
const top3w = cands.slice(0, 30000).filter(c => c.rank < 99999999);
const w3to10 = cands.slice(30000, 100000).filter(c => c.rank < 99999999);
const w10plus = cands.slice(100000).filter(c => c.rank < 99999999);
function sumW(arr) { let s = 0; for (const c of arr) s += 1 / c.rank; return s; }
console.log("  前 3 万词贡献覆盖：" + (sumW(top3w) / totalWeight * 100).toFixed(2) + "%");
console.log("  3-10 万词贡献：   " + (sumW(w3to10) / totalWeight * 100).toFixed(3) + "%");
console.log("  10 万之后贡献：   " + (sumW(w10plus) / totalWeight * 100).toFixed(3) + "%");
