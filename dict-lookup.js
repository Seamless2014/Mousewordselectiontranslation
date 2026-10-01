/**
 * 词形还原 + 两级词库查询（共享模块）。
 *
 * 为什么单独抽一个文件：
 *   改造前这段逻辑在 content.js / test-extra.js / test-verify.js 里各存了一份副本，
 *   改一处要同步三处，极易漏改。service worker 支持 importScripts，
 *   所以把唯一实现放在这里，运行时由 background.js 加载，测试也直接加载同一份。
 *
 * 依赖（由调用方保证已先加载，顺序不得颠倒）：
 *   dict.js        -> var LOCAL_DICT
 *   dict-extra.js  -> var DICT_EXTRA
 *
 * 本文件不持有词库引用，只在查询时按名读取，因此：
 *   - 词库缺失时降级返回 null，不抛错
 *   - 可在同一进程内被多个上下文复用（一个文件 = 一份函数定义）
 */
"use strict";

/**
 * 不规则词形表：变体 -> 唯一原形。
 * 表里没有的走规则还原（见 lemmatize）。
 */
var HT_IRREGULAR = {
  was: "be", were: "be", been: "be", is: "be", are: "be", am: "be",
  has: "have", had: "have", did: "do", does: "do", done: "do",
  went: "go", gone: "go", made: "make", took: "take", taken: "take",
  gave: "give", given: "give", found: "find", knew: "know", known: "know",
  thought: "think", saw: "see", seen: "see", wanted: "want",
  said: "say", told: "tell", became: "become", left: "leave",
  kept: "keep", began: "begin", begun: "begin", ran: "run",
  brought: "bring", wrote: "write", written: "write", stood: "stand",
  lost: "lose", paid: "pay", met: "meet", led: "lead",
  understood: "understand", spoke: "speak", spoken: "speak",
  read: "read", spent: "spend", grew: "grow", grown: "grow",
  won: "win", offered: "offer", built: "build", fell: "fall",
  cut: "cut", reached: "reach", remained: "remain",
  suggested: "suggest", raised: "raise", passed: "pass", sold: "sell",
  required: "require", reported: "report", decided: "decide",
  returned: "return", explained: "explain", developed: "develop",
  carried: "carry", broke: "break", broken: "break", received: "receive",
  agreed: "agree", produced: "produce", ate: "eat", eaten: "eat",
  covered: "cover", caught: "catch", drew: "draw", drawn: "draw",
  chose: "choose", chosen: "choose", caused: "cause",
  children: "child", men: "man", women: "woman", feet: "foot",
  teeth: "tooth", mice: "mouse", people: "people", lives: "life",
  better: "good", best: "good", worse: "bad", worst: "bad",
  more: "much", most: "much", less: "little", least: "little",
  data: "data", analyses: "analysis", indices: "index"
};

/**
 * 词形还原。
 *
 * 返回值有两种形态：
 *   - 命中不规则词表时返回 string（唯一原形，如 was -> "be"）
 *   - 否则返回候选词数组（按优先级排列），交由调用方逐个查词库
 *   - 无候选时返回 null
 */
function lemmatize(word) {
  const w = String(word).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(HT_IRREGULAR, w)) return HT_IRREGULAR[w];
  if (w.length <= 3) return null;

  const c = [];
  // 复数 / 第三人称单数
  if (w.endsWith("ies")) c.push(w.slice(0, -3) + "y");
  if (w.endsWith("ves")) c.push(w.slice(0, -3) + "f", w.slice(0, -3) + "fe");
  if (w.endsWith("ses") || w.endsWith("xes") || w.endsWith("zes") ||
      w.endsWith("ches") || w.endsWith("shes")) c.push(w.slice(0, -2));
  if (w.endsWith("es")) c.push(w.slice(0, -1), w.slice(0, -2));
  if (w.endsWith("s") && !w.endsWith("ss")) c.push(w.slice(0, -1));
  // 进行时 / 动名词
  if (w.endsWith("ying")) c.push(w.slice(0, -4) + "ie", w.slice(0, -4) + "y");
  if (w.endsWith("ing")) {
    c.push(w.slice(0, -3), w.slice(0, -3) + "e");
    const stem = w.slice(0, -3);
    // 双写辅音：running -> run
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) c.push(stem.slice(0, -1));
  }
  // 过去式 / 过去分词
  if (w.endsWith("ied")) c.push(w.slice(0, -3) + "y");
  if (w.endsWith("ed")) {
    c.push(w.slice(0, -2), w.slice(0, -1));
    const stem = w.slice(0, -2);
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) c.push(stem.slice(0, -1));
  }
  // 比较级 / 最高级
  if (w.endsWith("ier")) c.push(w.slice(0, -3) + "y");
  if (w.endsWith("iest")) c.push(w.slice(0, -4) + "y");
  if (w.endsWith("er")) c.push(w.slice(0, -2), w.slice(0, -1));
  if (w.endsWith("est")) c.push(w.slice(0, -3), w.slice(0, -2));
  // 副词
  if (w.endsWith("ily")) c.push(w.slice(0, -3) + "y");
  if (w.endsWith("ly")) c.push(w.slice(0, -2), w.slice(0, -2) + "e");

  return c.length ? c : null;
}

/**
 * 在单个词库对象中查词。
 *
 * 用 hasOwnProperty 而非 `dict[key]` 直接取值：ECDICT 里确实收录了
 * constructor / tostring 这类"撞上 Object.prototype 属性名"的真实单词，
 * 直接取值会命中原型链上的函数，把 JS 内置方法当成词条返回。
 *
 * @param {object} dict 词库对象（LOCAL_DICT 或 DICT_EXTRA）
 * @param {string} key  小写单词
 * @returns {object|null} 命中则返回词条对象
 */
function lookupInDict(dict, key) {
  if (!dict || typeof dict !== "object") return null;
  if (!Object.prototype.hasOwnProperty.call(dict, key)) return null;
  const entry = dict[key];
  return entry && typeof entry === "object" ? entry : null;
}

/**
 * 依次尝试：原词 -> 各还原候选，返回首个命中的词条。
 *
 * 查询顺序：精选词库 dict.js 优先（释义更精炼、词性更准），
 * 未命中再查 ECDICT 扩展词库 dict-extra.js。
 * 这样精选词条的展示质量不会被机器生成的释义覆盖。
 *
 * @returns {object|null} { word, matched, entry, inflected? } 或 null
 */
function lookupLocal(rawWord) {
  // 两个词库都缺失时降级为纯在线模式，不让异常中断取词流程
  const hasMain = typeof LOCAL_DICT === "undefined" ? false : !!LOCAL_DICT;
  const hasExtra = typeof DICT_EXTRA === "undefined" ? false : !!DICT_EXTRA;
  if (!hasMain && !hasExtra) return null;

  const w = String(rawWord).toLowerCase();
  const dicts = [];
  if (hasMain) dicts.push({ name: "core", dict: LOCAL_DICT });
  if (hasExtra) dicts.push({ name: "extra", dict: DICT_EXTRA });

  // 按词库优先级依次查：先原词
  for (const d of dicts) {
    const hit = lookupInDict(d.dict, w);
    if (hit) return { word: w, matched: w, entry: hit, tier: d.name, inflected: false };
  }

  // 再查还原候选
  const cands = lemmatize(w);
  const list = typeof cands === "string" ? [cands] : (Array.isArray(cands) ? cands : []);

  for (const c of list) {
    if (!c || c === w) continue;
    for (const d of dicts) {
      const hit = lookupInDict(d.dict, c);
      if (hit) return { word: w, matched: c, entry: hit, tier: d.name, inflected: true };
    }
  }
  return null;
}

/**
 * 把词条组装成气泡需要的数据结构（词性分组 + 音标 + 层级标记）。
 *
 * 放在共享模块里，是为了让 service worker 直接把"渲染就绪"的数据回给
 * 内容脚本——内容脚本不需要再懂词条结构，只需要会画。这样词条格式将来
 * 变化时只改一处。
 *
 * @param {object} local lookupLocal 的返回值
 * @returns {object} 可直接用于气泡渲染的结果对象
 */
function buildLocalResult(local) {
  const entry = local.entry;
  const groups = [];
  const posList = String(entry.p || "").split("/").filter(Boolean);
  const defs = String(entry.t || "").split(/[；;]/).map(s => s.trim()).filter(Boolean);

  if (posList.length > 1 && defs.length > 1) {
    // 多词性：按词性数量均分释义（粗略映射，与词条生成规则一致）
    const per = Math.ceil(defs.length / posList.length);
    posList.forEach((p, i) => {
      const chunk = defs.slice(i * per, (i + 1) * per).join("；");
      if (chunk) groups.push({ pos: p, text: chunk });
    });
  } else {
    groups.push({ pos: posList[0] || "", text: defs.join("；") });
  }

  return {
    word: local.word,
    matched: local.matched,
    display: local.word,
    // 扩展词库带 k（音标）；精选词库 dict.js 通常没有该字段
    phonetic: entry.k || "",
    inflected: !!local.inflected,
    groups: groups,
    plain: entry.t,
    source: "local",
    // 标记词条来源，气泡角标区分"精选词库 / 扩展词库"
    tier: local.tier || (entry.k !== undefined ? "extra" : "core")
  };
}
