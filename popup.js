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
    showBall: true,
    hoverDelay: 320
  };

  const els = {
    master: document.getElementById("master"),
    online: document.getElementById("online"),
    phonetic: document.getElementById("phonetic"),
    ball: document.getElementById("ball"),
    delay: document.getElementById("delay"),
    delayVal: document.getElementById("delayVal"),
    dictCount: document.getElementById("dictCount"),
    status: document.getElementById("status")
  };

  let cfg = Object.assign({}, DEFAULTS);

  function render() {
    els.master.classList.toggle("on", cfg.enabled);
    els.online.classList.toggle("on", cfg.onlineFallback);
    els.phonetic.classList.toggle("on", cfg.showPhonetic);
    els.ball.classList.toggle("on", cfg.showBall);
    els.delay.value = cfg.hoverDelay;
    els.delayVal.textContent = cfg.hoverDelay + "ms";
    // 总开关关闭时，弱化次级选项
    els.online.style.opacity = cfg.enabled ? "1" : ".45";
    els.phonetic.style.opacity = cfg.enabled ? "1" : ".45";
    els.ball.style.opacity = cfg.enabled ? "1" : ".45";
    els.delay.disabled = !cfg.enabled;
    els.delay.style.opacity = cfg.enabled ? "1" : ".45";
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
  els.ball.addEventListener("click", () => save({ showBall: !cfg.showBall }));

  els.delay.addEventListener("input", () => {
    els.delayVal.textContent = els.delay.value + "ms";
  });
  els.delay.addEventListener("change", () => {
    save({ hoverDelay: Number(els.delay.value) });
  });

  // ---- 初始化 ----
  chrome.storage.sync.get(DEFAULTS, stored => {
    if (chrome.runtime.lastError) {
      showStatus("读取配置失败：" + chrome.runtime.lastError.message, "warn");
      render();
      return;
    }
    cfg = Object.assign({}, DEFAULTS, stored);
    render();
  });

  // 显示本地词库条目数（精选词库 + ECDICT 扩展词库合计）。
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
        els.dictCount.title =
          "精选词库 " + resp.core + " 条 + 扩展词库 " + resp.extra + " 条" +
          "（由后台统一持有，内存不随标签页增长）";
      });
    } catch (_) {
      els.dictCount.textContent = "未加载";
    }
  }
  renderDictCount();
})();
