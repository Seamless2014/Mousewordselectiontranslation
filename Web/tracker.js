/**
 * tracker.js — 官网访客埋点（访客可见的唯一脚本，仅发送一次页面访问事件）
 * 数据由同源后端 /api/track 记录；无任何第三方服务、无 Cookie、无指纹追踪。
 */
(function () {
  'use strict';

  // 后台页面本身不埋点，避免管理员自己的访问污染统计
  if (/\/admin\.html?$/i.test(location.pathname)) return;

  var payload = {
    path: location.pathname + location.search,
    ref: document.referrer || '',
    lang: (navigator.language || '') + '',
    tz: '' ,
    screen: (window.screen && window.screen.width) ? (window.screen.width + 'x' + window.screen.height) : '',
  };
  try { payload.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}

  function send() {
    var json = JSON.stringify(payload);
    // 优先 sendBeacon（页面卸载也能发出）；不可用时退回 fetch keepalive
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([json], { type: 'application/json' });
        if (navigator.sendBeacon('/api/track', blob)) return;
      }
    } catch (e) { /* 退回 fetch */ }
    try {
      fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        keepalive: true,
        credentials: 'same-origin',
      }).catch(function () {});
    } catch (e) {}
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(send, 0);
  } else {
    window.addEventListener('DOMContentLoaded', send);
  }
})();
