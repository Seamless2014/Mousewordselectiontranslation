#!/usr/bin/env python3
"""
扩展单词词库构建脚本（走 ECDICT SQLite 版，替代只能读 CSV 的 build-dict.js）。

★ 为什么改走 SQLite ★
  build-dict.js 读的是 CSV 版，而 CSV 版**没有 collins / oxford 字段**
  （只有 phonetic/pos/bnc/frq/tag）。SQLite 版的 stardict 表信息更全，
  且能直接用 SQL 做词频排序，不必把 66MB CSV 全量载入内存。

★ 取词策略：**只取有 BNC/COCA 词频的词** ★
  ECDICT 里「纯小写单词 + 有中文释义」共 91.2 万条，但**只有 47,427 条带词频**
  （BNC 或 COCA 至少一个有值）。这 4.7 万条就是「常用词」的客观边界。

  曾经尝试过「词频用完后，用有音标/有考试标记的词补足到 5 万」，实测失败：
  无词频的 86.4 万条里，有音标的多达 19.8 万条，但**几乎全是专有名词与化学名词**
  （aalborgs 奥尔堡、aamasul 化学物、aardvarking 土豚、abamectin 阿维菌素），
  按字母序取会先拿到一堆 a 开头的垃圾。取到末尾看到的 hexa/hila/hist
  只是恰好出现在 h 附近的巧合，不是质量好转。
  → 结论：**词频用尽即停**，宁可要 4.7 万条干净词，不要 5 万条掺沙子的词。

  考试标记（GRE/IELTS/TOEFL/CET）仅 759 条且**全部已有词频**，不构成增量。

用法：
  python build-extra.py <stardict.db> [--target 50000] [--out-prefix .]
  （target 仅作上限；实际产出以上限与可用词源二者较小值为准）
"""

import argparse
import os
import re
import sqlite3
import sys

# 与 build-phrases.py 保持一致的清洗规则（释义风格统一）
BRACKET_RE = re.compile(r"\[[^\]]{0,20}\]")
# 释义里夹着的词性前缀。★ 必须包含 `a.` ★
#   ECDICT 的 translation 里形容词缩写是 **`a.`**（不是 `adj.`），
#   实测若不清理，会有 22% 的条目释义残留「a. 社会的；群居的」这类前缀。
#   同时覆盖 `vi.`/`vt.`/`ad.`/`prep.` 等，以及中文语境里常见的 `n.`/`v.`。
#
#   两条规则：
#     ① 前面是行首/分隔符/空白 —— 「a. 社会的」「；a. 充满的」
#     ② 后面紧跟汉字 —— 「vi. 说大话」这种点号后无空格的情形
#   用 (?![\w]) 排除 `a.` 后面正好是字母的情况，避免误伤正常文本。
POS_HEAD = (
    r"(?:a|ad|adj|adv|n|v|vt|vi|prep|conj|pron|num|art|int|aux|abbr|pl|sing|"
    r"compar|superl|imper|p\.?p|past|pp)"
)
POS_RE_A = re.compile(
    r"(?:(?<=^)|(?<=[；;\s，,、]))" + POS_HEAD + r"\s*\.\s*",
    re.I,
)
POS_RE_B = re.compile(POS_HEAD + r"\s*\.\s*(?=[\u4e00-\u9fa5])", re.I)
# ★ 注意 ECDICT 的 pos 用的是 Penn Treebank 单字母标签 ★
#   实测取值：a(限定词) j(形容词) r(副词) n(名词) v(动词) u(感叹词)
#             i(介词) p(代词) c(连词) m(数词) t(不定式to) d(副词) x(其他)
#   上一版只映射了 j/r，导致 m./i./d. 直接漏到用户面前，必须补全。
POS_MAP = {
    # 多字母写法
    "n": "n.", "v": "v.", "vt": "v.", "vi": "v.", "adj": "adj.", "adv": "adv.",
    "prep": "prep.", "conj": "conj.", "pron": "pron.", "num": "num.",
    "art": "art.", "int": "int.", "aux": "v.", "abbr": "abbr.",
    "suff": "suf.", "pref": "pref.",
    # Penn Treebank 单字母
    "a": "adj.",      # 限定词（ECDICT 里 a:99 多对应形容词性用法）
    "j": "adj.",
    "r": "adv.",
    "d": "adv.",      # 副词
    "i": "prep.",     # 介词
    "p": "pron.",     # 代词
    "c": "conj.",     # 连词
    "m": "num.",      # 数词
    "u": "int.",      # 感叹词
    "x": "",          # 其他/未知
    "t": "",          # 不定式 to，无独立词性意义
}

TARGET_DEFAULT = 50000

# 考试词表标记（ECDICT 的 tag 字段），越靠前优先级越高
EXAM_TAGS = ["cet4", "cet6", "ky", "toefl", "ielts", "gre", "gk", "zk"]


def clean_translation(raw, max_len=42, max_senses=3):
    """与 build-phrases.py 同款：把 ECDICT 的 translation 清洗成简短中文释义。"""
    if not raw:
        return ""
    s = raw.replace("\\n", "\n")
    s = BRACKET_RE.sub("", s)
    s = POS_RE_A.sub("", s)
    s = POS_RE_B.sub("", s)
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


def clean_pos(raw):
    """pos 形如 'n:12%/v:88%'，取占比最高的那个。"""
    if not raw:
        return ""
    best, best_val = "", -1
    for it in str(raw).split("/"):
        it = it.strip()
        if not it:
            continue
        m = re.match(r"^([a-zA-Z]+)\s*:?\s*(\d+)?%?$", it)
        if not m:
            continue
        tag = m.group(1).lower()
        val = int(m.group(2)) if m.group(2) else 100
        if val > best_val:
            best_val, best = val, tag
    return POS_MAP.get(best, best + "." if best else "")


def clean_phonetic(raw):
    return re.sub(r'["\\]', "", (raw or "").strip())[:40]


def has_chinese(s):
    return any("\u4e00" <= ch <= "\u9fa5" for ch in s)


def load_existing(path, var_name="LOCAL_DICT"):
    """读 dict.js / dict-phrase.js 里已声明的键，避免重复。

    ★ 两种键书写形式都要匹配 ★
      dict.js       单词键是裸的：      not:{...}          （纯小写合法标识符）
      dict-phrase.js 词组键带双引号：   "refer to":{...}   （含空格，必须加引号）
    上一版只匹配裸键，导致词组库抽出 0 条，未起到去重作用。
    """
    keys = set()
    try:
        with open(path, encoding="utf8") as f:
            src = f.read()
        # 裸键：not:{  /  after:{   （排除 `var XXX = {` 这类声明行）
        for m in re.finditer(r"^\s*([a-z][a-z0-9'-]*)\s*:\s*\{", src, re.M):
            keys.add(m.group(1))
        # 引号键（词组）："refer to":{
        for m in re.finditer(r'"([a-z][a-z0-9\' -]*)"\s*:\s*\{', src):
            keys.add(m.group(1))
    except OSError as e:
        print(f"  ! 未能读取 {path}：{e}", file=sys.stderr)
    return keys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("db", help="stardict.db 路径")
    ap.add_argument("--target", type=int, default=TARGET_DEFAULT, help="目标词条数")
    ap.add_argument("--out-prefix", default=None, help="输出目录（默认脚本目录）")
    args = ap.parse_args()

    db = args.db
    if not os.path.exists(db):
        print(f"找不到数据库：{db}", file=sys.stderr)
        sys.exit(1)

    here = args.out_prefix or os.path.dirname(os.path.abspath(__file__))
    target = args.target

    core = load_existing(os.path.join(here, "dict.js"))
    phrase = load_existing(os.path.join(here, "dict-phrase.js"))
    occupied = core | phrase
    print(f"精选词条 {len(core)} / 词组词条 {len(phrase)} → 需排除 {len(occupied)} 个键")

    con = sqlite3.connect(db)
    cur = con.cursor()

    # 只取有词频的词；词频升序（值越小越常用）
    #   同词频时用考试标记 + 柯林斯星级 + 词长做二级排序（都是质量正向信号）
    tag_case = " ".join(
        f"WHEN tag LIKE '%{t}%' THEN {i}" for i, t in enumerate(EXAM_TAGS)
    )
    cur.execute(f"""
        SELECT word, translation, pos, phonetic, bnc, frq, tag
          FROM stardict
         WHERE word GLOB '[a-z]*' AND word NOT GLOB '*[^a-z]*'
           AND length(word) BETWEEN 2 AND 24
           AND translation IS NOT NULL AND translation <> ''
           AND (COALESCE(bnc,0) > 0 OR COALESCE(frq,0) > 0)
         ORDER BY
           CASE WHEN COALESCE(bnc,0) > 0 THEN bnc ELSE frq + 100000 END,
           CASE TRIM(COALESCE(tag,'')) {tag_case} ELSE 99 END,
           length(word),
           word
    """)

    picked = []
    seen = set()
    for word, trans, pos, phon, bnc, frq, _tag in cur:
        if word in occupied or word in seen:
            continue
        t = clean_translation(trans)
        # 释义必须是中文（英文残留/纯符号一律丢弃）
        if not t or not has_chinese(t):
            continue
        seen.add(word)
        picked.append({
            "word": word,
            "t": t,
            "p": clean_pos(pos),
            "k": clean_phonetic(phon),
        })
        if len(picked) >= target:
            break

    con.close()

    print(f"\n取词结果：{len(picked)} 条（全部来自 BNC/COCA 词频段）")
    if len(picked) < target:
        print(f"  · 未达上限 {target}：带词频的词源已用尽（这是 ECDICT 的客观上限）")

    # ---------- 生成 dict-extra.js ----------
    out = [
        "/**",
        " * 扩展词库 —— 由 ECDICT 批量生成，请勿手工编辑。",
        " *",
        " * 数据来源：ECDICT (https://github.com/skywind3000/ECDICT)，MIT License",
        " * 生成方式：build-extra.py（走 SQLite 版，只取带 BNC/COCA 词频的常用词）",
        " * 词条数：" + str(len(picked)) + "（不含 dict.js / dict-phrase.js 中的词条）",
        " *",
        " * 结构：word -> { t: 释义, p: 词性, k: 音标 }",
        " * 与 dict.js 保持一致，用 var 声明以便安全重复加载。",
        " */",
        "var DICT_EXTRA = {",
    ]

    line_buf = "  "
    for it in picked:
        entry = it["word"] + ":" + _js_obj(it)
        if len(line_buf) + len(entry) + 2 > 110:
            out.append(line_buf.rstrip())
            line_buf = "  "
        line_buf += entry + ","
    if line_buf.strip():
        out.append(line_buf.rstrip(","))
    out += [
        "};",
        "",
        "/* 自检：仅保留纯小写字母键 */",
        "(function () {",
        "  Object.keys(DICT_EXTRA).forEach(function (k) {",
        "    if (!/^[a-z]+$/.test(k)) delete DICT_EXTRA[k];",
        "  });",
        "})();",
        "",
    ]

    out_path = os.path.join(here, "dict-extra.js")
    with open(out_path, "w", encoding="utf8", newline="\n") as f:
        f.write("\n".join(out))

    size = os.path.getsize(out_path)
    print(f"\n已生成 {out_path}")
    print(f"文件体积：{size / 1024 / 1024:.2f} MB ({size / 1024:.1f} KB)")

    print("\n前 12 条（最高频）：")
    for it in picked[:12]:
        print(f"  {it['word']:<16}[{it['p']}] {it['t'][:34]}")

    print("\n末 8 条（词频下限边界）：")
    for it in picked[-8:]:
        print(f"  {it['word']:<16}[{it['p']}] {it['t'][:34]}")


def _js_obj(it):
    """手写 JSON 片段（避免 json.dumps 的 ensure_ascii 与空格差异）。"""
    def esc(s):
        return (s or "").replace("\\", "\\\\").replace('"', '\\"')

    parts = ['"t":"' + esc(it["t"]) + '"']
    if it["p"]:
        parts.append('"p":"' + esc(it["p"]) + '"')
    if it["k"]:
        parts.append('"k":"' + esc(it["k"]) + '"')
    return "{" + ",".join(parts) + "}"


if __name__ == "__main__":
    main()
