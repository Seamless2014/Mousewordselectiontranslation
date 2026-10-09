/**
 * 悬停取词翻译 —— 内容脚本（轻壳）
 *
 * 职责：
 *  1. 监听鼠标悬停，提取光标下的英文单词
 *  2. 向后台查离线词库（HT_LOOKUP），未命中再走在线兜底（HT_TRANSLATE）
 *  3. 用跟随鼠标的气泡展示释义，鼠标离开自动消失
 *  4. 悬浮球开关 / 右键菜单 / 快捷键 三种启停方式
 *
 * v1.2.0 架构调整：本文件**不再包含词库**。
 *  改造前 dict.js / dict-extra.js 由 manifest 注入，而内容脚本是「每个 frame 一份
 *  独立 JS 环境」，于是每个标签页、每个 iframe 都要各自解析并持有一份 3 万词词库
 *  （堆约 8.7 MB），20 个标签页 × 5 个 iframe 就是约 870 MB。
 *  现在词库由 service worker 全局持有一份，本文件只负责取词、请求、渲染。
 *  词形还原与词条组装也一并移到后台（dict-lookup.js），避免双份实现漂移。
 */
(function () {
  "use strict";

  // 避免在多个 iframe 中重复注入（同一份代码在 all_frames 下会多次执行）
  if (window.__hoverTranslateInjected) return;
  window.__hoverTranslateInjected = true;

  const HT_VERSION = "1.2.1";

  // 后台查词的超时保护：本地查词实测 1–3 ms，200 ms 已经非常宽松。
  // 设这个上限是为了应对「service worker 正在重建」等极端情况 ——
  // 超时后不报错，直接走在线兜底，用户无感。
  const LOCAL_LOOKUP_TIMEOUT = 200;

  // ---------- 状态 ----------
  const state = {
    enabled: true,          // 总开关
    onlineFallback: true,   // 在线兜底
    showPhonetic: true,
    hoverDelay: 320,        // 悬停多久才触发（毫秒）
    bubble: null,           // 气泡 DOM
    ball: null,             // 悬浮球 DOM
    timer: null,            // 悬停延迟计时器
    hideTimer: null,        // 隐藏计时器
    currentWord: null,      // 当前正在展示的词
    reqSeq: 0,              // 请求序号，用于丢弃过期响应
    cache: new Map(),       // 运行时缓存 word -> result
    dictInfo: null,         // 后台词库信息（用于调试与 popup 回退展示）
    mouseX: 0,
    mouseY: 0,
    frameHidden: false      // 若在不可见 iframe 中则禁用
  };

  // ---------- 离线查词（转发给后台）----------
  // 词形还原、两级词库优先级、词条结构组装全部在 service worker 侧完成
  // （见 dict-lookup.js），内容脚本只关心"给我一个能画的结果"。

  /**
   * 向后台请求离线查词。
   *
   * @param {string} word 原始单词（大小写不限）
   * @returns {Promise<object|null>} 命中返回渲染就绪的结果对象，未命中/失败返回 null
   */
  function requestLocal(word) {
    return new Promise(resolve => {
      let settled = false;
      const done = v => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };

      // 超时兜底：后台忙/正在重建时不阻塞，直接交给在线通道
      const timer = setTimeout(() => done(null), LOCAL_LOOKUP_TIMEOUT);

      let sent = false;
      try {
        const ret = chrome.runtime.sendMessage({ type: "HT_LOOKUP", word: word }, resp => {
          if (chrome.runtime.lastError) { done(null); return; }
          if (resp && resp.ok && resp.found && resp.result) done(resp.result);
          else done(null);
        });
        sent = true;
        // 极少数环境下 sendMessage 返回 Promise 而不回调（无回调参数时），
        // 这里保留返回值仅用于吞掉未处理的 rejection，避免控制台噪音。
        if (ret && typeof ret.then === "function") ret.catch(() => {});
      } catch (_) {
        // 扩展重载后旧页面残留脚本会同步抛 "Extension context invalidated"
        done(null);
      }
      // 防御：若 sendMessage 既没回调也没抛错（理论上不会），超时已兜住
      if (!sent) done(null);
    });
  }

  // ---------- 取词 ----------
  // 判断字符是否为英文字母（含连字符、撇号，用于 don't / well-known）
  function isWordChar(ch) {
    return /[A-Za-z'-]/.test(ch);
  }

  /**
   * 从鼠标位置取词。
   * 使用 caretRangeFromPoint 拿到文本节点偏移，再向两侧扩展到完整单词。
   */
  function wordAtPoint(x, y) {
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.setEnd(pos.offsetNode, pos.offset);
      }
    }
    if (!range) return null;

    const node = range.startContainer;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;

    const text = node.nodeValue;
    if (!text) return null;

    let offset = range.startOffset;
    // 光标可能落在单词边界，向后试探一次
    if (offset >= text.length || !isWordChar(text[offset])) {
      if (offset > 0 && isWordChar(text[offset - 1])) offset -= 1;
      else return null;
    }

    let start = offset;
    let end = offset;
    while (start > 0 && isWordChar(text[start - 1])) start--;
    while (end < text.length && isWordChar(text[end])) end++;

    let word = text.slice(start, end).replace(/^['-]+|['-]+$/g, "");
    if (!word || !/[A-Za-z]/.test(word)) return null;
    // 纯单字母不翻译（避免噪音）
    if (word.length < 2) return null;
    // 过长的串忽略（多为编码/混淆串）
    if (word.length > 45) return null;

    return { word: word, node: node, start: start, end: end };
  }

  // 忽略不该取词的区域
  function isIgnoredTarget(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "noscript", "textarea", "code", "pre", "svg", "canvas", "input"].includes(tag)) {
      return tag !== "pre" && tag !== "code"; // pre/code 允许（技术文档常需翻译）
    }
    if (el.isContentEditable) return false;
    return false;
  }

  // ---------- 气泡 ----------
  function ensureBubble() {
    if (state.bubble && document.body.contains(state.bubble)) return state.bubble;
    const el = document.createElement("div");
    el.className = "ht-bubble";
    el.setAttribute("data-ht-owner", "1");
    el.addEventListener("mouseenter", () => {
      // 鼠标移入气泡本身时不要隐藏，方便用户复制
      if (state.hideTimer) { clearTimeout(state.hideTimer); state.hideTimer = null; }
    });
    el.addEventListener("mouseleave", () => scheduleHide(120));
    document.body.appendChild(el);
    state.bubble = el;
    return el;
  }

  function renderLoading(word, text) {
    const el = ensureBubble();
    el.innerHTML =
      '<div class="ht-word">' + escapeHtml(word) + '</div>' +
      '<div class="ht-loading">' + escapeHtml(text || "查询中…") + '</div>';
    positionBubble(el);
  }

  function renderResult(res) {
    const el = ensureBubble();
    let html = "";

    const head = '<span class="ht-word">' + escapeHtml(res.display || res.word) + "</span>";
    const phon = (state.showPhonetic && res.phonetic)
      ? '<span class="ht-phonetic">' + escapeHtml(res.phonetic) + "</span>"
      : "";
    html += '<div class="ht-head">' + head + phon + "</div>";

    // 还原提示：如 running -> run
    if (res.inflected && res.matched && res.matched !== (res.display || res.word).toLowerCase()) {
      html += '<div class="ht-inflect">原形：' + escapeHtml(res.matched) + "</div>";
    }

    const groups = res.groups || [];
    if (groups.length) {
      html += '<div class="ht-body">';
      for (const g of groups) {
        html += '<div class="ht-row">';
        if (g.pos) html += '<span class="ht-pos">' + escapeHtml(g.pos) + "</span>";
        html += '<span class="ht-def">' + escapeHtml(g.text) + "</span>";
        html += "</div>";
      }
      html += "</div>";
    } else {
      html += '<div class="ht-body"><div class="ht-row"><span class="ht-def">' +
        escapeHtml(res.plain || "无释义") + "</span></div></div>";
    }

    const channelName = { google: "Google", mymemory: "MyMemory" }[res.channel] || "";
    let badge;
    if (res.source === "local") {
      // 区分精选词库 / ECDICT 扩展词库 / 连字符合成词，便于判断释义质量来源
      badge = res.tier === "extra" ? "本地词库 · 扩展"
            : res.tier === "compound" ? "本地词库 · 组合"
            : "本地词库";
    } else {
      badge = "在线翻译" + (channelName ? " · " + channelName : "");
    }
    html += '<div class="ht-foot"><span class="ht-badge ht-badge-' + res.source + '">' +
      badge + "</span></div>";

    el.innerHTML = html;
    positionBubble(el);
  }

  function renderError(word, msg) {
    const el = ensureBubble();
    el.innerHTML =
      '<div class="ht-head"><span class="ht-word">' + escapeHtml(word) + "</span></div>" +
      '<div class="ht-body"><div class="ht-row"><span class="ht-def ht-err">' +
      escapeHtml(msg) + "</span></div></div>";
    positionBubble(el);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // 气泡跟随鼠标，并做边界约束避免溢出视口
  function positionBubble(el) {
    if (!el) return;
    const OFFSET = 14;
    const PAD = 8;
    el.style.visibility = "hidden";
    el.style.left = "0px";
    el.style.top = "0px";
    const rect = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    let left = state.mouseX + OFFSET;
    let top = state.mouseY + OFFSET;

    if (left + rect.width + PAD > vw) left = Math.max(PAD, state.mouseX - rect.width - OFFSET);
    if (top + rect.height + PAD > vh) top = Math.max(PAD, state.mouseY - rect.height - OFFSET);

    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(top) + "px";
    el.style.visibility = "visible";
  }

  function showBubble() {
    if (state.hideTimer) { clearTimeout(state.hideTimer); state.hideTimer = null; }
    const el = ensureBubble();
    el.classList.add("ht-show");
  }

  function scheduleHide(delay) {
    if (state.hideTimer) clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(hideBubble, typeof delay === "number" ? delay : 90);
  }

  function hideBubble() {
    if (state.hideTimer) { clearTimeout(state.hideTimer); state.hideTimer = null; }
    if (state.bubble) state.bubble.classList.remove("ht-show");
    state.currentWord = null;
  }

  // ---------- 翻译主流程 ----------
  async function translateWord(rawWord) {
    const seq = ++state.reqSeq;
    const key = rawWord.toLowerCase();

    // 命中缓存
    const cached = state.cache.get(key);
    if (cached) {
      renderResult(cached);
      showBubble();
      return;
    }

    // 1) 离线词库（后台集中持有）。
    //    官方精选词条命中率约 93%，所以"先加载态、后结果"不会闪 ——
    //    正常情况下后台 1–3 ms 就返回，加载态根本来不及出现。
    const local = await requestLocal(rawWord);
    if (seq !== state.reqSeq) return; // 已被更晚的请求取代（鼠标已移到别的词）

    if (local) {
      state.cache.set(key, local);
      renderResult(local);
      showBubble();
      return;
    }

    // 2) 在线兜底
    if (!state.onlineFallback) {
      renderResult({
        word: rawWord, display: rawWord, groups: [],
        plain: "本地词库未收录（在线兜底已关闭）", source: "local"
      });
      showBubble();
      return;
    }

    requestOnline(rawWord, seq);
  }

  /**
   * 在线兜底通道。
   *
   * 加载态延迟 180ms 才显示：网络快时（<180ms 返回）用户直接看到结果，
   * 不会被"查询中…"闪一下，等待感更弱。
   *
   * 失败自动重试（v1.2.1）：第一次用短超时（快失败），失败后不立即报错，
   * 静默重试一次并让后台放宽超时预算（2.5s/3s）。国内网络下在线通道
   * 经常在 700ms 边缘抖动，重试能吃掉绝大多数偶发失败——
   * 之前「有时报错、再悬停又正常」就是这个原因。
   */
  function requestOnline(rawWord, seq, isRetry) {
    const loadingTimer = setTimeout(() => {
      if (seq !== state.reqSeq) return;
      renderLoading(rawWord, isRetry ? "网络较慢，重试中…" : undefined);
      showBubble();
    }, 180);

    // 注意：扩展重载/更新后，旧页面残留的内容脚本调用 sendMessage 会同步抛出
    // "Extension context invalidated"。必须捕获，否则用户看到的是"完全没反应"。
    try {
      chrome.runtime.sendMessage(
        { type: "HT_TRANSLATE", word: rawWord, extended: isRetry === true },
        resp => {
          clearTimeout(loadingTimer);
          if (seq !== state.reqSeq) return;
          if (chrome.runtime.lastError) {
            renderError(rawWord, "翻译失败：扩展上下文失效，请刷新页面");
            return;
          }
          if (!resp || !resp.ok) {
            // 第一次失败：静默重试一次（放宽超时），不打扰用户
            if (!isRetry) {
              requestOnline(rawWord, seq, true);
              return;
            }
            renderError(rawWord, (resp && resp.error) || "在线翻译失败");
            return;
          }
          const res = {
            word: rawWord,
            display: resp.display || rawWord,
            phonetic: resp.phonetic || "",
            groups: resp.groups || [],
            plain: resp.plain || "",
            source: "online",
            channel: resp.source || ""   // google / mymemory，用于气泡角标显示
          };
          state.cache.set(rawWord.toLowerCase(), res);
          renderResult(res);
          showBubble();
        }
      );
    } catch (err) {
      clearTimeout(loadingTimer);
      renderError(rawWord, "扩展已更新，请刷新页面（F5）后使用");
    }
  }

  // ---------- 事件绑定 ----------
  function onMouseMove(e) {
    state.mouseX = e.clientX;
    state.mouseY = e.clientY;
    // 气泡可见时实时跟随
    if (state.bubble && state.bubble.classList.contains("ht-show")) {
      positionBubble(state.bubble);
    }

    if (!state.enabled || state.frameHidden) return;
    // 指针位于悬浮球/气泡上：不取词，也不重置计时
    const t = e.target;
    if (t && t.closest && t.closest("[data-ht-owner]")) return;

    // 悬停意图检测：鼠标停下 hoverDelay 毫秒后才取词。
    // 用 mousemove（而非 mouseover）驱动 —— mouseover 只在跨元素边界时触发，
    // 同一段落内从词 A 挪到词 B 不会再次触发，导致后文单词全部无响应。
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      attemptTranslate(state.mouseX, state.mouseY);
    }, state.hoverDelay);
  }

  /**
   * 在指定坐标尝试取词翻译（由 mousemove 防抖触发）。
   */
  function attemptTranslate(x, y) {
    // 指针已移到我们自己的气泡/悬浮球上，避免把气泡内容当页面词查询
    // （elementFromPoint 在极端环境下可能缺失，缺失时跳过该检查即可）
    const under = document.elementFromPoint ? document.elementFromPoint(x, y) : null;
    if (under && under.closest && under.closest("[data-ht-owner]")) return;

    const hit = wordAtPoint(x, y);
    if (!hit) {
      // 悬停在图片/空白/非文本区域 → 收起气泡
      scheduleHide(120);
      return;
    }
    const w = hit.word.toLowerCase();
    if (w === state.currentWord &&
        state.bubble && state.bubble.classList.contains("ht-show")) {
      return; // 同一个词且气泡已在显示，不重复查询
    }
    state.currentWord = w;
    // translateWord 是 async：这里 deliberately 不 await，
    // 它内部用 reqSeq 自行丢弃过期响应，不会阻塞后续鼠标事件。
    translateWord(hit.word).catch(() => {});
  }

  function onMouseOutWindow(e) {
    // relatedTarget 为 null 表示鼠标离开了整个页面窗口
    if (!e.relatedTarget) scheduleHide(120);
  }

  function onScroll() { hideBubble(); }
  function onKeyDown(e) {
    if (e.key === "Escape") hideBubble();
  }

  // ---------- 悬浮球 ----------
  function ensureBall() {
    if (state.ball && document.body.contains(state.ball)) return state.ball;
    const el = document.createElement("div");
    el.className = "ht-ball";
    el.setAttribute("data-ht-owner", "1");
    el.title = "悬停取词翻译：点击开启/关闭（Alt+Shift+T）";
    el.addEventListener("click", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      setEnabled(!state.enabled, true);
    });
    // 悬浮球自身不触发取词
    el.addEventListener("mouseover", ev => ev.stopPropagation());
    document.body.appendChild(el);
    state.ball = el;
    updateBall();
    return el;
  }

  function updateBall() {
    if (!state.ball) return;
    state.ball.classList.toggle("ht-ball-on", state.enabled);
    state.ball.classList.toggle("ht-ball-off", !state.enabled);
    state.ball.textContent = state.enabled ? "译" : "×";
  }

  function setEnabled(v, persist) {
    state.enabled = !!v;
    updateBall();
    if (!state.enabled) hideBubble();
    // 直接写 storage，不经过后台中转：
    // 避免「内容脚本 -> 后台 -> storage -> onChanged -> 内容脚本」的往返竞态
    // （service worker 休眠时中转消息可能丢失，导致开关状态刷新后回滚）
    if (persist) {
      try {
        chrome.storage.sync.set({ enabled: state.enabled }, () => {
          void chrome.runtime.lastError;
        });
      } catch (_) {}
    }
  }

  // ---------- 初始化 ----------
  function isFrameUsable() {
    try {
      if (window.top !== window.self) {
        // 不可见的 iframe 中不启用（多为埋点/隐藏容器）
        return window.innerWidth > 0 && window.innerHeight > 0;
      }
    } catch (_) {
      // 跨域 iframe 访问 top 会抛错，说明自身就是子框架
      return window.innerWidth > 0 && window.innerHeight > 0;
    }
    return true;
  }

  function loadSettings() {
    chrome.storage.sync.get(
      { enabled: true, onlineFallback: true, showPhonetic: true, hoverDelay: 320, showBall: true },
      cfg => {
        if (chrome.runtime.lastError) return;
        state.enabled = cfg.enabled !== false;
        state.onlineFallback = cfg.onlineFallback !== false;
        state.showPhonetic = cfg.showPhonetic !== false;
        state.hoverDelay = Math.max(80, Number(cfg.hoverDelay) || 320);
        updateBall();
        if (cfg.showBall) ensureBall();
      }
    );
  }

  function listenStorage() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if (changes.enabled) setEnabled(changes.enabled.newValue !== false, false);
      if (changes.onlineFallback) state.onlineFallback = changes.onlineFallback.newValue !== false;
      if (changes.showPhonetic) state.showPhonetic = changes.showPhonetic.newValue !== false;
      if (changes.hoverDelay) state.hoverDelay = Math.max(80, Number(changes.hoverDelay.newValue) || 320);
      if (changes.showBall) {
        if (changes.showBall.newValue) ensureBall();
        else if (state.ball) { state.ball.remove(); state.ball = null; }
      }
    });
  }

  function listenMessages() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return;
      if (msg.type === "HT_SET") {
        // 明确目标状态（来自右键菜单 / 快捷键）
        setEnabled(msg.enabled !== false, false);
        sendResponse({ ok: true, enabled: state.enabled });
      } else if (msg.type === "HT_TOGGLE") {
        // 兼容：翻转当前状态，并持久化
        setEnabled(!state.enabled, true);
        sendResponse({ ok: true, enabled: state.enabled });
      } else if (msg.type === "HT_PING") {
        sendResponse({ ok: true, enabled: state.enabled });
      }
      return true;
    });
  }

  function start() {
    state.frameHidden = !isFrameUsable();
    loadSettings();
    if (state.frameHidden) return;

    ensureBall();
    listenStorage();
    listenMessages();
    probeDictInfo();

    document.addEventListener("mousemove", onMouseMove, { passive: true, capture: true });
    document.addEventListener("mouseout", onMouseOutWindow, true);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", hideBubble);

    // 加载成功标记：用户可在控制台（F12）确认脚本已注入
    try {
      console.info("%c[悬停取词翻译] v" + HT_VERSION + " 已加载，悬停英文单词即可翻译",
        "color:#4a8cff;font-weight:600");
    } catch (_) {}
  }

  /**
   * 拉取后台词库信息（词条数 / 可用状态）。
   *
   * 目的不是功能必需，而是排障：v1.1 时代词库跟内容脚本同域，控制台能直接
   * 看到 LOCAL_DICT 有多少条；现在词库在 worker 里，这里主动问一次并打印，
   * 保持同等可观测性。失败静默，不影响取词。
   */
  function probeDictInfo() {
    try {
      chrome.runtime.sendMessage({ type: "HT_DICT_INFO" }, resp => {
        if (chrome.runtime.lastError) return;
        if (!resp || !resp.ok) {
          console.warn("[悬停取词翻译] 后台词库未就绪，本次仅能使用在线翻译");
          return;
        }
        state.dictInfo = resp;
        try {
          console.info("[悬停取词翻译] 离线词库已就绪：精选 " + resp.core +
            " 条 + 扩展 " + resp.extra + " 条 = " + resp.total + " 条（由后台统一持有）");
        } catch (_) {}
      });
    } catch (_) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
