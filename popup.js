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

  // 显示本地词库条目数（精选词库 + ECDICT 扩展词库合计）
  try {
    const core = typeof LOCAL_DICT === "object" && LOCAL_DICT ? Object.keys(LOCAL_DICT).length : 0;
    const extra = typeof DICT_EXTRA === "object" && DICT_EXTRA ? Object.keys(DICT_EXTRA).length : 0;
    const total = core + extra;
    if (!total) {
      els.dictCount.textContent = "未加载";
    } else {
      els.dictCount.textContent = total.toLocaleString() + " 条";
      els.dictCount.title = "精选词库 " + core + " 条 + 扩展词库 " + extra + " 条";
    }
  } catch (_) {
    els.dictCount.textContent = "未加载";
  }
})();
