/**
 * admin.js — 访客统计后台逻辑
 * 登录令牌仅保存在 sessionStorage；所有管理接口由后端 Bearer 鉴权。
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'ht_admin_token';
  var t = function () { return I18N.t.apply(null, arguments); };
  var state = {
    range: 'day',
    metric: 'pv',
    statsData: null,
    last: null,
    page: 1,
    pageSize: 20,
    q: '',
    totalPages: 1,
  };

  /* ---------------- 工具 ---------------- */

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.className = 'toast'; }, 2400);
  }

  function getToken() { return sessionStorage.getItem(TOKEN_KEY) || ''; }
  function setToken(t) { sessionStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { sessionStorage.removeItem(TOKEN_KEY); }

  function api(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + getToken(),
    }, opts.headers || {});
    return fetch(url, opts).then(function (res) {
      return res.json().catch(function () {
        throw new Error(t('服务器返回了非 JSON 响应（HTTP {status}）', { status: res.status }));
      }).then(function (j) {
        if (res.status === 401) {
          clearToken();
          showLogin();
          throw new Error(t(j.message || '未登录或登录已过期'));
        }
        if (!j.success) throw new Error(t(j.message || '请求失败'));
        return j;
      });
    });
  }

  /* ---------------- 视图切换 ---------------- */

  function showLogin() {
    $('loginView').style.display = 'flex';
    $('appView').classList.remove('on');
  }
  function showApp() {
    $('loginView').style.display = 'none';
    $('appView').classList.add('on');
  }

  /* ---------------- 登录 ---------------- */

  function doLogin() {
    var pwd = $('pwd').value;
    var errEl = $('loginErr');
    var btn = $('loginBtn');
    if (!pwd) { errEl.textContent = t('请输入口令'); errEl.classList.add('show'); return; }
    errEl.classList.remove('show');
    btn.disabled = true; btn.textContent = t('登录中…');
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.success) throw new Error(j.message || '登录失败');
        setToken(j.token);
        enterApp();
      })
      .catch(function (e) {
        errEl.textContent = t(e.message || '登录失败');
        errEl.classList.add('show');
      })
      .finally(function () { btn.disabled = false; btn.textContent = t('登 录'); });
  }

  function updateWho() {
    var d = new Date();
    var dateStr = I18N.getLang() === 'en' ? d.toLocaleDateString('en-US') : d.toLocaleDateString('zh-CN');
    $('who').textContent = t('管理员 · {date}', { date: dateStr });
  }

  function enterApp() {
    showApp();
    updateWho();
    loadStats();
    loadVisits();
  }

  /* ---------------- 统计 ---------------- */

  function loadStats() {
    api('/api/stats?range=' + encodeURIComponent(state.range))
      .then(function (j) {
        state.statsData = j.data;
        renderStats(j.data);
        renderChart(j.data);
      })
      .catch(function (e) { toast(e.message, true); });
  }

  function renderStats(d) {
    $('kTodayPv').textContent = d.summary.todayPv;
    $('kTodayUv').textContent = d.summary.todayUv;
    $('kTotalPv').textContent = d.summary.totalPv;
    $('kTotalUv').textContent = d.summary.totalUv;
    $('chartTitle').textContent = t('访问趋势 · {title}（区间 PV {pv} / UV {uv}）', {
      title: I18N.tTitle(d.title),
      pv: d.summary.rangePv,
      uv: d.summary.rangeUv,
    });
  }

  function renderChart(d) {
    var wrap = $('chartWrap');
    var data = d.series;
    if (!data.length || d.summary.rangePv === 0) {
      wrap.innerHTML = '<div class="chart-empty">' + t('所选时间段内暂无访问记录') + '</div>';
      return;
    }
    var metric = state.metric;
    var W = 900, H = 260, padL = 44, padR = 16, padT = 20, padB = 34;
    var iw = W - padL - padR, ih = H - padT - padB;
    var max = Math.max.apply(null, data.map(function (b) { return b[metric]; })) || 1;
    var niceMax = niceCeil(max);
    var n = data.length;
    var band = iw / n;
    var barW = Math.max(2, Math.min(26, band * 0.55));

    var parts = [];
    parts.push('<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">');
    parts.push('<defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#4a8cff"/><stop offset="100%" stop-color="#6b5cff"/>' +
      '</linearGradient></defs>');

    // 横向网格 + Y 轴刻度（4 条）
    for (var g = 0; g <= 4; g++) {
      var val = Math.round(niceMax * g / 4);
      var y = padT + ih - ih * g / 4;
      parts.push('<line class="grid-line" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>');
      parts.push('<text class="axis-text" x="' + (padL - 8) + '" y="' + (y + 3) + '" text-anchor="end">' + val + '</text>');
    }

    // 柱
    data.forEach(function (b, i) {
      var v = b[metric];
      var h = niceMax ? ih * (v / niceMax) : 0;
      var x = padL + band * i + (band - barW) / 2;
      var y = padT + ih - h;
      var cls = metric === 'uv' ? 'bar bar-uv' : 'bar';
      parts.push('<rect class="' + cls + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) +
        '" width="' + barW.toFixed(1) + '" height="' + Math.max(0, h).toFixed(1) + '" rx="2">' +
        '<title>' + esc(b.label) + '\nPV: ' + b.pv + ' / UV: ' + b.uv + '</title></rect>');
    });

    // X 轴标签：最多约 12 个，均匀抽取
    var step = Math.max(1, Math.ceil(n / 12));
    data.forEach(function (b, i) {
      if (i % step !== 0 && i !== n - 1) return;
      var x = padL + band * i + band / 2;
      parts.push('<text class="axis-text" x="' + x.toFixed(1) + '" y="' + (H - 10) +
        '" text-anchor="middle">' + esc(b.label) + '</text>');
    });

    parts.push('</svg>');
    wrap.innerHTML = parts.join('');
  }

  function niceCeil(v) {
    if (v <= 4) return Math.max(1, v);
    var pow = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var n = v / pow;
    var step;
    if (n <= 1) step = 1;
    else if (n <= 2) step = 2;
    else if (n <= 5) step = 5;
    else step = 10;
    return step * pow;
  }

  /* ---------------- 访客明细 ---------------- */

  function loadVisits() {
    var qs = 'page=' + state.page + '&pageSize=' + state.pageSize + '&q=' + encodeURIComponent(state.q);
    api('/api/visits?' + qs)
      .then(function (j) { state.last = j; renderVisits(j); })
      .catch(function (e) { toast(e.message, true); });
  }

  function renderVisits(j) {
    state.totalPages = j.totalPages;
    renderTable(j.list);
    $('pageInfo').textContent = t('共 {total} 条记录，当前第 {page} / {pages} 页，每页 {size} 条', {
      total: j.total, page: j.page, pages: j.totalPages, size: j.pageSize,
    });
    $('totalPages').textContent = j.totalPages;
    $('pageInput').value = j.page;
    $('firstBtn').disabled = j.page <= 1;
    $('prevBtn').disabled = j.page <= 1;
    $('nextBtn').disabled = j.page >= j.totalPages;
    $('lastBtn').disabled = j.page >= j.totalPages;
  }

  /** 服务端返回的浏览器/系统文案本地化（未知、微信内置浏览器等） */
  function tUaLab(s) {
    if (I18N.getLang() !== 'en' || !s) return s;
    if (s === '未知') return 'Unknown';
    if (s === '爬虫/机器人') return 'Bot / robot';
    return String(s).replace(/微信内置浏览器/, 'WeChat Browser');
  }

  function renderTable(rows) {
    var tb = $('tbody');
    if (!rows.length) {
      tb.innerHTML = '<tr class="empty-row"><td colspan="8">' + t('暂无符合条件的访客记录') + '</td></tr>';
      return;
    }
    tb.innerHTML = rows.map(function (r) {
      var locParts = [r.country, r.region, r.city, r.district].filter(Boolean);
      var loc = esc(locParts.join(' / ')) || '<span class="muted">—</span>';
      var devCls = r.bot ? 'tag-bot' : (r.device === 'PC' ? 'tag-pc' : 'tag-mobile');
      var devTxt = r.bot ? t('爬虫') : tUaLab(r.device);
      var ref = r.ref ? '<a href="' + esc(r.ref) + '" target="_blank" rel="noopener" title="' + esc(r.ref) + '">' + esc(shortHost(r.ref)) + '</a>' : '<span class="muted">' + t('直接访问') + '</span>';
      var path = esc(r.path || '/');
      return '<tr>' +
        '<td class="time">' + fmtTime(r.ts) + '</td>' +
        '<td class="ip">' + esc(r.ip) + '</td>' +
        '<td class="loc">' + loc + '</td>' +
        '<td>' + (esc(r.isp) || '<span class="muted">—</span>') + '</td>' +
        '<td><span class="tag ' + devCls + '">' + devTxt + '</span></td>' +
        '<td>' + esc(tUaLab(r.browser)) + '<br><span class="muted" style="font-size:12px;">' + esc(tUaLab(r.os)) + '</span></td>' +
        '<td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;">' + ref + '</td>' +
        '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;" title="' + path + '">' + path + '</td>' +
        '</tr>';
    }).join('');
  }

  function shortHost(u) {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u.slice(0, 24); }
  }

  /* ---------------- 事件绑定 ---------------- */

  $('loginBtn').addEventListener('click', doLogin);
  $('pwd').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  $('logoutBtn').addEventListener('click', function () {
    clearToken(); showLogin(); $('pwd').value = '';
  });

  $('rangeTabs').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-range]');
    if (!b) return;
    [].forEach.call(this.querySelectorAll('button'), function (x) { x.classList.remove('on'); });
    b.classList.add('on');
    state.range = b.getAttribute('data-range');
    loadStats();
  });

  $('metricSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-metric]');
    if (!b) return;
    [].forEach.call(this.querySelectorAll('button'), function (x) { x.classList.remove('on'); });
    b.classList.add('on');
    state.metric = b.getAttribute('data-metric');
    if (state.statsData) renderChart(state.statsData);
  });

  function doSearch() {
    state.q = $('qInput').value.trim();
    state.page = 1;
    loadVisits();
  }
  $('searchBtn').addEventListener('click', doSearch);
  $('qInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });

  $('sizeSel').addEventListener('change', function () {
    state.pageSize = Number(this.value);
    state.page = 1;
    loadVisits();
  });
  $('firstBtn').addEventListener('click', function () { state.page = 1; loadVisits(); });
  $('prevBtn').addEventListener('click', function () { if (state.page > 1) { state.page--; loadVisits(); } });
  $('nextBtn').addEventListener('click', function () { if (state.page < state.totalPages) { state.page++; loadVisits(); } });
  $('lastBtn').addEventListener('click', function () { state.page = state.totalPages; loadVisits(); });
  $('pageInput').addEventListener('change', function () {
    var p = parseInt(this.value, 10);
    if (p >= 1 && p <= state.totalPages) { state.page = p; loadVisits(); }
    else this.value = state.page;
  });

  /* ---------------- 语言切换时重渲染动态内容 ---------------- */
  I18N.onChange(function () {
    if (state.statsData) { renderStats(state.statsData); renderChart(state.statsData); }
    if (state.last) renderVisits(state.last);
    if (getToken() && $('appView').classList.contains('on')) updateWho();
  });

  // 统计每 60 秒自动刷新（明细不自动跳页，避免打断查看）
  setInterval(function () {
    if (getToken() && $('appView').classList.contains('on')) loadStats();
  }, 60000);

  /* ---------------- 启动 ---------------- */
  if (getToken()) {
    // 用一次鉴权请求验证令牌仍有效
    api('/api/visits?page=1&pageSize=20').then(enterApp).catch(function () { showLogin(); });
  } else {
    showLogin();
  }
})();
