# -*- coding: utf-8 -*-
"""
词组词库构建脚本（开发工具，非扩展运行时依赖）。

从两个数据源提取词组/短语动词，去重、清洗、按质量分层，输出：
  - dict-phrase.js   扩展运行时加载的词组词库
  - phrase-preview.csv  人工抽检用的候选词表

数据源：
  1. ECDICT stardict.db —— 词组按「有音标」作为质量代理指标筛选
  2. WithEnglishWeCan/generated-english-phrasal-verbs —— 3,350 条短语动词，
     带 1-5★ 频次分级，释义从 ECDICT 补齐中文

筛选规则（词组）：
  - 纯小写字母 + 空格，2-6 段，每段 >= 2 字母
  - 长度 5-40
  - 必须有中文释义（纯英文残留视为噪声）
  - 质量门槛（两条通路，取并集）：
      通路 A：有音标 **或** 有牛津/柯林斯标记
              （注意「或」——最常用的虚词组 as soon as / according to / a bit
               恰恰没有音标，但有 collins/oxford 标记）
      通路 B：无任何质量标记，但满足「搭配骨架」特征 —— 见 SUPPLEMENT
  - 排除以冠词/纯限定词开头的条目（a a xxx 之类冗余）

补充通路 B（2026-10-10 决策，净增约 3 万条）：
  背景：out of the blue / a variety of / account for / abstain from 这类真实高频
        搭配在 ECDICT 里没有音标、没有柯林斯、没有牛津星标，只有一条中文释义，
        会被通路 A 全部挡掉。
  难点：无标记池有 146 万条，绝大多数是机器拼接噪声（a bad actor / ab initio method /
        abalone fishery）。试过 4 种判据，只有「首段或末段是介词」真正有效：
          - 每段是真实单词       -> 62.7 万，全是专业术语  ✗
          - 每段在高频词表内     -> 71.8 万，仍是实词堆叠  ✗
          - 含虚词 + 段数 <=5    -> 11.2 万，仍混入术语    △
          - 首段或末段是介词     -> 3.3 万，抽检 150 条全合格 ✓
        原因：英语搭配/短语动词多以介词收尾或开头（account for、abstain from），
              而专业术语是名词短语、末段必为实词（abandoned coal pillar）。
  附加约束：每段必须落在 ECDICT 高频词表（bnc/frq 前 20000）内，挡住 ab initio
            这类拉丁语与专有名词残留。

体积优化（较初版省 34% 源体积 / 22% 堆内存）：
  - 词组条目不存音标（词组音标对中文释义场景价值低，却占约 20% 体积）
  - 结构精简为 { t: 释义 }

质量分层（决定排序，非决定收录）：
  L1  牛津核心词组（oxford > 0）        —— 最高质量
  L2  柯林斯星级词组（collins > 0）
  L3  短语动词且频次 >= 3★
  L4  短语动词（其余）
  L5  有音标词组
  L6  补充通路 B（首/末介词搭配，无质量标记）

用法：
  python build-phrases.py <stardict.db> [pv.json] [--limit N] [--out-prefix P]
"""
import argparse
import json
import os
import re
import sqlite3
import sys

# ------------------------------------------------------------------ 配置

# 形状规则
# 首段允许单字母 "a"（a bit / a few / a bite to eat 这类固定搭配）；
# 其余段一律 >= 2 字母，避免 "a b" / "x s" 之类碎片。
PHRASE_RE = re.compile(r"^(?:a|[a-z]{2,})(?: [a-z]{2,}){1,5}$")

# 噪声模式（比"白名单"更可靠）：
#  ECDICT 的垃圾词组多是「停用词堆叠」，如 a a school treat / a and b rolls /
#  a baboon s / of the of。判据是「连续两个停用词」或「纯停用词结尾」。
STOPWORDS = {
    "a", "an", "the", "of", "and", "or", "to", "in", "on", "at", "by", "for",
    "with", "as", "is", "be", "it", "s", "b", "no",
}
# 允许存在的双停用词组合（真实搭配）
ALLOW_DOUBLE = {
    ("a", "bit"), ("a", "few"), ("a", "little"), ("a", "lot"), ("a", "couple"),
    ("a", "good"), ("a", "great"), ("a", "number"), ("a", "series"),
    ("a", "variety"), ("a", "range"), ("a", "matter"), ("a", "piece"),
    ("a", "set"), ("a", "pair"), ("a", "kind"), ("a", "sort"), ("a", "large"),
    ("as", "a"), ("in", "the"), ("of", "the"), ("on", "the"), ("to", "the"),
    ("at", "the"), ("by", "the"), ("for", "the"), ("with", "the"), ("is", "a"),
    ("to", "be"), ("in", "a"), ("on", "a"), ("at", "a"), ("as", "to"),
    ("to", "a"), ("of", "a"), ("and", "the"), ("or", "the"), ("up", "to"),
    ("out", "of"), ("as", "of"), ("in", "to"), ("on", "to"), ("is", "the"),
}


# 允许紧跟 "a" 的词（真实固定搭配只有这些；a algorithm / a baboon 是 ECDICT 的
# 错误冠词条目，应当过滤）
A_FOLLOW_OK = {
    "bit", "few", "little", "lot", "couple", "good", "great", "number",
    "series", "variety", "range", "matter", "piece", "set", "pair", "kind",
    "sort", "large", "small", "great", "wide", "long", "short", "huge",
    "vast", "whole", "half", "quarter", "dozen", "hundred", "thousand",
    "million", "billion", "great", "better", "good", "bad", "new", "old",
    "big", "fine", "nice", "sharp", "close", "far", "lot", "touch", "word",
    "while", "moment", "way", "lot", "deal", "large", "part", "form", "type",
    "case", "point", "sense", "rule", "matter", "means", "series", "chain",
    "stream", "flood", "host", "batch", "pile", "stack", "bunch", "group",
    "team", "family", "crowd", "band", "crew", "pack", "flock", "herd",
    "bite", "sip", "taste", "look", "glance", "try", "rest", "break",
    "walk", "ride", "drive", "flight", "trip", "tour", "visit", "call",
    "shot", "chance", "choice", "say", "voice", "hand", "help", "hand",
    "couple", "dozen", "couple", "couple",
}


# ------------------------------------------------------------ 补充通路 B
# 「首段或末段是介词」是英语搭配的强特征（account for / abstain from /
# accede to / abreast of），而专业术语是名词短语、末段必为实词，天然被排除。
PREPOSITIONS = {
    "of", "to", "in", "on", "at", "by", "for", "with", "as", "from",
    "into", "onto", "over", "under", "up", "down", "out", "off", "about",
    "after", "before", "between", "through", "against", "upon", "within",
    "without", "across", "along", "among", "around", "behind", "below",
    "beneath", "beside", "beyond", "during", "except", "inside", "near",
    "outside", "past", "since", "toward", "towards", "underneath", "until",
    "via", "aboard", "amid", "anti", "despite", "per", "plus", "re",
    "than", "till", "unto", "versus", "whether",
}

# 补充通路允许的最大段数（再长就基本是句子碎片）
SUPPLEMENT_MAX_SEG = 5
# 高频词表规模：取 ECDICT 按 bnc/frq 排序的前 N 个单词作为「常用词」基准
COMMON_WORD_LIMIT = 20000


def is_noise(w):
    """是否像 ECDICT 的机器拼接噪声。"""
    parts = w.split(" ")
    # 0) "a" 后面跟了不在白名单的词（a algorithm / a baboon / a bby）
    if parts[0] == "a" and len(parts) >= 2 and parts[1] not in A_FOLLOW_OK:
        return True
    # 1) 连续两个停用词（且不在白名单）
    for i in range(len(parts) - 1):
        if parts[i] in STOPWORDS and parts[i + 1] in STOPWORDS:
            if (parts[i], parts[i + 1]) not in ALLOW_DOUBLE:
                return True
    # 2) 以单字母词结尾（a baboon s / xx b）
    if len(parts[-1]) <= 1:
        return True
    # 3) 以 an / the 开头
    if parts[0] in ("an", "the"):
        return True
    return False


def is_good_phrase(w):
    """形状是否合格。"""
    if not PHRASE_RE.match(w):
        return False
    if is_noise(w):
        return False
    return True

# 释义清洗
POS_RE = re.compile(
    r"\b(n|v|vt|vi|adj|adv|prep|conj|pron|num|art|int|aux|abbr|na)\s*\.\s*", re.I
)
BRACKET_RE = re.compile(r"\[[^\]]{0,20}\]")


def clean_translation(raw, max_len=56, max_senses=3):
    """把 ECDICT 的 translation 清洗成简短中文释义。"""
    if not raw:
        return ""
    s = raw.replace("\\n", "\n")
    s = BRACKET_RE.sub("", s)
    s = POS_RE.sub("", s)
    lines = [x.strip() for x in s.split("\n") if x.strip()]
    if not lines:
        return ""
    s = "；".join(lines[:2])
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"^[；;，,、:：\s]+|[；;，,、:：\s]+$", "", s)
    s = re.sub(r"\s*[，,;；]\s*", "；", s)
    s = re.sub(r"；{2,}", "；", s)
    s = re.sub(r"^\d+[.、)]\s*", "", s)
    s = re.sub(r"[①②③④⑤⑥⑦⑧⑨⑩]\s*", "", s)
    parts = [p for p in s.split("；") if p]
    s = "；".join(parts[:max_senses])
    if len(s) > max_len:
        s = s[:max_len] + "…"
    return s


def clean_phonetic(raw):
    return re.sub(r'["\\]', "", (raw or "").strip())[:40]


def has_chinese(s):
    """释义里必须有中文，否则视为噪声（纯英文残留）。"""
    return any("\u4e00" <= ch <= "\u9fa5" for ch in s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("db", help="stardict.db 路径")
    ap.add_argument("pv", nargs="?", default="/tmp/ecdict/pv.json",
                    help="短语动词 JSON 路径")
    ap.add_argument("--limit", type=int, default=0, help="限制输出总量（0=不限）")
    ap.add_argument("--out-prefix", default=None, help="输出前缀（默认脚本目录）")
    args = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    prefix = args.out_prefix or os.path.join(here, "")

    con = sqlite3.connect(args.db)
    cur = con.cursor()

    # 已有词库中的单词（避免词组与单词冲突，虽然形状不同）
    existing = set()
    try:
        with open(os.path.join(here, "dict.js"), encoding="utf-8") as f:
            existing |= set(re.findall(r"^\s*([a-z][a-z0-9]*)\s*:\s*\{", f.read(), re.M))
        with open(os.path.join(here, "dict-extra.js"), encoding="utf-8") as f:
            existing |= set(re.findall(r"([a-z]{2,})\s*:\s*\{", f.read()))
    except Exception as e:
        print("读取已有词库失败（将不排除）: " + str(e))

    print("已有单词词条: %d" % len(existing))

    # ------------------------------------------------ 源 1：ECDICT 词组
    # 质量门槛：有音标 或 有牛津/柯林斯标记。
    # 注意「或」很关键 —— 实测发现最常用的虚词组（as soon as / according to / a bit）
    # 恰恰没有音标，但有 collins/oxford 标记；只按音标筛会全部漏掉。
    print("\n扫描 ECDICT 词组（音标 或 牛津/柯林斯标记 作为质量门槛）...")
    cur.execute(
        """
        SELECT word, phonetic, translation, collins, oxford
        FROM stardict
        WHERE word LIKE '% %'
          AND word GLOB '[a-z]*'
          AND word NOT GLOB '*[^a-z ]*'
          AND length(word) BETWEEN 5 AND 40
          AND translation IS NOT NULL AND translation <> ''
          AND (
                (phonetic IS NOT NULL AND phonetic <> '')
             OR (collins IS NOT NULL AND collins > 0)
             OR (oxford IS NOT NULL AND oxford > 0)
          )
        """
    )
    ec_rows = cur.fetchall()
    print("  原始命中: %d" % len(ec_rows))

    phrases = {}
    skipped = {"shape": 0, "trans": 0, "dup": 0}
    for word, phon, trans, collins, oxford in ec_rows:
        # 这两个字段可能为 NULL
        collins = collins or 0
        oxford = oxford or 0
        if not is_good_phrase(word):
            skipped["shape"] += 1
            continue
        t = clean_translation(trans)
        if not t or not has_chinese(t):
            skipped["trans"] += 1
            continue
        if word in phrases:
            skipped["dup"] += 1
            continue
        tier = "L1" if oxford > 0 else ("L2" if collins > 0 else "L5")
        phrases[word] = {
            "word": word,
            "t": t,
            "k": clean_phonetic(phon),
            "p": "",
            "collins": collins,
            "oxford": oxford,
            "freq": 0,
            "src": "ecdict",
            "tier": tier,
        }
    print("  通过形状+释义: %d（形状不符 %d，无释义 %d，重复 %d）"
          % (len(phrases), skipped["shape"], skipped["trans"], skipped["dup"]))

    # ------------------------------------------- 源 1b：无质量标记的常用搭配
    # 见文件头「补充通路 B」。核心判据：首段或末段是介词 + 每段都是常用词。
    print("\n补充扫描：无质量标记的介词搭配 ...")
    cur.execute(
        """
        SELECT word FROM stardict
         WHERE word NOT LIKE '% %' AND word GLOB '[a-z]*'
           AND (bnc > 0 OR frq > 0)
         ORDER BY (COALESCE(bnc, 999999) + COALESCE(frq, 999999)) ASC
         LIMIT ?
        """,
        (COMMON_WORD_LIMIT,),
    )
    common_words = {r[0] for r in cur.fetchall()}
    print("  常用词基准: %d 个" % len(common_words))

    cur.execute(
        """
        SELECT word, translation FROM stardict
         WHERE word LIKE '% %' AND word GLOB '[a-z]*' AND word NOT GLOB '*[^a-z ]*'
           AND length(word) BETWEEN 5 AND 40
           AND translation IS NOT NULL AND translation <> ''
           AND (phonetic IS NULL OR phonetic = '')
           AND (collins IS NULL OR collins = 0)
           AND (oxford IS NULL OR oxford = 0)
        """
    )
    sup_rows = cur.fetchall()
    print("  无标记候选: %d" % len(sup_rows))

    sup_added = 0
    sup_skip = {"seg": 0, "prep": 0, "common": 0, "shape": 0, "trans": 0, "dup": 0}
    for word, trans in sup_rows:
        parts = word.split(" ")
        # 段数上限：再长就基本是句子碎片而非可悬停的搭配
        if len(parts) > SUPPLEMENT_MAX_SEG:
            sup_skip["seg"] += 1
            continue
        # 核心判据：首段或末段是介词
        if parts[0] not in PREPOSITIONS and parts[-1] not in PREPOSITIONS:
            sup_skip["prep"] += 1
            continue
        # 每段都得是常用词，挡住 ab initio / abalone fishery 这类残留
        if not all(p in common_words for p in parts):
            sup_skip["common"] += 1
            continue
        if not is_good_phrase(word):
            sup_skip["shape"] += 1
            continue
        t = clean_translation(trans)
        if not t or not has_chinese(t):
            sup_skip["trans"] += 1
            continue
        if word in phrases:
            sup_skip["dup"] += 1
            continue
        phrases[word] = {
            "word": word,
            "t": t,
            "k": "",
            "p": "",
            "collins": 0,
            "oxford": 0,
            "freq": 0,
            "src": "supplement",
            "tier": "L6",
        }
        sup_added += 1
    print("  补充并入: %d（段数超限 %d，非介词首尾 %d，含生僻词 %d，形状不符 %d，"
          "无释义 %d，重复 %d）"
          % (sup_added, sup_skip["seg"], sup_skip["prep"], sup_skip["common"],
             sup_skip["shape"], sup_skip["trans"], sup_skip["dup"]))

    # ------------------------------------------------ 源 2：短语动词
    pv_count = 0
    if args.pv and os.path.exists(args.pv):
        print("\n合并短语动词 %s ..." % os.path.basename(args.pv))
        with open(args.pv, encoding="utf-8") as f:
            pv = json.load(f)
        print("  条目: %d" % len(pv))
        for word, meta in pv.items():
            w = word.strip().lower()
            if not is_good_phrase(w):
                continue
            # 释义从 ECDICT 补齐（短语动词 JSON 没有中文）
            cur.execute(
                "SELECT translation FROM stardict WHERE word = ? COLLATE NOCASE LIMIT 1",
                (w,),
            )
            row = cur.fetchone()
            t = clean_translation(row[0]) if row and row[0] else ""
            if not t or not has_chinese(t):
                continue
            freq = meta.get("frequency") or 0
            if w in phrases:
                # 已有 ECDICT 条目：用频次信息提升分层
                if freq > 0:
                    phrases[w]["freq"] = freq
                    phrases[w]["src"] = "ecdict+pv"
                    phrases[w]["tier"] = (
                        "L1" if phrases[w]["oxford"] > 0
                        else ("L2" if phrases[w]["collins"] > 0
                              else ("L3" if freq >= 3 else "L4"))
                    )
                    # 短语动词的英文释义更精准，附在中文后
                pv_count += 1
                continue
            tier = "L3" if freq >= 3 else "L4"
            phrases[w] = {
                "word": w,
                "t": t,
                "k": "",
                "p": "",
                "collins": 0,
                "oxford": 0,
                "freq": freq,
                "src": "pv",
                "tier": tier,
            }
            pv_count += 1
        print("  短语动词并入/补强: %d" % pv_count)

    # ------------------------------------------------ 排序与输出
    tier_order = {"L1": 0, "L2": 1, "L3": 2, "L4": 3, "L5": 4, "L6": 5}
    items = sorted(
        phrases.values(),
        key=lambda x: (
            tier_order.get(x["tier"], 9),
            -(x["freq"] or 0),
            -(x["collins"] or 0),
            len(x["word"]),
            x["word"],
        ),
    )
    if args.limit:
        items = items[: args.limit]

    from collections import Counter
    tc = Counter(x["tier"] for x in items)
    print("\n最终词条: %d" % len(items))
    for k in ["L1", "L2", "L3", "L4", "L5", "L6"]:
        print("  %s: %6d" % (k, tc.get(k, 0)))

    # CSV 抽检文件
    csv_path = prefix + "phrase-preview.csv"
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        f.write("word,tier,freq,phonetic,translation\n")
        for x in items:
            f.write('"%s",%s,%s,"%s","%s"\n'
                    % (x["word"], x["tier"], x["freq"], x["k"], x["t"].replace('"', "'")))
    print("\n已写出抽检表: %s" % csv_path)

    # JS 词库
    # 体积优化（2026-10-10 决策）：
    #   1) 不写音标 —— 词组音标对中文释义场景价值低，却占约 0.92MB（约 20%）
    #   2) 结构精简为 { t: 释义 } —— 去掉 c 来源标记，需要时可由词条内容推断
    #   两者合计把源体积从 4.52MB 压到 3.00MB，SW 堆从 27.3MB 降到 21.1MB。
    js_path = prefix + "dict-phrase.js"
    out = [
        "/**",
        " * 词组词库 —— 由 build-phrases.py 生成，请勿手工编辑。",
        " *",
        " * 数据来源：",
        " *   - ECDICT (https://github.com/skywind3000/ECDICT) MIT License",
        " *   - WithEnglishWeCan/generated-english-phrasal-verbs",
        " * 生成方式：见 build-phrases.py 注释（音标门槛 + 质量分层筛选）",        " * 词条数：%d" % len(items),
        " *",
        " * 结构：词组(小写，单词间单空格) -> { t: 中文释义 }",
        " * 注意：为控制体积，词组条目不存音标（词组音标对中文释义场景价值低）。",
        " * 用 var 声明以便安全重复加载（与 dict.js / dict-extra.js 一致）。",
        " */",
        "var DICT_PHRASE = {",
    ]
    line = "  "
    for x in items:
        entry = '"' + x["word"] + '":' + json.dumps(
            {"t": x["t"]}, ensure_ascii=False
        ) + ","
        if len(line) + len(entry) + 2 > 110:
            out.append(line.rstrip())
            line = "  "
        line += entry
    if line.strip():
        out.append(line.rstrip().rstrip(","))
    out.append("};")
    out.append("")
    out.append("/* 自检：仅保留「小写字母 + 单空格」键 */")
    out.append("(function () {")
    out.append("  Object.keys(DICT_PHRASE).forEach(function (k) {")
    out.append("    if (!/^[a-z]+(?: [a-z]+)*$/.test(k)) delete DICT_PHRASE[k];")
    out.append("  });")
    out.append("})();")
    out.append("")
    with open(js_path, "w", encoding="utf-8") as f:
        f.write("\n".join(out))

    size = os.path.getsize(js_path)
    print("已写出词库: %s" % js_path)
    print("文件体积：%.1f KB（%.2f MB）" % (size / 1024, size / 1024 / 1024))
    print("平均每条：%.1f 字节" % (size / max(len(items), 1)))

    con.close()


if __name__ == "__main__":
    main()
