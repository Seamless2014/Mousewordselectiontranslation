/**
 * 设置面板逻辑。
 * 所有配置写入 chrome.storage.sync，内容脚本通过 storage.onChanged 实时生效。
 */
(function () {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    onlineFallback: true,
    showPhonetic: true,
    showTts: true,
    enableSelection: true,
    showBall: true,
    hoverDelay: 320,
    disabledSites: []
  };

  const els = {
    master: document.getElementById("master"),
    online: document.getElementById("online"),
    phonetic: document.getElementById("phonetic"),
    tts: document.getElementById("tts"),
    selection: document.getElementById("selection"),
    ball: document.getElementById("ball"),
    delay: document.getElementById("delay"),
    delayVal: document.getElementById("delayVal"),
    dictCount: document.getElementById("dictCount"),
    status: document.getElementById("status"),
    disableSiteBtn: document.getElementById("disableSiteBtn"),
    disableSiteHint: document.getElementById("disableSiteHint"),
    siteList: document.getElementById("siteList"),
    // 生词本（v1.5.0）
    wordsCount: document.getElementById("wordsCount"),
    refreshWordsBtn: document.getElementById("refreshWordsBtn"),
    exportWordsBtn: document.getElementById("exportWordsBtn"),
    clearWordsBtn: document.getElementById("clearWordsBtn"),
    wordsHint: document.getElementById("wordsHint"),
    wordList: document.getElementById("wordList")
  };

  // 当前标签页域名（异步获取，获取后触发 render）
  let currentHost = "";

  let cfg = Object.assign({}, DEFAULTS);

  // 生词本当前列表缓存（供 exportCsv 使用，renderWords 时刷新）
  let wordsCache = [];

  /**
   * 判断 host 是否被黑名单中的某条规则命中。
   * 与 content.js isSiteDisabled 保持一致的匹配语义：
   *   精确匹配 或 后缀匹配（example.com 匹配 www.example.com）。
   */
  function isSiteInList(host, list) {
    if (!host || !list || !list.length) return false;
    return list.some(function (site) {
      if (!site || typeof site !== "string") return false;
      if (host === site) return true;
      return host.length > site.length + 1 &&
             host.charAt(host.length - site.length - 1) === "." &&
             host.endsWith(site);
    });
  }

  function render() {
    els.master.classList.toggle("on", cfg.enabled);
    els.online.classList.toggle("on", cfg.onlineFallback);
    els.phonetic.classList.toggle("on", cfg.showPhonetic);
    els.tts.classList.toggle("on", cfg.showTts);
    els.selection.classList.toggle("on", cfg.enableSelection);
    els.ball.classList.toggle("on", cfg.showBall);
    els.delay.value = cfg.hoverDelay;
    els.delayVal.textContent = cfg.hoverDelay + "ms";
    // 总开关关闭时，弱化次级选项
    els.online.style.opacity = cfg.enabled ? "1" : ".45";
    els.phonetic.style.opacity = cfg.enabled ? "1" : ".45";
    els.tts.style.opacity = cfg.enabled ? "1" : ".45";
    els.selection.style.opacity = cfg.enabled ? "1" : ".45";
    els.ball.style.opacity = cfg.enabled ? "1" : ".45";
    els.delay.disabled = !cfg.enabled;
    els.delay.style.opacity = cfg.enabled ? "1" : ".45";

    // 黑名单按钮状态
    const inList = isSiteInList(currentHost, cfg.disabledSites);
    if (currentHost && inList) {
      els.disableSiteBtn.textContent = "已停用";
      els.disableSiteBtn.classList.add("disabled");
      els.disableSiteHint.textContent = "当前站点已停用（" + currentHost + "）";
    } else if (currentHost) {
      els.disableSiteBtn.textContent = "停用";
      els.disableSiteBtn.classList.remove("disabled");
      els.disableSiteHint.textContent = "当前站点不再自动弹释义。";
    } else {
      els.disableSiteBtn.textContent = "停用";
      els.disableSiteBtn.classList.add("disabled");
      els.disableSiteHint.textContent = "无法读取当前标签页域名。";
    }
    renderSites();
  }

  /** 渲染黑名单列表（排除空字符串、去重） */
  function renderSites() {
    const list = (cfg.disabledSites || []).filter(s => s && typeof s === "string");
    if (!list.length) {
      els.siteList.innerHTML = "";
      els.siteList.style.display = "none";
      return;
    }
    els.siteList.style.display = "block";
    let html = '<div class="sites-hd">已停用站点（' + list.length + '）</div>';
    list.forEach(site => {
      html += '<div class="site-item"><span class="name" title="' +
              site + '">' + site + '</span>' +
              '<span class="del" data-site="' + site + '">移除</span></div>';
    });
    els.siteList.innerHTML = html;
  }

  /** 把当前站点加入或移出黑名单 */
  function toggleCurrentSite() {
    if (!currentHost) return;
    const list = (cfg.disabledSites || []).filter(s => s && typeof s === "string");
    if (isSiteInList(currentHost, list)) {
      // 已在黑名单 → 移除（精确匹配 + 后缀匹配的条目都清掉）
      const next = list.filter(s => currentHost !== s && !currentHost.endsWith("." + s));
      save({ disabledSites: next });
    } else {
      // 不在黑名单 → 加入
      save({ disabledSites: list.concat(currentHost) });
    }
  }

  /** 从黑名单移除指定域名 */
  function removeSite(site) {
    const list = (cfg.disabledSites || []).filter(s => s !== site);
    save({ disabledSites: list });
  }

  function save(patch) {
    Object.assign(cfg, patch);
    chrome.storage.sync.set(patch, () => {
      if (chrome.runtime.lastError) {
        showStatus("保存失败：" + chrome.runtime.lastError.message, "warn");
      }
    });
    render();
  }

  function showStatus(msg, kind) {
    els.status.textContent = msg;
    els.status.className = "status show " + (kind || "info");
    setTimeout(() => { els.status.className = "status " + (kind || "info"); }, 2600);
  }

  // ---- 事件 ----
  els.master.addEventListener("click", () => save({ enabled: !cfg.enabled }));
  els.online.addEventListener("click", () => save({ onlineFallback: !cfg.onlineFallback }));
  els.phonetic.addEventListener("click", () => save({ showPhonetic: !cfg.showPhonetic }));
  els.tts.addEventListener("click", () => save({ showTts: !cfg.showTts }));
  els.selection.addEventListener("click", () => save({ enableSelection: !cfg.enableSelection }));
  els.ball.addEventListener("click", () => save({ showBall: !cfg.showBall }));

  els.delay.addEventListener("input", () => {
    els.delayVal.textContent = els.delay.value + "ms";
  });
  els.delay.addEventListener("change", () => {
    save({ hoverDelay: Number(els.delay.value) });
  });

  // 站点黑名单
  els.disableSiteBtn.addEventListener("click", toggleCurrentSite);
  // 事件委托：处理黑名单列表中的"移除"点击
  els.siteList.addEventListener("click", e => {
    const del = e.target.closest && e.target.closest(".del");
    if (del) removeSite(del.getAttribute("data-site"));
  });

  // ---- 初始化 ----
  chrome.storage.sync.get(DEFAULTS, stored => {
    if (chrome.runtime.lastError) {
      showStatus("读取配置失败：" + chrome.runtime.lastError.message, "warn");
      render();
    } else {
      cfg = Object.assign({}, DEFAULTS, stored);
      render();
    }
    // 获取当前标签页域名（异步，完成后重新渲染按钮状态）
    queryCurrentHost();
  });

  /** 读取当前标签页域名，存入 currentHost 后触发 render */
  function queryCurrentHost() {
    if (!chrome.tabs || !chrome.tabs.query) {
      render();
      return;
    }
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        const t = tabs && tabs[0];
        if (t && t.url) {
          try { currentHost = new URL(t.url).hostname; }
          catch (_) { currentHost = ""; }
        }
        render();
      });
    } catch (_) {
      render();
    }
  }

  // 显示本地词库条目数（精选单词 + ECDICT 扩展单词 + 词组词库合计）。
  //
  // v1.2.0 起 popup 不再自己加载 2.1 MB 词库（那样开一次 popup 就多一份堆占用），
  // 改为向 service worker 查询。后台未就绪时降级显示"—"，不影响其他设置项。
  function renderDictCount() {
    try {
      chrome.runtime.sendMessage({ type: "HT_DICT_INFO" }, resp => {
        if (chrome.runtime.lastError || !resp || !resp.ok || !resp.total) {
          els.dictCount.textContent = "未加载";
          els.dictCount.title = "后台词库尚未就绪，扩展重载后重试";
          return;
        }
        els.dictCount.textContent = resp.total.toLocaleString() + " 条";
        var parts = ["精选单词 " + resp.core + " 条", "扩展单词 " + resp.extra + " 条"];
        if (resp.phrase) parts.push("词组 " + resp.phrase + " 条");
        els.dictCount.title =
          parts.join(" + ") + "（由后台统一持有，内存不随标签页增长）";
      });
    } catch (_) {
      els.dictCount.textContent = "未加载";
    }
  }
  // ---------- 生词本（v1.5.0）----------
  //
  // 查词命中后由后台落到 storage.local.ht_history，popup 通过 HT_GET_WORDS 拉取。
  // 三个动作：刷新（HT_GET_WORDS）、删除单条（HT_DEL_WORD）、清空（HT_CLEAR_WORDS）。
  // 导出 CSV 直接从 wordsCache 生成，不再发额外消息。

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  /** 拉取生词本并渲染列表 */
  function renderWords() {
    try {
      chrome.runtime.sendMessage({ type: "HT_GET_WORDS" }, resp => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          els.wordsCount.textContent = "—";
          els.wordList.innerHTML = '<div class="words-empty">读取失败</div>';
          wordsCache = [];
          return;
        }
        const words = Array.isArray(resp.words) ? resp.words : [];
        wordsCache = words;
        els.wordsCount.textContent = String(words.length);
        if (!words.length) {
          els.wordList.innerHTML = '<div class="words-empty">暂无查词记录</div>';
          return;
        }
        let html = "";
        for (const it of words) {
          const w = it && it.word ? it.word : "";
          const phon = it && it.phonetic ? it.phonetic : "";
          const plain = it && it.plain ? it.plain : "";
          html += '<div class="word-item">' +
            '<div class="w-row1">' +
              '<span class="w-word" title="' + escapeAttr(w) + '">' + escapeHtml(w) + '</span>' +
              (phon ? '<span class="w-phon">/' + escapeHtml(phon) + '/</span>' : '') +
              '<span class="w-del" data-word="' + escapeAttr(w) + '">删除</span>' +
            '</div>' +
            (plain ? '<div class="w-plain">' + escapeHtml(plain) + '</div>' : '') +
          '</div>';
        }
        els.wordList.innerHTML = html;
      });
    } catch (e) {
      els.wordsCount.textContent = "—";
      els.wordList.innerHTML = '<div class="words-empty">读取失败</div>';
      wordsCache = [];
    }
  }

  /** CSV 字段转义：含逗号/引号/换行则用双引号包裹，内部双引号双写 */
  function csvField(s) {
    s = String(s == null ? "" : s);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /** 导出当前生词本为 CSV 文件（带 UTF-8 BOM，Excel 可正确识别中文）*/
  function exportCsv() {
    if (!wordsCache.length) {
      showStatus("生词本为空，无内容可导出", "warn");
      return;
    }
    const rows = ["单词,音标,释义,来源,时间"];
    for (const it of wordsCache) {
      const date = it && it.ts ? new Date(it.ts).toLocaleString("zh-CN") : "";
      rows.push([
        csvField(it && it.word),
        csvField(it && it.phonetic),
        csvField(it && it.plain),
        csvField(it && it.source),
        csvField(date)
      ].join(","));
    }
    try {
      const blob = new Blob(["\uFEFF" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "生词本.csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showStatus("已导出 " + wordsCache.length + " 条生词", "info");
    } catch (e) {
      showStatus("导出失败：" + (e && e.message ? e.message : e), "warn");
    }
  }

  /** 清空生词本（二次确认）*/
  function clearWords() {
    if (!wordsCache.length) {
      showStatus("生词本已为空", "info");
      return;
    }
    if (!window.confirm("确定清空全部 " + wordsCache.length + " 条生词？此操作不可撤销。")) return;
    try {
      chrome.runtime.sendMessage({ type: "HT_CLEAR_WORDS" }, resp => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          showStatus("清空失败", "warn");
          return;
        }
        showStatus("已清空生词本", "info");
        renderWords();
      });
    } catch (e) {
      showStatus("清空失败：" + (e && e.message ? e.message : e), "warn");
    }
  }

  /** 删除单条生词 */
  function delWord(word) {
    if (!word) return;
    try {
      chrome.runtime.sendMessage({ type: "HT_DEL_WORD", word: word }, resp => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          showStatus("删除失败", "warn");
          return;
        }
        renderWords();
      });
    } catch (e) {
      showStatus("删除失败：" + (e && e.message ? e.message : e), "warn");
    }
  }

  // 生词本事件绑定
  els.refreshWordsBtn.addEventListener("click", renderWords);
  els.exportWordsBtn.addEventListener("click", exportCsv);
  els.clearWordsBtn.addEventListener("click", clearWords);
  // 事件委托：处理列表中的"删除"点击
  els.wordList.addEventListener("click", e => {
    const del = e.target.closest && e.target.closest(".w-del");
    if (del) delWord(del.getAttribute("data-word"));
  });

  renderWords();
  renderDictCount();
})();
