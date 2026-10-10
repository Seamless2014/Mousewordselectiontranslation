# -*- coding: utf-8 -*-
"""词组词库体积/内存代价对比（开发分析脚本）。"""
import csv
import json
import re
import sys

CSV_PATH = sys.argv[1] if len(sys.argv) > 1 else "phrase-preview.csv"
X = 4.1  # V8 对象内存膨胀系数（实测）

rows = list(csv.DictReader(open(CSV_PATH, encoding="utf-8-sig")))


def size_with(rws, with_phon):
    """按生成格式估算字节数。"""
    total = 0
    for x in rws:
        payload = {"t": x["translation"]}
        if with_phon and x["phonetic"]:
            payload["k"] = x["phonetic"]
        payload["c"] = "e"
        key = '"' + x["word"] + '":'
        total += len(key.encode("utf-8"))
        total += len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        total += 1  # 逗号
    return total


def has_cn(t):
    return bool(re.search(r"[\u4e00-\u9fa5]", t))


l14 = [x for x in rows if x["tier"] in ("L1", "L2", "L3", "L4")]
l5_cn = [x for x in rows if x["tier"] == "L5" and has_cn(x["translation"])]
l5_all = [x for x in rows if x["tier"] == "L5"]

plans = [
    ("A 全量 + 音标（当前生成）", rows, True),
    ("B 全量，去音标", rows, False),
    ("C 仅 L1-L4 质量层，去音标", l14, False),
    ("D L1-L4 + L5(全)，去音标", l14 + l5_all, False),
]

base = 2.14 * 1024 * 1024
base_heap = base * X / 1024 / 1024

print("=" * 78)
print(f"{'方案':<34}{'条数':>9}{'源体积':>10}{'堆内存':>10}{'净增':>10}")
print("=" * 78)
for name, rws, with_phon in plans:
    s = size_with(rws, with_phon)
    heap = (base + s) * X / 1024 / 1024
    print(f"{name:<34}{len(rws):>9,}{s/1024/1024:>9.2f}MB{heap:>9.1f}MB{heap-base_heap:>+9.1f}MB")
print("=" * 78)
print(f"基准（现词库 3.09 万单词）: 源 {base/1024/1024:.2f}MB → 堆 {base_heap:.1f}MB")
print()
print(f"L5 中含中文释义的: {len(l5_cn):,} / {len(l5_all):,}")

# L5 去掉含英文残留（如 "n. xxx"）的
l5_clean = [x for x in l5_all if has_cn(x["translation"]) and not re.match(r"^[a-z]{2}\.", x["translation"])]
print(f"L5 中「含中文且不以词性缩写开头」的: {len(l5_clean):,}")
s = size_with(l14 + l5_clean, False)
heap = (base + s) * X / 1024 / 1024
print(f"{'E L1-L4 + L5(精筛)，去音标':<34}{len(l14+l5_clean):>9,}{s/1024/1024:>9.2f}MB{heap:>9.1f}MB{heap-base_heap:>+9.1f}MB")
