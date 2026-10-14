/**
 * geo.js — IP 归属地查询（零依赖，使用 Node 内置 fetch）
 *
 * 主通道：ip-api.com（HTTP 免费端点，中文返回，含国家/省/市/运营商；45 次/分钟限制）
 * 备用通道：ipwho.is（HTTPS，英文返回）
 * 每个 IP 的结果永久缓存到 data/geo-cache.json（归属地极少变化），
 * 既避免重复请求触发限流，也让离线/服务抖动时仍有历史结果。
 *
 * 实测说明：免费 IP 库的定位精度上限为城市级，district（区/县）字段
 * 对绝大多数 IP 返回空字符串；有值时会照常记录。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'data', 'geo-cache.json');
const TIMEOUT_MS = 4000;

/** @type {Record<string, object>} */
let cache = {};
let saveTimer = null;

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {};
    }
  } catch (e) {
    console.error('[geo] cache load failed:', e.message);
    cache = {};
  }
}

/** 防抖落盘（1.5s 内的多次查询合并写一次） */
function saveCache() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
    } catch (e) {
      console.error('[geo] cache save failed:', e.message);
    }
  }, 1500);
}

/** 判断是否为内网/本机地址 */
function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0' || ip === 'unknown') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'hover-translate-web/1.0' } });
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** 主通道 ip-api（中文） */
async function lookupIpApi(ip) {
  const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=status,message,country,regionName,city,district,isp,query`;
  const j = await fetchWithTimeout(url);
  if (!j || j.status !== 'success') throw new Error(j && j.message ? `ip-api: ${j.message}` : 'ip-api: bad response');
  return normalize({
    country: j.country || '',
    region: j.regionName || '',
    city: j.city || '',
    district: j.district || '',
    isp: j.isp || '',
    src: 'ip-api',
  });
}

/** 备用通道 ipwho.is（英文，仅在主通道失败时使用） */
async function lookupIpWho(ip) {
  const url = `https://ipwho.is/${encodeURIComponent(ip)}?fields=ip,success,country,region,city,district,connection,message`;
  const j = await fetchWithTimeout(url);
  if (!j || j.success === false) throw new Error(j && j.message ? `ipwho: ${j.message}` : 'ipwho: bad response');
  return normalize({
    country: j.country || '',
    region: j.region || '',
    city: j.city || '',
    district: j.district || '',
    isp: (j.connection && (j.connection.isp || j.connection.org)) || '',
    src: 'ipwho.is',
  });
}

function normalize(o) {
  return {
    country: String(o.country || '').slice(0, 60),
    region: String(o.region || '').slice(0, 60),
    city: String(o.city || '').slice(0, 60),
    district: String(o.district || '').slice(0, 60),
    isp: String(o.isp || '').slice(0, 120),
    src: o.src,
  };
}

const LOCAL = Object.freeze({
  country: '本地/内网', region: '', city: '', district: '', isp: '', src: 'local',
});
const UNKNOWN = Object.freeze({
  country: '未知', region: '', city: '', district: '', isp: '', src: 'none',
});

/**
 * 查询 IP 归属地（带缓存，永不抛错——失败返回未知，不影响埋点）
 */
async function lookup(ip) {
  if (isPrivateIp(ip)) return { ...LOCAL };
  if (cache[ip]) return { ...cache[ip] };

  let loc;
  try {
    loc = await lookupIpApi(ip);
  } catch (e1) {
    console.warn('[geo] ip-api failed, fallback ipwho.is:', e1.message);
    try {
      loc = await lookupIpWho(ip);
    } catch (e2) {
      console.warn('[geo] ipwho.is also failed:', e2.message);
      // 不缓存失败结果（下次访问可重试），但本次返回未知
      return { ...UNKNOWN };
    }
  }
  cache[ip] = loc;
  saveCache();
  return { ...loc };
}

/** 测试/种子脚本用：直接写入缓存 */
function seed(ip, loc) {
  cache[ip] = normalize(loc);
  saveCache();
}

loadCache();

module.exports = { lookup, isPrivateIp, seed, CACHE_FILE };
