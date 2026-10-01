/**
 * 悬停取词翻译 —— 后台 Service Worker
 *
 * 职责：
 *  1. 代理在线翻译请求（内容脚本受页面 CSP 限制，跨域请求统一走后台）
 *  2. 维护右键菜单与快捷键，向当前标签页派发开关指令
 *
 * 性能设计（目标：本地未收录时 1 秒内出结果）：
 *  - 多通道并行竞速，首个成功结果立即返回，失败者被 abort，不再串行等待
 *  - 单通道超时 900ms，总超时 1100ms，超时后立即降级返回
 *  - 后台内存缓存（LRU，上限 800 条），跨标签页/iframe 复用，命中即 0 延迟
 *  - 内容脚本侧还有一层缓存，同一单词重复悬停不再发请求
 */

// ---------- 超时与缓存配置 ----------
const CHANNEL_TIMEOUT = 700;    // 单通道超时（毫秒）
const TOTAL_TIMEOUT = 1000;     // 整体超时（毫秒），到点即返回，不阻塞用户
const CACHE_MAX = 800;          // 后台缓存上限（条）

const cache = new Map();        // word -> { ok, display, phonetic, plain, groups }

function cacheGet(word) {
  const k = word.toLowerCase();
  if (!cache.has(k)) return null;
  const v = cache.get(k);
  // LRU：命中后移到末尾
  cache.delete(k);
  cache.set(k, v);
  return v;
}

function cacheSet(word, result) {
  const k = word.toLowerCase();
  if (cache.has(k)) cache.delete(k);
  cache.set(k, result);
  if (cache.size > CACHE_MAX) {
    // 淘汰最旧的一条
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/**
 * 给 promise 套一层超时：超时后 abort 并把该通道标记为失败。
 */
function withTimeout(run, ms, label) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      try { ctrl.abort(); } catch (_) {}
      reject(new Error(label + " 超时(" + ms + "ms)"));
    }, ms);
    run(ctrl.signal).then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); }
    );
  });
}

// ---------- 在线翻译 ----------
// 主通道：Google 翻译免费端点（无需 Key），词典释义最全
// 备用通道：MyMemory（免费额度，无需 Key）
async function fetchGoogle(word, signal) {
  // 精简参数：dt=t 整句译文、dt=bd 词典释义；去掉 dt=rm 可减小响应体、加快解析
  const url =
    "https://translate.googleapis.com/translate_a/single" +
    "?client=gtx&sl=en&tl=zh-CN&dt=t&dt=bd&q=" +
    encodeURIComponent(word);

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();

  // 结构: [ [ [译文, 原文, ...], ... ], null, "en", ..., [ [词性, [释义...], ...], ... ] ]
  const translates = Array.isArray(data[0]) ? data[0] : [];
  const plain = translates.map(t => (t && t[0]) || "").join("").trim();

  // 词典释义（按词性分组）
  const groups = [];
  const dict = data[1];
  if (Array.isArray(dict)) {
    for (const d of dict) {
      if (!Array.isArray(d)) continue;
      const pos = normalizePos(d[0]);
      const defs = Array.isArray(d[1]) ? d[1].slice(0, 5).join("；") : "";
      if (defs) groups.push({ pos: pos, text: defs });
    }
  }

  if (!plain && !groups.length) throw new Error("空结果");
  return {
    ok: true,
    display: word,
    phonetic: "",
    plain: plain,
    groups: groups,
    source: "google"
  };
}

async function fetchMyMemory(word, signal) {
  const url =
    "https://api.mymemory.translated.net/get?langpair=en|zh-CN&q=" +
    encodeURIComponent(word);

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  const text = data && data.responseData && data.responseData.translatedText;
  if (!text) throw new Error("空结果");
  // MyMemory 有时返回提示语，过滤掉
  if (/MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(text)) throw new Error("配额受限");
  return {
    ok: true,
    display: word,
    phonetic: "",
    plain: text,
    groups: [{ pos: "", text: text }],
    source: "mymemory"
  };
}

function normalizePos(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  const map = {
    noun: "n.", verb: "v.", adjective: "adj.", adverb: "adv.",
    pronoun: "pron.", preposition: "prep.", conjunction: "conj.",
    interjection: "int.", determiner: "det.", numeral: "num.",
    article: "art.", abbreviation: "abbr.", phrase: "phr."
  };
  const lower = s.toLowerCase();
  if (map[lower]) return map[lower];
  if (s.length <= 6) return s;
  return s.slice(0, 6);
}

/**
 * 并行竞速：所有通道同时发起，首个成功的结果立即返回。
 * 相比原来的「主通道失败再试备用」串行策略，最坏耗时从 8s+8s 降到 1.1s。
 */
function raceChannels(word) {
  const channels = [
    { name: "Google", run: sig => fetchGoogle(word, sig) },
    { name: "MyMemory", run: sig => fetchMyMemory(word, sig) }
  ];

  return new Promise(resolve => {
    let settled = false;
    let failed = 0;
    const errors = [];

    const finish = res => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      resolve(res);
    };

    // 整体兜底：无论通道状态如何，到点就返回，绝不拖住用户
    const hardTimer = setTimeout(() => {
      const detail = errors.length ? "（" + errors.join(" / ") + "）" : "";
      finish({
        ok: false,
        error: "翻译服务响应超时，已超过 " + TOTAL_TIMEOUT + "ms" + detail
      });
    }, TOTAL_TIMEOUT);

    channels.forEach(ch => {
      withTimeout(ch.run, CHANNEL_TIMEOUT, ch.name)
        .then(res => {
          if (res && res.ok) finish(res);
        })
        .catch(e => {
          // 错误信息带通道名前缀，便于排查是哪条通道失败
          errors.push(ch.name + ": " + (e && e.message ? e.message : String(e)));
          failed++;
          // 全部通道都失败：立即返回错误，不必等总超时
          if (failed === channels.length) {
            finish({ ok: false, error: "翻译服务暂时不可用（" + errors.join(" / ") + "）" });
          }
        });
    });
  });
}

async function translate(word) {
  const hit = cacheGet(word);
  if (hit) return hit;

  const res = await raceChannels(word);
  // 仅缓存成功结果，避免把临时失败固化
  if (res && res.ok) cacheSet(word, res);
  return res;
}

// ---------- 消息路由 ----------
// 说明：取词开关（enabled / onlineFallback / showPhonetic / showBall）一律由
// 各上下文直接读写 chrome.storage.sync，不经后台中转 —— 这样 service worker
// 休眠时开关依然可靠，也不会出现多上下文写入竞态。后台只负责在线翻译代理。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "HT_TRANSLATE") {
    translate(String(msg.word || "").trim())
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true; // 异步响应
  }
});

// ---------- 右键菜单 ----------
const MENU_ID = "ht-toggle-menu";

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "开启/关闭悬停取词翻译",
      contexts: ["page", "selection", "link"]
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  createMenus();
  chrome.storage.sync.get(
    { enabled: true, onlineFallback: true, showPhonetic: true, hoverDelay: 320, showBall: true },
    cfg => {
      // 仅在首次安装（无既有值）时写入默认值
      chrome.storage.sync.set(cfg);
    }
  );
});

chrome.runtime.onStartup.addListener(createMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id == null) return;
  toggleForTab(tab.id);
});

// ---------- 快捷键 ----------
chrome.commands.onCommand.addListener(command => {
  if (command !== "toggle-hover-translate") return;
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null) return;
    toggleForTab(tab.id);
  });
});

/**
 * 切换指定标签页的取词开关。
 *
 * 以 storage 中的 enabled 值为唯一事实来源：先翻转 storage，再由内容脚本的
 * storage.onChanged 回调同步 UI，避免「内容脚本回应 -> 后台写 storage」的竞态。
 * 同时仍向内容脚本发一条 HT_TOGGLE，让不支持 storage 同步的极端场景（如
 * 权限受限的框架）也能立即响应。
 */
function toggleForTab(tabId) {
  chrome.storage.sync.get({ enabled: true }, cfg => {
    void chrome.runtime.lastError;
    const next = !(cfg.enabled !== false);
    chrome.storage.sync.set({ enabled: next }, () => {
      void chrome.runtime.lastError;
    });
    // 通知内容脚本立即切换（若页面尚未注入脚本则会报错，静默忽略）
    chrome.tabs.sendMessage(tabId, { type: "HT_SET", enabled: next }, () => {
      void chrome.runtime.lastError;
    });
  });
}
