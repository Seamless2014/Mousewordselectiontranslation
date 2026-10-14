/**
 * server.js — 悬停取词翻译 · 产品官网 + 访客统计后端（零依赖）
 *
 * 启动：node Web/server/server.js   （或 npm start --prefix Web/server）
 * 访问：http://localhost:8090
 * 后台：http://localhost:8090/admin.html （默认口令 admin123，见 config.json）
 *
 * 设计约定：
 *  - 所有 API 异常均返回 JSON：{ success:false, message }，绝不向客户端抛栈
 *  - /server/ 目录下的任何文件不允许通过 HTTP 访问（含口令配置、数据）
 *  - 管理类 API 必须携带 Bearer token（登录换取，默认 24h 有效）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config.json');
const store = require('./store');
const geo = require('./geo');

const WEB_ROOT = path.join(__dirname, '..'); // Web/
const PORT = Number(config.port) || 8090;
const MAX_BODY = 8 * 1024; // 埋点 body 上限 8KB

/* ---------------- 登录令牌 ---------------- */

/** @type {Map<string, number>} token -> 到期时间戳 */
const tokens = new Map();
const TOKEN_TTL = Number(config.tokenTtlMs) || 86400000;

function issueToken() {
  const t = crypto.randomBytes(24).toString('hex');
  tokens.set(t, Date.now() + TOKEN_TTL);
  return t;
}

function checkToken(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+([a-f0-9]+)$/i);
  if (!m) return false;
  const exp = tokens.get(m[1]);
  if (!exp) return false;
  if (Date.now() > exp) {
    tokens.delete(m[1]);
    return false;
  }
  tokens.set(m[1], Date.now() + TOKEN_TTL); // 滑动续期
  return true;
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ---------------- UA 解析（轻量正则，无第三方依赖） ---------------- */

function parseUA(ua) {
  const s = ua || '';
  let browser = '未知';
  let os = '未知';
  let device = 'PC';
  let bot = false;

  if (/bot|crawler|spider|slurp|baidu|googlebot|bingpreview|facebookexternalhit|python-requests|curl|axios|node-fetch|Go-http-client/i.test(s)) {
    bot = true;
  }

  // 浏览器识别（顺序敏感：先识别套壳/小众，再识别主流）
  let m;
  if ((m = s.match(/Edg(?:e|A|iOS)?\/([\d.]+)/))) browser = `Edge ${m[1]}`;
  else if ((m = s.match(/OPR\/([\d.]+)/))) browser = `Opera ${m[1]}`;
  else if ((m = s.match(/MicroMessenger\/([\d.]+)/i))) browser = `微信内置浏览器 ${m[1]}`;
  else if ((m = s.match(/Firefox\/([\d.]+)/))) browser = `Firefox ${m[1]}`;
  else if ((m = s.match(/Version\/([\d.]+).*Safari/))) browser = `Safari ${m[1]}`;
  else if ((m = s.match(/Chrome\/([\d.]+)/))) browser = `Chrome ${m[1]}`;
  if (bot && browser === '未知') browser = '爬虫/机器人';

  if (/Windows NT 10\.0/.test(s)) os = 'Windows 10/11';
  else if (/Windows NT 6\.3/.test(s)) os = 'Windows 8.1';
  else if (/Windows NT 6\.1/.test(s)) os = 'Windows 7';
  else if (/Windows/.test(s)) os = 'Windows';
  else if ((m = s.match(/Android ([\d.]+)/))) os = `Android ${m[1]}`;
  else if ((m = s.match(/iPhone OS ([\d_]+)/))) os = `iOS ${m[1].replace(/_/g, '.')}`;
  else if ((m = s.match(/iPad;.*OS ([\d_]+)/))) os = `iPadOS ${m[1].replace(/_/g, '.')}`;
  else if ((m = s.match(/Mac OS X ([\d_]+)/))) os = `macOS ${m[1].replace(/_/g, '.')}`;
  else if (/Linux/.test(s)) os = 'Linux';

  if (/iPad|Tablet/i.test(s)) device = '平板';
  else if (/Mobi|Android|iPhone|iPod/i.test(s)) device = '手机';

  return { browser, os, device, bot };
}

/* ---------------- HTTP 工具 ---------------- */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendOk(res, data) {
  sendJson(res, 200, Object.assign({ success: true }, data || {}));
}

function sendErr(res, code, message) {
  sendJson(res, code, { success: false, message: String(message || '服务器错误') });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first.replace(/^::ffff:/, '');
  }
  return (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

/* ---------------- 静态文件 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  try {
    // 安全：禁止访问 server 目录（配置、源码、数据）
    const decoded = decodeURIComponent(pathname);
    if (decoded.split('/').some((seg) => seg === '..')) return sendErr(res, 403, '禁止访问');
    if (decoded === '/server' || decoded.startsWith('/server/')) return sendErr(res, 403, '禁止访问');
    if (decoded.includes('/data/') || decoded.endsWith('/config.json')) return sendErr(res, 403, '禁止访问');

    let rel = decoded === '/' ? '/index.html' : decoded;
    const full = path.normalize(path.join(WEB_ROOT, rel));
    if (!full.startsWith(WEB_ROOT)) return sendErr(res, 403, '禁止访问');

    fs.stat(full, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }
      const ext = path.extname(full).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        ...(ext === '.zip' ? { 'Content-Disposition': 'attachment; filename="hover-translate-extension.zip"' } : {}),
      });
      fs.createReadStream(full).pipe(res);
    });
  } catch (e) {
    sendErr(res, 500, e.message);
  }
}

/* ---------------- API ---------------- */

async function handleApi(req, res, url) {
  const route = url.pathname;
  try {
    /* 埋点（公开） */
    if (req.method === 'POST' && route === '/api/track') {
      const raw = await readBody(req);
      let payload = {};
      try { payload = raw ? JSON.parse(raw) : {}; } catch { return sendErr(res, 400, 'JSON 格式错误'); }

      const ip = clientIp(req);
      const ua = req.headers['user-agent'] || '';
      const info = parseUA(ua);
      const loc = await geo.lookup(ip);
      const now = Date.now();

      const rec = {
        id: crypto.randomBytes(8).toString('hex'),
        ts: now,
        iso: new Date(now).toISOString(),
        ip,
        country: loc.country,
        region: loc.region,
        city: loc.city,
        district: loc.district,
        isp: loc.isp,
        geoSrc: loc.src,
        ua: String(ua).slice(0, 500),
        browser: info.browser,
        os: info.os,
        device: info.device,
        bot: info.bot,
        path: String(payload.path || '/').slice(0, 300),
        ref: String(payload.ref || '').slice(0, 500),
        lang: String(payload.lang || '').slice(0, 40),
        tz: String(payload.tz || '').slice(0, 40),
        screen: String(payload.screen || '').slice(0, 30),
      };
      store.add(rec);
      sendOk(res, { tracked: true });
      return;
    }

    /* 登录（公开） */
    if (req.method === 'POST' && route === '/api/login') {
      const raw = await readBody(req);
      let payload = {};
      try { payload = raw ? JSON.parse(raw) : {}; } catch { return sendErr(res, 400, 'JSON 格式错误'); }
      if (!timingSafeEqualStr(payload.password || '', config.adminPassword || '')) {
        return sendErr(res, 401, '口令错误');
      }
      sendOk(res, { token: issueToken() });
      return;
    }

    /* 以下全部需要鉴权 */
    if (!checkToken(req)) return sendErr(res, 401, '未登录或登录已过期');

    if (req.method === 'GET' && route === '/api/stats') {
      const range = url.searchParams.get('range') || 'day';
      if (!['day', 'week', 'month', 'year'].includes(range)) {
        return sendErr(res, 400, 'range 必须是 day/week/month/year');
      }
      sendOk(res, { data: store.stats(range) });
      return;
    }

    if (req.method === 'GET' && route === '/api/visits') {
      const data = store.queryVisits({
        page: url.searchParams.get('page') || 1,
        pageSize: url.searchParams.get('pageSize') || 20,
        q: url.searchParams.get('q') || '',
      });
      sendOk(res, data);
      return;
    }

    sendErr(res, 404, '接口不存在');
  } catch (e) {
    console.error('[api]', route, e);
    sendErr(res, 500, e.message || '服务器内部错误');
  }
}

/* ---------------- 启动 ---------------- */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url);
  } else {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendErr(res, 405, '方法不允许');
    serveStatic(req, res, url.pathname);
  }
});

const boot = store.load();
server.listen(PORT, () => {
  console.log('==============================================');
  console.log('  悬停取词翻译 · 产品官网 + 访客统计');
  console.log(`  网站首页 : http://localhost:${PORT}/`);
  console.log(`  访客后台 : http://localhost:${PORT}/admin.html`);
  console.log(`  管理口令 : ${config.adminPassword}（可在 Web/server/config.json 修改）`);
  console.log(`  历史记录 : 已加载 ${boot.loaded} 条，跳过损坏 ${boot.skipped} 条`);
  console.log('==============================================');
});

server.on('error', (e) => {
  console.error('服务器启动失败:', e.message);
  process.exit(1);
});
