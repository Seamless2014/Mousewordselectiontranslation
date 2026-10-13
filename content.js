/**
 * 悬停取词翻译 —— 内容脚本（轻壳）
 *
 * 职责：
 *  1. 监听鼠标悬停，提取光标下的英文单词或词组
 *  2. 向后台查离线词库（HT_LOOKUP），未命中再走在线兜底（HT_TRANSLATE）
 *  3. 用跟随鼠标的气泡展示释义，鼠标离开自动消失
 *  4. 悬浮球开关 / 右键菜单 / 快捷键 三种启停方式
 *
 * v1.2.0 架构调整：本文件**不再包含词库**。
 *  改造前 dict.js / dict-extra.js 由 manifest 注入，而内容脚本是「每个 frame 一份
 *  独立 JS 环境」，于是每个标签页、每个 iframe 都要各自解析并持有一份词库
 *  （堆约 34 MB），20 个标签页 × 5 个 iframe 就是约 3.4 GB。
 *  现在词库由 service worker 全局持有一份（SW 堆约 9.5 MB，不随标签页增长），
 *  本文件只负责取词、请求、渲染。
 *  词形还原与词条组装也一并移到后台（dict-lookup.js），避免双份实现漂移。
 *
 * v1.3.0 词组支持：悬停取词从「单个单词」扩展为「单词 + 一组词组候选」。
 *  以悬停词为中心向左右收集相邻词，枚举所有子串（由短到长）一并交给后台，
 *  后台按「core 单词优先 / extra 单词让位词组」的分层规则决定最终返回哪一个。
 *  详见 phraseCandidates 与 background.js 的 lookupOffline。
 */
(function () {
  "use strict";

  // 避免在多个 iframe 中重复注入（同一份代码在 all_frames 下会多次执行）
  if (window.__hoverTranslateInjected) return;
  window.__hoverTranslateInjected = true;

  const HT_VERSION = "1.5.0";

  // 后台查词的超时保护：本地查词实测 1–3 ms，200 ms 已经非常宽松。
  // 设这个上限是为了应对「service worker 正在重建」等极端情况 ——
  // 超时后不报错，直接走在线兜底，用户无感。
  const LOCAL_LOOKUP_TIMEOUT = 200;
  // 冷启动超时：SW 被休眠后首次唤醒需要重新 importScripts 解析 6.2MB 词库，
  // 低端机/磁盘繁忙时 200ms 可能不够，首次放宽到 600ms。
  // 收到首次 SW 响应后自动切回 200ms。
  const COLD_LOOKUP_TIMEOUT = 600;
  let localLookupCold = true;   // 是否仍处于冷启动期

  // 内容侧缓存上限（条）。后台是 800 条（全浏览器共享），内容侧是页面级、
  // 只缓存本页查过的词，故上限更小；长时间挂着的长文档不会让缓存无限增长。
  const CACHE_MAX = 500;

  // ---------- 状态 ----------
  const state = {
    enabled: true,          // 总开关
    onlineFallback: true,   // 在线兜底
    showPhonetic: true,
    showTts: true,          // 气泡显示发音按钮（v1.5.0）
    enableSelection: true,  // 启用划词/双击查询（v1.5.0）
    showBall: true,         // 显示悬浮球
    hoverDelay: 320,        // 悬停多久才触发（毫秒）
    bubble: null,           // 气泡 DOM
    ball: null,             // 悬浮球 DOM
    ballPos: null,           // 悬浮球已保存的位置 {left, top}（px）；null = 用默认右下角
    ballDragging: false,     // 是否正在拖动悬浮球
    ballSuppressClick: false, // 拖拽结束后抑制紧随的 click，避免误切成开关
    timer: null,            // 悬停延迟计时器
    hideTimer: null,        // 隐藏计时器
    currentWord: null,      // 当前正在展示的词
    currentTtsWord: "",     // 当前气泡的发音目标词（供 speakWord 使用）
    lastSelectionKey: "",   // 最近查过的选区文本（去重，避免双击后 mouseup 二次查询）
    reqSeq: 0,              // 请求序号，用于丢弃过期响应
    cache: new Map(),       // 运行时缓存 word -> result
    dictInfo: null,         // 后台词库信息（用于调试与 popup 回退展示）
    mouseX: 0,
    mouseY: 0,
    frameHidden: false,      // 若在不可见 iframe 中则禁用
    disabledSites: [],       // 站点黑名单（域名数组）
    siteDisabled: false      // 当前站点是否在黑名单中（运行时判断）
  };

  // ---------- 缓存（LRU）----------
  // 命中时移到末尾（最近使用），写入时超上限淘汰最旧一条，
  // 与后台 cacheGet/cacheSet 保持同一套语义。
  function cacheGet(key) {
    if (!state.cache.has(key)) return null;
    const v = state.cache.get(key);
    state.cache.delete(key);
    state.cache.set(key, v);
    return v;
  }
  function cacheSet(key, value) {
    if (state.cache.has(key)) state.cache.delete(key);
    state.cache.set(key, value);
    if (state.cache.size > CACHE_MAX) {
      const oldest = state.cache.keys().next().value;
      state.cache.delete(oldest);
    }
  }

  // ---------- 离线查词（转发给后台）----------
  // 词形还原、两级词库优先级、词条结构组装全部在 service worker 侧完成
  // （见 dict-lookup.js），内容脚本只关心"给我一个能画的结果"。

  /**
   * 向后台请求离线查词。
   *
   * @param {string} word   原始单词（大小写不限）
   * @param {string[]} [phrases] 词组候选（由短到长）。仅当单词未命中时才尝试。
   * @returns {Promise<object|null>} 命中返回渲染就绪的结果对象，未命中/失败返回 null
   */
  function requestLocal(word, phrases) {
    return new Promise(resolve => {
      let settled = false;
      const done = v => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };

      // 超时兜底：后台忙/正在重建时不阻塞，直接交给在线通道。
      // 冷启动期（SW 首次唤醒需重新 importScripts 解析词库）放宽到 600ms，
      // 收到首次 SW 响应后切回 200ms。
      const timer = setTimeout(() => done(null), localLookupCold ? COLD_LOOKUP_TIMEOUT : LOCAL_LOOKUP_TIMEOUT);

      let sent = false;
      try {
        const ret = chrome.runtime.sendMessage(
          { type: "HT_LOOKUP", word: word, phrases: phrases || [] },
          resp => {
            if (chrome.runtime.lastError) { done(null); return; }
            // SW 已就绪（无论是否命中，只要回应了就说明 importScripts 完成）
            localLookupCold = false;
            if (resp && resp.ok && resp.found && resp.result) done(resp.result);
            else done(null);
          }
        );
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

  // 词组查询时，单词之间的分隔只能是空格（不含标点）。
  // 词组词库的键是「纯小写字母 + 单空格」，所以遇到逗号/句号就该停下，
  // 否则 "look forward to, and" 这类会一路吃进去导致查不到。
  function isPhraseSpace(ch) {
    return ch === " " || ch === "\u00a0" || ch === "\t";
  }

  // 词组候选的最大词数：与词库构建时的上限（6 段）保持一致
  const PHRASE_MAX_WORDS = 6;

  // ---------- Shadow DOM 穿透 ----------
  // 真机实测（chromium-1234 + playwright，见 verify-shadow-dom.js）：
  //   1) document.caretRangeFromPoint(x, y) 命中 shadow host 时返回 host 本身，
  //      startContainer 是元素节点（DIV）而非文本节点 —— wordAtPoint 在
  //      nodeType !== TEXT_NODE 检查处直接 return null，shadow 内文本无法取词。
  //   2) ShadowRoot.caretRangeFromPoint 在 Chromium 上不存在（返回 null），
  //      无法直接拿到 shadow 内的文本偏移。
  //   3) ShadowRoot.elementFromPoint(x, y) 在 open shadow 上可用，能定位到
  //      shadow 树内的具体元素；嵌套 shadow 需递归一层层进入。
  //   4) closed shadow 的 shadowRoot 在外部为 null（Web 标准限制），
  //      天然不可穿透 —— 本函数不处理 closed shadow，标准限制无解。

  /**
   * 在文本节点中找最接近 (x, y) 的字符偏移。
   * 用单字符 range.getBoundingClientRect 判断光标落在哪个字符内。
   * @param {Text} textNode
   * @param {number} x 视口 x
   * @param {number} y 视口 y
   * @returns {{node:Text, offset:number, dist:number}|null} dist=0 表示精确命中
   */
  function findCaretOffset(textNode, x, y) {
    const len = textNode.nodeValue.length;
    if (len === 0) return null;
    // 先用整段 rect 判断 y 是否落在该文本行（多行文本时排除非命中行）
    const whole = document.createRange();
    whole.selectNodeContents(textNode);
    const wr = whole.getBoundingClientRect();
    if (!wr || wr.height === 0) return null;
    if (y < wr.top - 2 || y > wr.bottom + 2) return null;

    // 二分查找 x 命中的字符（英文 LTR，字符按 offset 单调递增）
    let lo = 0, hi = len;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const r = document.createRange();
      r.setStart(textNode, mid);
      r.setEnd(textNode, mid + 1);
      const rect = r.getBoundingClientRect();
      if (x < rect.left) hi = mid;
      else if (x > rect.right) lo = mid + 1;
      else return { node: textNode, offset: mid, dist: 0 };
    }
    // 二分未精确命中，取边界两侧最近的字符择优
    const candidates = [Math.max(0, lo - 1), Math.min(len - 1, lo)];
    let best = null;
    for (const idx of candidates) {
      if (idx < 0 || idx >= len) continue;
      const r = document.createRange();
      r.setStart(textNode, idx);
      r.setEnd(textNode, idx + 1);
      const rect = r.getBoundingClientRect();
      if (!rect || rect.width === 0) continue;
      const dx = x < rect.left ? (rect.left - x)
               : x > rect.right ? (x - rect.right) : 0;
      const dist = dx * dx;
      if (!best || dist < best.dist) best = { node: textNode, offset: idx, dist };
    }
    return best;
  }

  /**
   * Shadow DOM 穿透取词：拿到 shadow 内文本节点的 Range。
   *
   * 步骤：
   *   1. document.elementFromPoint 拿顶层元素
   *   2. 若 el.shadowRoot（open）存在，递归 el.shadowRoot.elementFromPoint 穿透
   *      （depth<10 防御极限嵌套；closed shadow 的 shadowRoot 为 null 自然停下）
   *   3. TreeWalker 收集最深层元素的文本节点
   *   4. 对每个文本节点二分查找最接近 (x, y) 的 offset
   *   5. 返回 startContainer 为文本节点的 Range
   *
   * @param {number} x 视口 x
   * @param {number} y 视口 y
   * @returns {Range|null} startContainer 为文本节点的 Range
   */
  function shadowCaretFromPoint(x, y) {
    let el = document.elementFromPoint ? document.elementFromPoint(x, y) : null;
    if (!el) return null;

    // 递归穿透 open shadow（closed shadow 的 shadowRoot 为 null，自然停下）
    let depth = 0;
    while (el && el.shadowRoot && depth < 10) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
      depth++;
    }
    if (!el) return null;

    // 在 el 子树内收集文本节点，找最接近 (x, y) 的字符位置
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let best = null;
    let tn;
    while ((tn = walker.nextNode())) {
      const value = tn.nodeValue;
      if (!value || !/[A-Za-z]/.test(value)) continue;
      const hit = findCaretOffset(tn, x, y);
      if (!hit) continue;
      if (!best || hit.dist < best.dist) {
        best = hit;
        if (best.dist === 0) break;   // 精确命中，无需继续遍历
      }
    }
    if (!best) return null;

    const range = document.createRange();
    range.setStart(best.node, best.offset);
    range.setEnd(best.node, best.offset);
    return range;
  }

  /**
   * 从鼠标位置取「词」或「词组」。
   *
   * 使用 caretRangeFromPoint 拿到文本节点偏移，再向两侧扩展到完整单词。
   *
   * v1.3.0 起额外给出一组「词组候选」（phrases）：
   *   以悬停词为中心，逐个向左右扩展生成的子串，由短到长排列。
   *
   * 为什么给一组而不是一个？
   *   悬停在 "insofar as possible abide by" 的 insofar 上时，唯一正确的
   *   答案 "insofar as" 恰好是「左 0 词 / 右 1 词」——固定的「左右各取 2 词」
   *   会产出 "we should insofar as possible" 而查不到。词组长度不可预知，
   *   所以只能让后台按「由短到长」逐个试，命中即止。
   *
   * @returns {{word:string, phrases:string[], node:Node, start:number, end:number}|null}
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
    // Shadow DOM fallback：caretRangeFromPoint 命中 shadow host 时
    // startContainer 是元素节点（DIV）而非文本节点，下面 L177 会 return null。
    // 改为先探测 startContainer 是否为文本节点，不是则 fallback 到
    // shadowCaretFromPoint（递归 shadowRoot.elementFromPoint + 二分定位）。
    // 真机实测见 verify-shadow-dom.js；closed shadow 因标准限制不处理。
    if (!range || !range.startContainer ||
        range.startContainer.nodeType !== Node.TEXT_NODE) {
      const shadowRange = shadowCaretFromPoint(x, y);
      if (shadowRange) range = shadowRange;
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

    return {
      word: word,
      phrases: phraseCandidates(text, start, end),
      node: node,
      start: start,
      end: end
    };
  }

  /**
   * 取 [start, end) 处单词的左右相邻单词序列。
   *
   * 只在同一个文本节点内扩展——跨节点（如 <b> 包裹）会让取词范围难以界定，
   * 且词组词库本身按「文本里的连续空格串」构建，同节点扩展已覆盖绝大多数场景。
   *
   * @returns {{left:string[], right:string[]}} 左侧按「紧邻→远」排列，右侧同理
   */
  function neighborWords(text, start, end) {
    const left = [];
    const right = [];

    // 向左收集
    let i = start;
    while (left.length < PHRASE_MAX_WORDS - 1) {
      let j = i - 1;
      if (j < 0 || !isPhraseSpace(text[j])) break;
      while (j >= 0 && isPhraseSpace(text[j])) j--;   // 跳过连续空格
      let k = j;
      while (k >= 0 && isWordChar(text[k])) k--;      // 退回单词起始
      if (k === j) break;                              // 空格前不是字母，停
      const seg = text.slice(k + 1, j + 1);
      if (!/^[A-Za-z][A-Za-z'-]*$/.test(seg)) break;   // 段内必须纯字母
      left.push(seg);
      i = k + 1;
    }

    // 向右收集
    let p = end;
    while (right.length < PHRASE_MAX_WORDS - 1) {
      let j = p;
      if (j >= text.length || !isPhraseSpace(text[j])) break;
      while (j < text.length && isPhraseSpace(text[j])) j++;
      let k = j;
      while (k < text.length && isWordChar(text[k])) k++;
      if (k === j) break;
      const seg = text.slice(j, k);
      if (!/^[A-Za-z][A-Za-z'-]*$/.test(seg)) break;
      right.push(seg);
      p = k;
    }

    return { left: left, right: right };
  }

  /**
   * 生成词组候选列表：以 [start, end) 为中心，向两侧扩展的所有子串。
   *
   * 排序策略（决定命中优先级）：
   *   1. 先按「总词数」由短到长 —— 短搭配更可能是固定词组。
   *   2. 同长度内，优先「悬停词位于两端」的候选。
   *      例：悬停 out 时，同为 3 词的 "out of the" 与 "out of the blue" 不存在；
   *      但 4 词时有 "out of the blue"，而 "out of" 只有 2 词会先命中。
   *      这条规则确保 "look forward" 不抢先于 "look forward to" 的地位
   *      （两者都含悬停词，长度决定顺序，短的先）。
   *   3. 再按「围绕中心更紧凑」排列（左右词数更均衡）。
   *
   * 为什么不做「最长优先」：
   *   "as soon as possible" 与 "as soon as" 都收录时，最长优先会返回
   *   "尽快"，而 "as soon as"（"一...就"）才是真正的核心搭配。
   *   长度不可作为质量代理，所以仍以「短的先」为准。
   *
   * @returns {string[]} 规范化后的词组候选（小写、单空格），可能为空数组
   */
  function phraseCandidates(text, start, end) {
    const { left, right } = neighborWords(text, start, end);
    const center = text.slice(start, end).replace(/^['-]+|['-]+$/g, "").toLowerCase();
    if (!center) return [];

    const out = [];
    const seen = Object.create(null);

    // 枚举左右各取 a / b 个词的所有组合
    for (let total = 2; total <= PHRASE_MAX_WORDS; total++) {
      for (let a = 0; a < total; a++) {          // a = 左侧词数
        const b = total - 1 - a;                  // b = 右侧词数
        if (a > left.length || b > right.length) continue;
        // 左词按「远→近」排列，右词按「近→远」排列
        const seg = [];
        for (let i = a - 1; i >= 0; i--) seg.push(left[i]);
        seg.push(center);
        for (let i = 0; i < b; i++) seg.push(right[i]);
        const key = seg.join(" ").toLowerCase();
        if (seen[key]) continue;
        seen[key] = 1;
        out.push(key);
      }
    }
    return out;
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
    // 事件委托：发音按钮点击（按钮随 innerHTML 重建，不能用直接 addEventListener）
    el.addEventListener("click", e => {
      const btn = e.target.closest && e.target.closest(".ht-tts");
      if (!btn) return;
      e.stopPropagation();
      e.preventDefault();
      const w = btn.getAttribute("data-word") || state.currentTtsWord;
      if (w) speakWord(w);
    });
    document.body.appendChild(el);
    state.bubble = el;
    return el;
  }

  /**
   * 发音按钮内联 SVG（小喇叭）。
   * 用 SVG 而非 Unicode 表情：在所有字号下都能保持像素清晰，
   * 且与气泡深色主题色调一致。
   */
  const TTS_ICON_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M3 5.5h1.7l2.6-2.1c.4-.3.97-.02.97.46v6.28c0 .48-.57.76-.97.46L4.7 8.5H3' +
    'a.5.5 0 0 1-.5-.5v-2A.5.5 0 0 1 3 5.5z" fill="currentColor"/>' +
    '<path d="M10.2 4.6c2.06.94 2.06 6.86 0 7.8M11.6 2.9c3.5 1.6 3.5 9.6 0 11.2" ' +
    'fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';

  /**
   * 朗读单词：发消息到后台，由后台 chrome.tts.speak 执行。
   * 在 service worker 里调用是因为 content script 没法直接用 chrome.tts API。
   */
  function speakWord(word) {
    if (!word) return;
    try {
      chrome.runtime.sendMessage({ type: "HT_TTS", word: word }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {
      // 扩展重载后旧页面残留脚本会同步抛 "Extension context invalidated"
    }
  }

  function renderLoading(word, text) {
    const el = ensureBubble();
    state.currentTtsWord = "";   // 加载中无发音目标，清空防止旧值误读
    el.innerHTML =
      '<div class="ht-word">' + escapeHtml(word) + '</div>' +
      '<div class="ht-loading">' + escapeHtml(text || "查询中…") + '</div>';
    positionBubble(el);
  }

  function renderResult(res) {
    const el = ensureBubble();
    let html = "";

    const displayWord = res.display || res.word || "";
    // 发音按钮：默认开启，可由 popup 关闭。发音频时存到 currentTtsWord，
    // 供气泡事件委托兜底（按钮被 innerHTML 重建时 data-word 仍可读）。
    state.currentTtsWord = displayWord || "";
    const tts = (state.showTts && displayWord)
      ? '<span class="ht-tts" data-ht-owner="1" data-word="' + escapeHtml(displayWord) +
        '" role="button" tabindex="0" title="点击朗读">' + TTS_ICON_SVG + "</span>"
      : "";

    const head = '<span class="ht-word">' + escapeHtml(displayWord) + "</span>";
    const phon = (state.showPhonetic && res.phonetic)
      ? '<span class="ht-phonetic">' + escapeHtml(res.phonetic) + "</span>"
      : "";
    html += '<div class="ht-head">' + head + phon + tts + "</div>";

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
      // 区分精选词库 / ECDICT 扩展词库 / 连字符合成词 / 词组，便于判断释义质量来源
      badge = res.tier === "extra" ? "本地词库 · 扩展"
            : res.tier === "compound" ? "本地词库 · 组合"
            : res.tier === "phrase" ? "本地词库 · 词组"
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
    state.currentTtsWord = "";   // 出错时不提供发音
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
  /**
   * @param {string} rawWord 悬停位置所在的那个单词
   * @param {string[]} [rawPhrases] 以该单词为中心扩展出的词组候选（由短到长）
   */
  async function translateWord(rawWord, rawPhrases) {
    const seq = ++state.reqSeq;
    // 缓存键与 attemptTranslate 的去重键保持一致（单词 + 最长候选）。
    // 同一单词在不同上下文里可能命中不同词组，加上上下文才能正确区分。
    const phrases = rawPhrases || [];
    const key = rawWord.toLowerCase() + "\u0000" +
      (phrases.length ? phrases[phrases.length - 1] : "");

    // 命中缓存
    const cached = cacheGet(key);
    if (cached) {
      renderResult(cached);
      showBubble();
      return;
    }

    // 1) 离线词库（后台集中持有）。
    //    官方精选词条命中率约 93%，所以"先加载态、后结果"不会闪 ——
    //    正常情况下后台 1–3 ms 就返回，加载态根本来不及出现。
    //    命中顺序由后台决定：单词优先（更快），未命中再按候选由短到长试词组。
    const local = await requestLocal(rawWord, phrases);
    if (seq !== state.reqSeq) return; // 已被更晚的请求取代（鼠标已移到别的词）

    if (local) {
      cacheSet(key, local);
      renderResult(local);
      showBubble();
      return;
    }

    // 2) 在线兜底
    //    注意：在线通道传「单词」而非词组——单词形态更稳定，
    //    且国内网络下词组的失败率并未更低。
    if (!state.onlineFallback) {
      renderResult({
        word: rawWord, display: rawWord, groups: [],
        plain: "本地词库未收录（在线兜底已关闭）", source: "local"
      });
      showBubble();
      return;
    }

    requestOnline(rawWord, seq, false, key);
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
   *
   * @param {string} cacheKey 内容侧缓存键（单词 + 最长词组候选的复合键），
   *   必须与 translateWord 读缓存用的键完全一致——在线结果曾误用纯单词键
   *   写入，导致同一 Map 读写两套键、在线缓存永不命中。
   */
  function requestOnline(rawWord, seq, isRetry, cacheKey) {
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
              requestOnline(rawWord, seq, true, cacheKey);
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
          // 写入键与 translateWord 的读取键保持同一个复合键，
          // 否则第二次悬停读不到、在线缓存形同虚设。
          cacheSet(cacheKey, res);
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
    // 拖动悬浮球期间不取词（指针快速甩动时可能短暂脱离小球，这里兜底）
    if (state.ballDragging) return;
    // 气泡可见时实时跟随
    if (state.bubble && state.bubble.classList.contains("ht-show")) {
      positionBubble(state.bubble);
    }

    if (!state.enabled || state.frameHidden || state.siteDisabled) return;
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
    // 去重键必须是「悬停的那个词」，不能用词组候选做键。
    // 反例：悬停 "insofar as" 的 insofar 与 as，两者的候选列表末位是同一个
    // 最长串，用候选做键会把第二个词误判为"已在显示"而直接跳过。
    // 单词本身唯一标识了鼠标位置，且同词重复悬停本就该复用气泡。
    const w = hit.word.toLowerCase();
    // 词组结果与单词结果可能不同：同一个词在不同上下文里属于不同词组，
    // 所以把「最长候选」也并进键里，换上下文时能正确重查。
    const phrases = hit.phrases || [];
    const ck = w + "\u0000" + (phrases.length ? phrases[phrases.length - 1] : "");
    if (ck === state.currentWord &&
        state.bubble && state.bubble.classList.contains("ht-show")) {
      return; // 同一位置且气泡已在显示，不重复查询
    }
    state.currentWord = ck;
    // translateWord 是 async：这里 deliberately 不 await，
    // 它内部用 reqSeq 自行丢弃过期响应，不会阻塞后续鼠标事件。
    translateWord(hit.word, phrases).catch(() => {});
  }

  function onMouseOutWindow(e) {
    // relatedTarget 为 null 表示鼠标离开了整个页面窗口
    if (!e.relatedTarget) scheduleHide(120);
  }

  function onScroll() { hideBubble(); }
  function onKeyDown(e) {
    if (e.key === "Escape") hideBubble();
  }

  // ---------- 划词 / 双击查询（v1.5.0） ----------
  //
  // 设计：仅监听 mouseup（不论单击/双击/拖选，松开鼠标时 selection 已确定）。
  //   - 拖选多个词：mouseup 时 sel.toString() 是整段，走 HT_TRANSLATE
  //   - 双击单词：浏览器选中单词，mouseup 时 sel.toString() 是该词，走 HT_LOOKUP
  //   - 普通单击：sel.isCollapsed 为真，跳过
  // 不绑 dblclick：dblclick 在 mouseup 之后才触发，会重复查询；用 mouseup 单一信号即可。
  // 不绑 selectionchange：该事件在拖动中频繁触发，必须配合 mouseup 才有意义，徒增噪音。
  //
  // 与悬停的差异：
  //   - 划词查询不受 siteDisabled 限制（用户主动选词，即使站点停用悬停也应能查）
  //   - 气泡位置锚定到选区下方，不跟随鼠标
  //   - 选中文本若包含非英文字母（中文/数字主导），跳过——避免选中文段落就触发
  function onMouseUp(e) {
    if (!state.enabled || !state.enableSelection || state.frameHidden) return;
    // 鼠标抬起位置在自己气泡/悬浮球上 → 跳过（否则点气泡内文字会触发查询）
    const t = e.target;
    if (t && t.closest && t.closest("[data-ht-owner]")) return;
    // 延迟 50ms：给浏览器完成选区更新（mouseup 时 selection 可能尚未刷新）
    setTimeout(querySelection, 50);
  }

  /**
   * 取当前选区文本，去标点 → 决定走单词查词库还是整句走在线。
   * 单词（1 段）：复用 translateWord 流程，命中本地词库或在线兜底
   * 多词（≥2 段）：直接走 HT_TRANSLATE（单词组合不是固定词组，词库不会收录）
   */
  function querySelection() {
    const sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const raw = String(sel.toString() || "").trim();
    if (!raw) return;

    // 去掉前后标点（保留中间的标点以判断句子边界）
    const cleaned = raw
      .replace(/^[\s.,;:!?'""''(){}\[\]<>-]+|[\s.,;:!?'""''(){}\[\]<>-]+$/g, "")
      .trim();
    if (!cleaned) return;
    // 必须以英文字母开头（避免选中整段中文也触发）
    if (!/^[A-Za-z]/.test(cleaned)) return;
    if (cleaned.length > 200) return;  // 过长不查询

    // 去重：刚刚查过的不再查（双击后 mouseup 触发的二次 selection 同文）
    const ck = cleaned.toLowerCase();
    if (ck === state.lastSelectionKey) return;
    state.lastSelectionKey = ck;

    // 选区位置：气泡底部对齐到选区下方
    let rect = null;
    try {
      const range = sel.getRangeAt(0);
      rect = range.getBoundingClientRect();
    } catch (_) {}
    if (!rect || rect.width === 0 || rect.height === 0) return;

    state.mouseX = rect.left + rect.width / 2;
    state.mouseY = rect.bottom + 4;

    // 单词 vs 多词
    const segs = cleaned.split(/\s+/).filter(s => /[A-Za-z]/.test(s));
    if (segs.length === 0) return;

    // 更新当前展示键，避免同一选区被悬停逻辑误判为"已展示"而跳过
    const phrases = [];
    state.currentWord = ck + "\u0000";

    if (segs.length === 1) {
      // 单词：走完整的 translateWord 流程（含本地查词 + 在线兜底 + 缓存）
      translateWord(segs[0], phrases).catch(() => {});
    } else {
      // 多词：直接发 HT_TRANSLATE（词库不收录任意组合）
      if (!state.onlineFallback) {
        renderResult({
          word: cleaned, display: cleaned, groups: [],
          plain: "划词翻译需开启在线兜底", source: "local"
        });
        showBubble();
        return;
      }
      // 不命中缓存时先显示加载态，再请求在线
      const key = ck + "\u0000";
      const cached = cacheGet(key);
      if (cached) { renderResult(cached); showBubble(); return; }
      renderLoading(cleaned, "查询中…");
      showBubble();
      requestOnline(cleaned, ++state.reqSeq, false, key);
    }
  }

  // ---------- 悬浮球 ----------
  // 位置持久化：键存 chrome.storage.local —— 悬浮球坐标属于「本机 UI 布局」，
  // 不占 sync 配额，也不去碰 popup 里那 8 个 sync 开关键。
  // 初始无记录时沿用 CSS 里的右下角默认位置；用户拖动过一次后，记住坐标，
  // 之后每次打开页面（含新建标签页）都还原到用户放的地方。
  const BALL_POS_KEY = "ht_ball_pos";
  const BALL_EDGE_MARGIN = 4;   // 距视口边缘最小留白（px），防止贴边或跑出屏幕

  /** 把坐标夹在视口内：窗口变小后悬浮球不会被挤出可见区域。 */
  function clampBallPos(left, top, size) {
    const w = window.innerWidth || 0;
    const h = window.innerHeight || 0;
    const maxLeft = Math.max(BALL_EDGE_MARGIN, w - size - BALL_EDGE_MARGIN);
    const maxTop = Math.max(BALL_EDGE_MARGIN, h - size - BALL_EDGE_MARGIN);
    return {
      left: Math.min(Math.max(BALL_EDGE_MARGIN, left), maxLeft),
      top: Math.min(Math.max(BALL_EDGE_MARGIN, top), maxTop)
    };
  }

  /**
   * 应用悬浮球位置。改用 left/top 定位，并用 !important 覆盖 CSS 里的
   * right/bottom —— 那两个属性在 content.css 中带 !important，普通赋值盖不掉。
   */
  function applyBallPos(pos) {
    if (!state.ball || !pos) return;
    const size = state.ball.offsetWidth || 38;
    const c = clampBallPos(pos.left, pos.top, size);
    state.ball.style.setProperty("left", c.left + "px", "important");
    state.ball.style.setProperty("top", c.top + "px", "important");
    state.ball.style.setProperty("right", "auto", "important");
    state.ball.style.setProperty("bottom", "auto", "important");
    state.ballPos = c;
  }

  /** 读取上次保存的位置；无记录则保持默认（右下角），不做任何改动。 */
  function loadBallPos() {
    try {
      chrome.storage.local.get(BALL_POS_KEY, d => {
        if (chrome.runtime.lastError) return;
        const p = d && d[BALL_POS_KEY];
        if (p && typeof p.left === "number" && typeof p.top === "number") applyBallPos(p);
      });
    } catch (_) {}
  }

  /** 落盘位置；任何异常都不打断主流程。 */
  function saveBallPos(pos) {
    try {
      const patch = {};
      patch[BALL_POS_KEY] = pos;
      chrome.storage.local.set(patch, () => { void chrome.runtime.lastError; });
    } catch (_) {}
  }

  /**
   * 给悬浮球绑定拖拽。
   *
   * 用 pointer 事件统一鼠标 / 触摸 / 笔。位移超过 4px 才算拖动，否则仍按点击
   * 处理 —— 点按开关与拖动位置因此可以共存。
   * setPointerCapture 让指针移出小球后仍持续收到事件；try/catch 兼容不支持该
   * API 的环境（例如 jsdom 测试）。
   */
  function bindBallDrag(el) {
    let dragging = false, moved = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    el.addEventListener("pointerdown", ev => {
      if (ev.button !== 0) return;          // 只响应左键 / 触摸 / 笔
      const rect = el.getBoundingClientRect();
      dragging = true;
      moved = false;
      state.ballDragging = true;
      state.ballSuppressClick = false;      // 新一次交互，清掉上一轮的抑制标记
      startX = ev.clientX;
      startY = ev.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      try { el.setPointerCapture(ev.pointerId); } catch (_) {}
    });

    el.addEventListener("pointermove", ev => {
      if (!dragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved) {
        if (Math.abs(dx) + Math.abs(dy) <= 4) return;  // 手抖，仍算点击
        moved = true;
        el.classList.add("ht-ball-dragging");
        hideBubble();                       // 拖动时不保留旧气泡
      }
      applyBallPos({ left: startLeft + dx, top: startTop + dy });
      ev.preventDefault();                  // 拖动中不选中页面文本
    });

    function endDrag(ev) {
      if (!dragging) return;
      dragging = false;
      state.ballDragging = false;
      el.classList.remove("ht-ball-dragging");
      try { el.releasePointerCapture(ev.pointerId); } catch (_) {}
      if (moved) {
        state.ballSuppressClick = true;     // 这次是拖动，紧随的 click 不算开关
        if (state.ballPos) saveBallPos(state.ballPos);
      }
    }
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
  }

  function ensureBall() {
    if (state.ball && document.body.contains(state.ball)) return state.ball;
    const el = document.createElement("div");
    el.className = "ht-ball";
    el.setAttribute("data-ht-owner", "1");
    el.title = "悬停取词翻译：点击开启/关闭，可拖动调整位置（Alt+Shift+T）";
    el.addEventListener("click", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      // 刚刚拖动过：这次点击只是拖拽的尾巴，不切换开关
      if (state.ballSuppressClick) { state.ballSuppressClick = false; return; }
      setEnabled(!state.enabled, true);
    });
    // 悬浮球自身不触发取词
    el.addEventListener("mouseover", ev => ev.stopPropagation());
    bindBallDrag(el);
    document.body.appendChild(el);
    state.ball = el;
    updateBall();
    // 已有保存位置就还原；没有则读取一次（首次注入时），读不到就保持 CSS 默认
    if (state.ballPos) applyBallPos(state.ballPos);
    else loadBallPos();
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

  /**
   * 判断当前站点是否在黑名单中。
   * 匹配规则：精确匹配 或 后缀匹配（example.com 匹配 www.example.com）。
   * 不匹配 notexample.com（必须是完整域名段，点号分隔）。
   */
  function isSiteDisabled() {
    var host;
    try { host = location.hostname; } catch (_) { return false; }
    if (!host || !state.disabledSites || !state.disabledSites.length) return false;
    return state.disabledSites.some(function (site) {
      if (!site || typeof site !== "string") return false;
      if (host === site) return true;
      // 后缀匹配：example.com 匹配 www.example.com，但不匹配 notexample.com
      return host.length > site.length + 1 &&
             host.charAt(host.length - site.length - 1) === "." &&
             host.endsWith(site);
    });
  }

  function loadSettings() {
    chrome.storage.sync.get(
      { enabled: true, onlineFallback: true, showPhonetic: true, showTts: true, enableSelection: true, hoverDelay: 320, showBall: true, disabledSites: [] },
      cfg => {
        if (chrome.runtime.lastError) return;
        state.enabled = cfg.enabled !== false;
        state.onlineFallback = cfg.onlineFallback !== false;
        state.showPhonetic = cfg.showPhonetic !== false;
        state.showTts = cfg.showTts !== false;
        state.enableSelection = cfg.enableSelection !== false;
        state.hoverDelay = Math.min(900, Math.max(80, Number(cfg.hoverDelay) || 320));
        state.showBall = cfg.showBall !== false;
        state.disabledSites = Array.isArray(cfg.disabledSites) ? cfg.disabledSites : [];
        state.siteDisabled = isSiteDisabled();
        updateBall();
        if (cfg.showBall && !state.siteDisabled) ensureBall();
      }
    );
  }

  function listenStorage() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if (changes.enabled) setEnabled(changes.enabled.newValue !== false, false);
      if (changes.onlineFallback) state.onlineFallback = changes.onlineFallback.newValue !== false;
      if (changes.showPhonetic) state.showPhonetic = changes.showPhonetic.newValue !== false;
      if (changes.showTts) state.showTts = changes.showTts.newValue !== false;
      if (changes.enableSelection) state.enableSelection = changes.enableSelection.newValue !== false;
      if (changes.hoverDelay) state.hoverDelay = Math.min(900, Math.max(80, Number(changes.hoverDelay.newValue) || 320));
      if (changes.showBall) {
        state.showBall = changes.showBall.newValue !== false;
        if (changes.showBall.newValue) ensureBall();
        else if (state.ball) { state.ball.remove(); state.ball = null; }
      }
      if (changes.disabledSites) {
        state.disabledSites = Array.isArray(changes.disabledSites.newValue) ? changes.disabledSites.newValue : [];
        const wasDisabled = state.siteDisabled;
        state.siteDisabled = isSiteDisabled();
        if (state.siteDisabled !== wasDisabled) {
          if (state.siteDisabled) {
            hideBubble();
            if (state.ball) { state.ball.remove(); state.ball = null; }
          } else {
            if (state.showBall) ensureBall();
          }
        }
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

    // 悬浮球注入由 loadSettings 回调统一决定（根据 showBall + siteDisabled），
    // 避免「先注入再移除」的闪烁。
    listenStorage();
    listenMessages();
    probeDictInfo();

    document.addEventListener("mousemove", onMouseMove, { passive: true, capture: true });
    document.addEventListener("mouseup", onMouseUp, true);
    document.addEventListener("mouseout", onMouseOutWindow, true);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", hideBubble);
    // 窗口尺寸变化后重新夹紧悬浮球位置，避免缩窗后小球被挤出可见区域
    window.addEventListener("resize", () => {
      if (state.ballPos) applyBallPos(state.ballPos);
    }, { passive: true });

    // 加载成功标记：用户可在控制台（F12）确认脚本已注入
    try {
      console.info("%c[悬停取词翻译] v" + HT_VERSION + " 已加载，悬停英文单词或词组即可翻译",
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
            " 条 + 扩展 " + resp.extra + " 条 + 词组 " + (resp.phrase || 0) +
            " 条 = " + resp.total + " 条（由后台统一持有）");
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
