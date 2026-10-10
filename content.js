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
 *  独立 JS 环境」，于是每个标签页、每个 iframe 都要各自解析并持有一份 3 万词词库
 *  （堆约 8.7 MB），20 个标签页 × 5 个 iframe 就是约 870 MB。
 *  现在词库由 service worker 全局持有一份，本文件只负责取词、请求、渲染。
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

  const HT_VERSION = "1.3.0";

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
   * @param {string} word   原始单词（大小写不限）
   * @param {string[]} [phrases] 词组候选（由短到长）。仅当单词未命中时才尝试。
   * @returns {Promise<object|null>} 命中返回渲染就绪的结果对象，未命中/失败返回 null
   */
  function requestLocal(word, phrases) {
    return new Promise(resolve => {
      let settled = false;
      const done = v => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };

      // 超时兜底：后台忙/正在重建时不阻塞，直接交给在线通道
      const timer = setTimeout(() => done(null), LOCAL_LOOKUP_TIMEOUT);

      let sent = false;
      try {
        const ret = chrome.runtime.sendMessage(
          { type: "HT_LOOKUP", word: word, phrases: phrases || [] },
          resp => {
            if (chrome.runtime.lastError) { done(null); return; }
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
    const cached = state.cache.get(key);
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
      state.cache.set(key, local);
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
