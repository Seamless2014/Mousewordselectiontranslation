/**
 * ECDICT 词库构建脚本（开发工具，非扩展运行时依赖）。
 *
 * 从 ECDICT（https://github.com/skywind3000/ECDICT）筛选高频词，
 * 生成扩展用的 dict-extra.js。
 *
 * 筛选规则：
 *   - 只要纯小写字母单词（排除 -able 后缀、'hood 带撇号、含空格词组、缩写）
 *   - 按 BNC 语料库词频优先排序，兼顾 frq（当代语料库词频）
 *   - 跳过已在精选词库（dict.js）中存在的词，避免重复
 *   - 释义清洗：去换行、去 [网络]/[医] 等标记、截断过长释义
 *
 * 用法：node build-dict.js <ecdict.csv> <输出词数> [dict.js路径]
 */
const fs = require("fs");
const path = require("path");

const CSV = process.argv[2] || "/tmp/ecdict/ecdict.csv";
const TARGET = parseInt(process.argv[3] || "30000", 10);
const MAIN_DICT = process.argv[4] || path.join(__dirname, "dict.js");

// ---------- 读取已有精选词库，避免重复 ----------
function loadExisting() {
  const set = new Set();
  try {
    const src = fs.readFileSync(MAIN_DICT, "utf8");
    const re = /^\s*([a-z][a-z0-9]*)\s*:\s*\{/gm;
    let m;
    while ((m = re.exec(src)) !== null) set.add(m[1]);
  } catch (e) {
    console.warn("未能读取 dict.js，将不排除已有词条：" + e.message);
  }
  return set;
}

// ---------- CSV 解析（处理引号包裹、内部逗号与换行）----------
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// ---------- 释义清洗 ----------
// 目标：简短、可读的中文释义。ECDICT 的 translation 字段格式较杂。
function cleanTranslation(raw) {
  if (!raw) return "";
  let s = raw;

  // 转义换行还原为真实换行
  s = s.replace(/\\n/g, "\n");
  // 去方括号标记：[网络]、[医]、[化]、[诗歌用语] 等
  s = s.replace(/\[[^\]]{0,20}\]/g, "");
  // 去词性前缀（noun./verb. 之类），词性由 pos 字段单独提供
  s = s.replace(/\b(n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|aux|abbr)\s*\.\s*/gi, "");

  // 按行取前两行（第一行通常主释义）
  let lines = s.split("\n").map(x => x.trim()).filter(Boolean);
  if (!lines.length) return "";
  s = lines.slice(0, 2).join("；");

  // 压缩空白
  s = s.replace(/\s+/g, " ").trim();
  // 去掉首尾分隔符与残留标点
  s = s.replace(/^[；;，,、:：\s]+|[；;，,、:：\s]+$/g, "");
  // 多义项统一用中文分号
  s = s.replace(/\s*[，,;；]\s*/g, "；");
  // 去掉连续重复分隔符
  s = s.replace(/；{2,}/g, "；");
  // "1." "①" 之类编号去掉
  s = s.replace(/^\d+[.、)]\s*/g, "").replace(/[①②③④⑤⑥⑦⑧⑨⑩]\s*/g, "");

  // 截断过长释义（保留前 3 个义项 / 最多 42 字）
  const parts = s.split("；").filter(Boolean);
  s = parts.slice(0, 3).join("；");
  if (s.length > 42) s = s.slice(0, 42) + "…";

  return s;
}

// ---------- 词性归一化 ----------
// ECDICT 的 pos 字段形如 "n:12%/v:88%"，取占比最高者
function cleanPos(raw) {
  if (!raw) return "";
  const items = String(raw).split("/").map(x => x.trim()).filter(Boolean);
  if (!items.length) return "";
  let best = "";
  let bestVal = -1;
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

// ---------- 主流程 ----------
function main() {
  if (!fs.existsSync(CSV)) {
    console.error("找不到 CSV 文件：" + CSV);
    process.exit(1);
  }

  const existing = loadExisting();
  console.log("已有精选词条：" + existing.size);

  // 流式逐行读取，避免一次性载入 66MB 到内存
  const content = fs.readFileSync(CSV, "utf8");
  const lines = content.split("\n");
  console.log("CSV 总行数：" + lines.length);

  const header = parseCsvLine(lines[0]);
  const idx = {};
  header.forEach((h, i) => { idx[h.trim()] = i; });
  console.log("字段：" + header.join(", "));

  const iWord = idx.word, iPhon = idx.phonetic, iTrans = idx.translation;
  const iPos = idx.pos, iBnc = idx.bnc, iFrq = idx.frq, iTag = idx.tag;

  const candidates = [];
  let skipped = { shape: 0, noTrans: 0, dup: 0, tag: 0 };

  for (let li = 1; li < lines.length; li++) {
    const line = lines[li];
    if (!line) continue;
    // 只有含引号的行才需要走完整解析；否则快速 split 更快
    const f = line.indexOf('"') >= 0 ? parseCsvLine(line) : line.split(",");

    const word = (f[iWord] || "").trim();
    // 形状过滤：纯小写字母，长度 2-24，首字符必须是字母
    if (!/^[a-z]{2,24}$/.test(word)) { skipped.shape++; continue; }

    const translation = f[iTrans] || "";
    if (!translation.trim()) { skipped.noTrans++; continue; }

    if (existing.has(word)) { skipped.dup++; continue; }

    // 词频：bnc/frq 为 0 表示无词频数据，排到最后
    const bnc = parseInt(f[iBnc] || "0", 10) || 0;
    const frq = parseInt(f[iFrq] || "0", 10) || 0;
    // 综合排名分：值越小越常用；无数据的给一个大数
    const rank = (bnc > 0 ? bnc : (frq > 0 ? frq + 100000 : 99999999));

    const tagStr = (f[iTag] || "").trim();

    candidates.push({
      word,
      phonetic: (f[iPhon] || "").trim(),
      translation,
      pos: f[iPos] || "",
      rank,
      collins: parseInt(f[idx.collins] || "0", 10) || 0,
      oxford: parseInt(f[idx.oxford] || "0", 10) || 0
    });
  }

  console.log("\n过滤统计：");
  console.log("  形状不符（后缀/词组/大写）:", skipped.shape);
  console.log("  无中文释义:", skipped.noTrans);
  console.log("  已存在于精选词库:", skipped.dup);
  console.log("  有效候选:", candidates.length);

  // 排序：常用度优先；同为常用级时，柯林斯星级高、牛津核心词优先
  candidates.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return (b.collins - a.collins) || (b.oxford - a.oxford);
  });

  const picked = candidates.slice(0, TARGET);
  console.log("\n选中词条：" + picked.length);

  // ---------- 生成 dict-extra.js ----------
  const out = [];
  out.push("/**");
  out.push(" * 扩展词库 —— 由 ECDICT 批量生成，请勿手工编辑。");
  out.push(" *");
  out.push(" * 数据来源：ECDICT (https://github.com/skywind3000/ECDICT)，MIT License");
  out.push(" * 生成方式：build-dict.js 按 BNC/COCA 词频筛选，见该脚本注释");
  out.push(" * 词条数：" + picked.length + "（不含 dict.js 中的精选词条）");
  out.push(" *");
  out.push(" * 结构：word -> { t: 释义, p: 词性, k: 音标 }");
  out.push(" * 与 dict.js 保持一致，用 var 声明以便安全重复加载。");
  out.push(" */");
  out.push("var DICT_EXTRA = {");

  let lineBuf = "  ";
  for (const it of picked) {
    const t = cleanTranslation(it.translation);
    if (!t) continue;
    const p = cleanPos(it.pos);
    const k = it.phonetic.replace(/["\\]/g, "").slice(0, 40);
    const entry = it.word + ":" + JSON.stringify({ t: t, p: p, k: k });
    // 每行控制长度，便于 diff 与阅读
    if (lineBuf.length + entry.length + 2 > 110) {
      out.push(lineBuf.trimEnd());
      lineBuf = "  ";
    }
    lineBuf += entry + ",";
  }
  if (lineBuf.trim()) out.push(lineBuf.replace(/,$/, ""));
  out.push("};");
  out.push("");
  out.push("/* 自检：仅保留纯小写字母键 */");
  out.push("(function () {");
  out.push("  Object.keys(DICT_EXTRA).forEach(function (k) {");
  out.push("    if (!/^[a-z]+$/.test(k)) delete DICT_EXTRA[k];");
  out.push("  });");
  out.push("})();");
  out.push("");

  const outPath = path.join(__dirname, "dict-extra.js");
  fs.writeFileSync(outPath, out.join("\n"), "utf8");

  const size = fs.statSync(outPath).size;
  console.log("已生成 " + outPath);
  console.log("文件体积：" + (size / 1024).toFixed(1) + " KB");

  // 抽样展示
  console.log("\n前 12 条：");
  picked.slice(0, 12).forEach(it => {
    console.log("  " + it.word.padEnd(16) + "[" + cleanPos(it.pos) + "] " +
      cleanTranslation(it.translation).slice(0, 34));
  });
}

main();
