/**
 * 悬停取词翻译 —— 内容脚本
 *
 * 职责：
 *  1. 监听鼠标悬停，提取光标下的英文单词并做词形还原
 *  2. 本地词库优先命中（零延迟），未命中走在线兜底
 *  3. 用跟随鼠标的气泡展示释义，鼠标离开自动消失
 *  4. 悬浮球开关 / 右键菜单 / 快捷键 三种启停方式
 */
(function () {
  "use strict";

  // 避免在多个 iframe 中重复注入（同一份代码在 all_frames 下会多次执行）
  if (window.__hoverTranslateInjected) return;
  window.__hoverTranslateInjected = true;

  const HT_VERSION = "1.1.0";

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
    mouseX: 0,
    mouseY: 0,
    frameHidden: false      // 若在不可见 iframe 中则禁用
  };

  // ---------- 词形还原 ----------
  // 规则表：后缀 -> 候选还原方式（按优先级）
  const IRREGULAR = {
    was: "be", were: "be", been: "be", is: "be", are: "be", am: "be",
    has: "have", had: "have", did: "do", does: "do", done: "do",
    went: "go", gone: "go", made: "make", took: "take", taken: "take",
    gave: "give", given: "give", found: "find", knew: "know", known: "know",
    thought: "think", saw: "see", seen: "see", wanted: "want",
    said: "say", told: "tell", became: "become", left: "leave",
    kept: "keep", began: "begin", begun: "begin", ran: "run",
    brought: "bring", wrote: "write", written: "write", stood: "stand",
    lost: "lose", paid: "pay", met: "meet", led: "lead",
    understood: "understand", spoke: "speak", spoken: "speak",
    read: "read", spent: "spend", grew: "grow", grown: "grow",
    won: "win", offered: "offer", built: "build", fell: "fall",
    fell2: "fall", cut: "cut", reached: "reach", remained: "remain",
    suggested: "suggest", raised: "raise", passed: "pass", sold: "sell",
    required: "require", reported: "report", decided: "decide",
    returned: "return", explained: "explain", developed: "develop",
    carried: "carry", broke: "break", broken: "break", received: "receive",
    agreed: "agree", produced: "produce", ate: "eat", eaten: "eat",
    covered: "cover", caught: "catch", drew: "draw", drawn: "draw",
    chose: "choose", chosen: "choose", caused: "cause",
    children: "child", men: "man", women: "woman", feet: "foot",
    teeth: "tooth", mice: "mouse", people: "people", lives: "life",
    better: "good", best: "good", worse: "bad", worst: "bad",
    more: "much", most: "much", less: "little", least: "little",
    data: "data", analyses: "analysis", indices: "index"
  };

  /**
   * 词形还原。
   * 返回值有两种形态：
   *   - 命中不规则词表时返回 string（唯一原形，如 running -> run 中 was -> "be"）
   *   - 否则返回候选词数组（按优先级排列），交由调用方逐个查词库
   */
  function lemmatize(word) {
    const w = word.toLowerCase();
    if (IRREGULAR[w]) return IRREGULAR[w];
    if (w.length <= 3) return w;

    const cands = [];
    // 复数 / 第三人称单数
    if (w.endsWith("ies")) cands.push(w.slice(0, -3) + "y");
    if (w.endsWith("ves")) cands.push(w.slice(0, -3) + "f", w.slice(0, -3) + "fe");
    if (w.endsWith("ses") || w.endsWith("xes") || w.endsWith("zes") ||
        w.endsWith("ches") || w.endsWith("shes")) cands.push(w.slice(0, -2));
    if (w.endsWith("es")) cands.push(w.slice(0, -1), w.slice(0, -2));
    if (w.endsWith("s") && !w.endsWith("ss")) cands.push(w.slice(0, -1));
    // 进行时 / 动名词
    if (w.endsWith("ying")) cands.push(w.slice(0, -4) + "ie", w.slice(0, -4) + "y");
    if (w.endsWith("ing")) {
      cands.push(w.slice(0, -3), w.slice(0, -3) + "e");
      // 双写辅音：running -> run
      const stem = w.slice(0, -3);
      if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
        cands.push(stem.slice(0, -1));
      }
    }
    // 过去式 / 过去分词
    if (w.endsWith("ied")) cands.push(w.slice(0, -3) + "y");
    if (w.endsWith("ed")) {
      cands.push(w.slice(0, -2), w.slice(0, -1));
      const stem = w.slice(0, -2);
      if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
        cands.push(stem.slice(0, -1));
      }
    }
    // 比较级 / 最高级
    if (w.endsWith("ier")) cands.push(w.slice(0, -3) + "y");
    if (w.endsWith("iest")) cands.push(w.slice(0, -4) + "y");
    if (w.endsWith("er")) cands.push(w.slice(0, -2), w.slice(0, -1));
    if (w.endsWith("est")) cands.push(w.slice(0, -3), w.slice(0, -2));
    // 副词
    if (w.endsWith("ily")) cands.push(w.slice(0, -3) + "y");
    if (w.endsWith("ly")) cands.push(w.slice(0, -2), w.slice(0, -2) + "e");

    return cands.length ? cands : w;
  }

  /**
   * 在单个词库对象中查词。
   * @param {object} dict 词库对象（LOCAL_DICT 或 DICT_EXTRA）
   * @param {string} key  小写单词
   * @returns {object|null} 命中则返回词条对象
   */
  function lookupInDict(dict, key) {
    if (!dict || typeof dict !== "object") return null;
    // 兼容 __proto__ / constructor 等原型链上的名字，避免误命中
    if (!Object.prototype.hasOwnProperty.call(dict, key)) return null;
    const entry = dict[key];
    return entry && typeof entry === "object" ? entry : null;
  }

  /**
   * 依次尝试：原词 -> 各还原候选，返回首个命中的词条。
   * 查询顺序：精选词库 dict.js 优先（释义更精炼、词性更准），
   * 未命中再查 ECDICT 扩展词库 dict-extra.js。
   * 这样精选词条的展示质量不会被机器生成的释义覆盖。
   */
  function lookupLocal(rawWord) {
    // 两个词库都缺失时降级为纯在线模式，不让异常中断取词流程
    const hasMain = typeof LOCAL_DICT === "undefined" ? false : !!LOCAL_DICT;
    const hasExtra = typeof DICT_EXTRA === "undefined" ? false : !!DICT_EXTRA;
    if (!hasMain && !hasExtra) return null;

    const w = rawWord.toLowerCase();
    const dicts = [];
    if (hasMain) dicts.push(LOCAL_DICT);
    if (hasExtra) dicts.push(DICT_EXTRA);

    // 按词库优先级依次查：先原词，再还原候选
    for (const dict of dicts) {
      const hit = lookupInDict(dict, w);
      if (hit) return { word: w, entry: hit, matched: w };
    }

    const res = lemmatize(w);
    // lemmatize 命中不规则词表时直接返回字符串（唯一原形），否则返回候选数组
    const cands = typeof res === "string" ? [res] : (Array.isArray(res) ? res : []);

    for (const c of cands) {
      if (!c || c === w) continue;
      for (const dict of dicts) {
        const hit = lookupInDict(dict, c);
        if (hit) return { word: w, entry: hit, matched: c, inflected: true };
      }
    }
    return null;
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

  function renderLoading(word) {
    const el = ensureBubble();
    el.innerHTML =
      '<div class="ht-word">' + escapeHtml(word) + '</div>' +
      '<div class="ht-loading">查询中…</div>';
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
      // 区分精选词库与 ECDICT 扩展词库，便于判断释义质量来源
      badge = res.tier === "extra" ? "本地词库 · 扩展" : "本地词库";
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
  function translateWord(rawWord) {
    const seq = ++state.reqSeq;

    // 命中缓存
    const cached = state.cache.get(rawWord.toLowerCase());
    if (cached) {
      renderResult(cached);
      showBubble();
      return;
    }

    // 1) 本地词库
    const local = lookupLocal(rawWord);
    if (local) {
      const res = buildLocalResult(local);
      state.cache.set(rawWord.toLowerCase(), res);
      if (seq !== state.reqSeq) return; // 已被更晚的请求取代
      renderResult(res);
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

    // 加载态延迟 180ms 才显示：网络快时（<180ms 返回）用户直接看到结果，
    // 不会被"查询中…"闪一下，等待感更弱。
    const loadingTimer = setTimeout(() => {
      if (seq !== state.reqSeq) return;
      renderLoading(rawWord);
      showBubble();
    }, 180);

    // 注意：扩展重载/更新后，旧页面残留的内容脚本调用 sendMessage 会同步抛出
    // "Extension context invalidated"。必须捕获，否则用户看到的是"完全没反应"。
    try {
      chrome.runtime.sendMessage({ type: "HT_TRANSLATE", word: rawWord }, resp => {
        clearTimeout(loadingTimer);
        if (seq !== state.reqSeq) return;
        if (chrome.runtime.lastError) {
          renderError(rawWord, "翻译失败：扩展上下文失效，请刷新页面");
          return;
        }
        if (!resp || !resp.ok) {
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
      });
    } catch (err) {
      clearTimeout(loadingTimer);
      renderError(rawWord, "扩展已更新，请刷新页面（F5）后使用");
    }
  }

  function buildLocalResult(local) {
    const entry = local.entry;
    const groups = [];
    const posList = (entry.p || "").split("/").filter(Boolean);
    const defs = (entry.t || "").split(/[；;]/).map(s => s.trim()).filter(Boolean);

    if (posList.length > 1 && defs.length > 1) {
      // 多词性：按前 N-1 个词性分组展示（粗略映射）
      const per = Math.ceil(defs.length / posList.length);
      posList.forEach((p, i) => {
        const chunk = defs.slice(i * per, (i + 1) * per).join("；");
        if (chunk) groups.push({ pos: p, text: chunk });
      });
    } else {
      groups.push({ pos: posList[0] || "", text: defs.join("；") });
    }

    return {
      word: local.word,
      matched: local.matched,
      display: local.word,
      // ECDICT 扩展词库带 k（音标）字段；精选词库 dict.js 通常没有
      phonetic: entry.k || "",
      inflected: !!local.inflected,
      groups: groups,
      plain: entry.t,
      source: "local",
      // 标记词条来源，气泡角标可区分"精选词库 / 扩展词库"
      tier: entry.k !== undefined ? "extra" : "core"
    };
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
    translateWord(hit.word);
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
