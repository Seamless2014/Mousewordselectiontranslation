/**
 * store.js — 访客记录存储（零依赖）
 *
 * 落盘形式：append-only JSONL（data/visits.jsonl），每行一条访问记录。
 * 启动时全量读入内存（适合中小流量个人站点）；写入同时 append 落盘。
 * 统计口径（UTC+8，北京时间）：
 *   PV = 埋点次数；UV = 同一时间桶内去重 IP 数。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const VISITS_FILE = path.join(DATA_DIR, 'visits.jsonl');

/** @type {Array<object>} 内存中的全部访问记录，按 ts 升序 */
let records = [];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** 启动时加载历史记录（损坏行跳过，不影响其余数据） */
function load() {
  ensureDataDir();
  records = [];
  if (!fs.existsSync(VISITS_FILE)) return { loaded: 0, skipped: 0 };
  const text = fs.readFileSync(VISITS_FILE, 'utf8');
  let bad = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec && typeof rec.ts === 'number' && rec.ip) records.push(rec);
      else bad++;
    } catch {
      bad++;
    }
  }
  records.sort((a, b) => a.ts - b.ts);
  return { loaded: records.length, skipped: bad };
}

/** 追加一条记录（内存 + JSONL 落盘） */
function add(rec) {
  records.push(rec);
  try {
    fs.appendFileSync(VISITS_FILE, JSON.stringify(rec) + '\n');
  } catch (e) {
    // 落盘失败不应让埋点接口崩溃，记录已在内存中
    console.error('[store] append failed:', e.message);
  }
  return rec;
}

function count() {
  return records.length;
}

/* ---------------- 时区工具（UTC+8） ---------------- */

const TZ_OFFSET_MS = 8 * 3600 * 1000;

function pad2(n) { return String(n).padStart(2, '0'); }

/** 取 UTC+8 的 [年, 月(1-12), 日(1-31), 小时, 星期(0=日), ISO 日期串, 年月串] */
function cnParts(ts) {
  const d = new Date(ts + TZ_OFFSET_MS);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hour = d.getUTCHours();
  const weekday = d.getUTCDay();
  return {
    year, month, day, hour, weekday,
    dayKey: `${year}-${pad2(month)}-${pad2(day)}`,
    monthKey: `${year}-${pad2(month)}`,
  };
}

function dayStartTs(ts) {
  const p = cnParts(ts);
  return Date.UTC(p.year, p.month - 1, p.day) - TZ_OFFSET_MS;
}

/* ---------------- 聚合统计 ---------------- */

/**
 * 返回指定范围的 PV/UV 序列 + 汇总。
 * @param {'day'|'week'|'month'|'year'} range
 */
function stats(range) {
  const now = Date.now();
  let buckets = [];
  let fromTs = 0;
  let title = '';

  if (range === 'day') {
    // 当天 24 小时分桶
    const p = cnParts(now);
    const start = Date.UTC(p.year, p.month - 1, p.day) - TZ_OFFSET_MS;
    fromTs = start;
    title = `${p.dayKey} 按小时`;
    for (let h = 0; h < 24; h++) {
      buckets.push({ label: `${pad2(h)}:00`, ts: start + h * 3600000, pv: 0, ips: new Set() });
    }
  } else if (range === 'week') {
    // 最近 7 天（含今天）
    const todayStart = dayStartTs(now);
    fromTs = todayStart - 6 * 86400000;
    title = '最近 7 天';
    for (let i = 0; i < 7; i++) {
      const ts = fromTs + i * 86400000;
      const p = cnParts(ts);
      buckets.push({ label: `${pad2(p.month)}-${pad2(p.day)}`, dayKey: p.dayKey, ts, pv: 0, ips: new Set() });
    }
  } else if (range === 'month') {
    // 最近 30 天（含今天）
    const todayStart = dayStartTs(now);
    fromTs = todayStart - 29 * 86400000;
    title = '最近 30 天';
    for (let i = 0; i < 30; i++) {
      const ts = fromTs + i * 86400000;
      const p = cnParts(ts);
      buckets.push({ label: `${pad2(p.month)}-${pad2(p.day)}`, dayKey: p.dayKey, ts, pv: 0, ips: new Set() });
    }
  } else if (range === 'year') {
    // 最近 12 个月（含本月）
    const p = cnParts(now);
    const monthStart = Date.UTC(p.year, p.month - 1, 1) - TZ_OFFSET_MS;
    title = '最近 12 个月';
    for (let i = 11; i >= 0; i--) {
      const d = new Date(monthStart - i * 30 * 86400000); // 近似回溯，下面用年月校准
      const pp = cnParts(d.getTime());
      const ts = Date.UTC(pp.year, pp.month - 1, 1) - TZ_OFFSET_MS;
      buckets.push({ label: `${pp.year}-${pad2(pp.month)}`, monthKey: pp.monthKey, ts, pv: 0, ips: new Set() });
    }
    // 去重（近似回溯可能重复）
    const seen = new Set();
    buckets = buckets.filter((b) => {
      if (seen.has(b.monthKey)) return false;
      seen.add(b.monthKey);
      return true;
    });
    fromTs = buckets[0].ts;
  } else {
    throw new Error('range 必须是 day/week/month/year');
  }

  // 遍历落区间记录分桶
  for (const rec of records) {
    if (rec.ts < fromTs) continue;
    if (range === 'day') {
      const h = cnParts(rec.ts).hour;
      if (buckets[h]) { buckets[h].pv++; buckets[h].ips.add(rec.ip); }
    } else if (range === 'year') {
      const mk = cnParts(rec.ts).monthKey;
      const b = buckets.find((x) => x.monthKey === mk);
      if (b) { b.pv++; b.ips.add(rec.ip); }
    } else {
      const dk = cnParts(rec.ts).dayKey;
      const b = buckets.find((x) => x.dayKey === dk);
      if (b) { b.pv++; b.ips.add(rec.ip); }
    }
  }

  const series = buckets.map((b) => {
    const { ips, ...rest } = b;
    return { ...rest, uv: ips.size };
  });
  const rangePv = series.reduce((s, b) => s + b.pv, 0);
  const rangeUv = new Set(
    records.filter((r) => r.ts >= fromTs).map((r) => r.ip)
  ).size;

  // 顶部卡片：今日 PV/UV、累计 PV/UV
  const todayStart = dayStartTs(now);
  const todayRecs = records.filter((r) => r.ts >= todayStart);
  const totalUv = new Set(records.map((r) => r.ip)).size;

  return {
    range,
    title,
    generatedAt: now,
    summary: {
      todayPv: todayRecs.length,
      todayUv: new Set(todayRecs.map((r) => r.ip)).size,
      totalPv: records.length,
      totalUv,
      rangePv,
      rangeUv,
    },
    series,
  };
}

/**
 * 分页查询访客明细（按时间倒序）
 * @param {{page?:number,pageSize?:number,q?:string}} opt
 */
function queryVisits(opt = {}) {
  const ALLOWED_SIZES = [20, 50, 200, 1000];
  let pageSize = Number(opt.pageSize) || 20;
  if (!ALLOWED_SIZES.includes(pageSize)) pageSize = 20; // 硬限制，只允许四档
  let page = parseInt(opt.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  const q = (opt.q || '').trim().toLowerCase();

  let list = records;
  if (q) {
    list = list.filter((r) => {
      const hay = [
        r.ip, r.country, r.region, r.city, r.district, r.isp,
        r.browser, r.os, r.device, r.path, r.ref, r.ua,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (page > totalPages) page = totalPages;
  // 全局按时间倒序（最新在前），再取当前页
  const desc = list.slice().reverse();
  const start = (page - 1) * pageSize;
  const rows = desc.slice(start, start + pageSize).map((r) => ({ ...r }));
  return { page, pageSize, total, totalPages, list: rows };
}

module.exports = { load, add, count, stats, queryVisits, VISITS_FILE };
