# -*- coding: utf-8 -*-
"""
词库扩充可行性分析（开发工具，非扩展运行时依赖）

数据源：
  - ECDICT stardict.db（340 万词条）https://github.com/skywind3000/ECDICT
  - WithEnglishWeCan/generated-english-phrasal-verbs（3350 条短语动词）

目的：回答「还能往词库里塞什么、能塞多少、质量如何」。

用法：python analyze-expansion.py <stardict.db> [pv.json]
"""
import sqlite3
import sys

DB = sys.argv[1] if len(sys.argv) > 1 else "/tmp/ecdict/stardict.db"

# 单词：纯小写 2-24 字母
W = ("word GLOB '[a-z]*' AND word NOT GLOB '*[^a-z]*' "
     "AND length(word) BETWEEN 2 AND 24 "
     "AND translation IS NOT NULL AND translation <> ''")

# 词组：纯小写、空格分隔、2-6 段、每段 >=2 字母
P = ("word LIKE '% %' AND word GLOB '[a-z]*' AND word NOT GLOB '*[^a-z ]*' "
     "AND length(word) BETWEEN 5 AND 40 "
     "AND translation IS NOT NULL AND translation <> ''")

# 连字符词
H = ("word LIKE '%-%' AND word GLOB '[a-z]*' AND word NOT GLOB '*[^a-z-]*' "
     "AND translation IS NOT NULL AND translation <> ''")


def main():
    c = sqlite3.connect(DB)
    cur = c.cursor()

    def q(sql):
        cur.execute(sql)
        return cur.fetchone()[0]

    def block(title):
        print("\n" + "=" * 78)
        print(title)
        print("=" * 78)

    block("ECDICT 全量可用资源盘点（340 万词条）")
    for label, sql in [
        ("【单词】纯小写 2-24 字母 + 有释义", f"SELECT COUNT(*) FROM stardict WHERE {W}"),
        ("   其中 有 BNC/COCA 词频（可排序）", f"SELECT COUNT(*) FROM stardict WHERE {W} AND (bnc>0 OR frq>0)"),
        ("【词组】纯小写空格 2-6 段 + 有释义", f"SELECT COUNT(*) FROM stardict WHERE {P}"),
        ("   其中有柯林斯星级", f"SELECT COUNT(*) FROM stardict WHERE {P} AND collins>0"),
        ("   其中是牛津核心词组", f"SELECT COUNT(*) FROM stardict WHERE {P} AND oxford>0"),
        ("   其中有音标（质量代理指标）", f"SELECT COUNT(*) FROM stardict WHERE {P} AND phonetic IS NOT NULL AND phonetic<>''"),
        ("【连字符】纯小写含连字符 + 有释义", f"SELECT COUNT(*) FROM stardict WHERE {H}"),
    ]:
        print(f"  {label:<40} {q(sql):>10,}")

    block("方案 1 · 单词扩容（有词频，可按常用度排序）")
    print(f"  可用有词频单词总数           : {q(f'SELECT COUNT(*) FROM stardict WHERE {W} AND (bnc>0 OR frq>0)'):>10,}")
    print(f"  当前 3 万已覆盖（bnc<=30000） : {q(f'SELECT COUNT(*) FROM stardict WHERE {W} AND (bnc>0 OR frq>0) AND bnc<=30000'):>10,}")
    print(f"  → 3 万外仍带词频（bnc 3-10万）: {q(f'SELECT COUNT(*) FROM stardict WHERE {W} AND (bnc>0 OR frq>0) AND bnc>30000 AND bnc<=100000'):>10,}")

    block("方案 2 · 新增词组")
    o = q(f"SELECT COUNT(*) FROM stardict WHERE {P} AND oxford>0")
    co = q(f"SELECT COUNT(*) FROM stardict WHERE {P} AND collins>0")
    ph = q(f"SELECT COUNT(*) FROM stardict WHERE {P} AND phonetic IS NOT NULL AND phonetic<>''")
    print(f"  牛津核心词组                 : {o:>10,}")
    print(f"  有柯林斯星级词组             : {co:>10,}")
    print(f"  有音标词组（推荐用这个）      : {ph:>10,}")

    block("方案 3 · 连字符复合词")
    print(f"  纯小写含连字符 + 有释义       : {q(f'SELECT COUNT(*) FROM stardict WHERE {H}'):>10,}")

    c.close()


if __name__ == "__main__":
    main()
