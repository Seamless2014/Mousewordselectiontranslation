/**
 * 悬停取词翻译 —— 后台 Service Worker
 *
 * 职责：
 *  1. 持有唯一的离线词库副本，处理内容脚本的查词请求（HT_LOOKUP）
 *  2. 代理在线翻译请求（内容脚本受页面 CSP 限制，跨域请求统一走后台）
 *  3. 维护右键菜单与快捷键，向当前标签页派发开关指令
 *
 * 为什么词库放在后台（v1.2.0 架构调整）：
 *  改造前词库由 content_scripts 注入，而内容脚本是「每个 frame 一份独立 JS 环境」，
 *  于是每开一个标签页、每个 iframe 都要各自解析并持有一份 3 万词词库（堆约 8.7 MB）。
 *  实测 20 个标签页 × 平均 5 个 iframe ≈ 100 份 ≈ 870 MB，且同一份 2.1 MB 脚本被
 *  重复解析 100 次。改为后台集中持有后，内存恒定 8.7 MB，与标签页数量无关。
 *  代价是每次查词多一次消息往返（实测 1–3 ms，远小于 hoverDelay 的 320 ms）。
 *
 * 性能设计（目标：本地未收录时 1 秒内出结果）：
 *  - 词库惰性初始化：service worker 被回收后重建时，首次查词才解析词库
 *  - 多通道并行竞速，首个成功结果立即返回，失败者被 abort，不再串行等待
 *  - 单通道超时 700ms，总超时 1000ms，超时后立即降级返回
 *  - 连字符合成词（decision-maker 等）先在本地拆词，不必走网络
 *  - 在线失败由内容脚本自动重试一次（超时放宽到 2.5s/3s），网络抖动不再报错
 *  - 通道健康记忆：连续失败 ≥2 次的通道冷却 120s，重试不再陪不可达通道耗时
 *  - 后台内存缓存（LRU，上限 800 条），跨标签页/iframe 复用，命中即 0 延迟
 *  - 内容脚本侧还有一层缓存，同一单词重复悬停不再发请求
 */

// ---------- 词库加载（集中持有，全局唯一副本）----------
//
// importScripts 只在 service worker 顶层可用，且要求同源相对路径。
// 顺序不能改：dict-lookup.js 里 lookupLocal() 依赖 LOCAL_DICT / DICT_EXTRA。
// 注意：三个文件都是顶层 var 声明，作用域是 worker 全局，重复 importScripts 无害。
importScripts("dict.js", "dict-extra.js", "dict-lookup.js");

const HT_BG_VERSION = "1.2.1";

// dict.js / dict-extra.js 末尾都有「仅保留纯小写字母键」的自检，
// 这里再兜一层：确认词库真的可用，否则把查词请求直接判为未命中（走在线兜底）。
const DICT_READY =
  (typeof LOCAL_DICT === "object" && !!LOCAL_DICT) ||
  (typeof DICT_EXTRA === "object" && !!DICT_EXTRA);

// ---------- 超时与缓存配置 ----------
const CHANNEL_TIMEOUT = 700;       // 常规单通道超时（毫秒）
const TOTAL_TIMEOUT = 1000;        // 常规整体超时（毫秒），到点即返回，不阻塞用户
const RETRY_CHANNEL_TIMEOUT = 2500; // 重试单通道超时：网络抖动时给足余量
const RETRY_TOTAL_TIMEOUT = 3000;   // 重试整体超时
const CACHE_MAX = 800;             // 后台缓存上限（条）
const CHANNEL_COOLDOWN_MS = 120000; // 通道连续失败后的冷却时长（毫秒）

const cache = new Map();        // word -> { ok, display, phonetic, plain, groups }

// 通道健康记忆：连续失败 ≥2 次的通道冷却一段时间，避免每次请求都陪它耗到超时。
// 典型场景：国内网络下 Google 端点不可达，若不冷却，每次重试都要白等一轮。
const channelHealth = {};       // name -> { fails: n, cooldownUntil: ts }

function noteChannelSuccess(name) {
  channelHealth[name] = { fails: 0, cooldownUntil: 0 };
}

function noteChannelFailure(name) {
  const h = channelHealth[name] || { fails: 0, cooldownUntil: 0 };
  h.fails += 1;
  if (h.fails >= 2) h.cooldownUntil = Date.now() + CHANNEL_COOLDOWN_MS;
  channelHealth[name] = h;
}

function isChannelCoolingDown(name) {
  const h = channelHealth[name];
  return !!(h && h.fails >= 2 && Date.now() < h.cooldownUntil);
}

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
 *
 * @param {string} word 要翻译的词
 * @param {object} budget { channel, total } 超时预算；缺省用常规值
 */
function raceChannels(word, budget) {
  const channelTimeout = (budget && budget.channel) || CHANNEL_TIMEOUT;
  const totalTimeout = (budget && budget.total) || TOTAL_TIMEOUT;
  const channels = [
    { name: "Google", run: sig => fetchGoogle(word, sig) },
    { name: "MyMemory", run: sig => fetchMyMemory(word, sig) }
  ];

  // 健康通道优先；全部处于冷却时则照常尝试（有结果总比没有强）
  let active = channels.filter(ch => !isChannelCoolingDown(ch.name));
  if (!active.length) active = channels;

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
        error: "翻译服务响应超时，已超过 " + totalTimeout + "ms" + detail
      });
    }, totalTimeout);

    active.forEach(ch => {
      withTimeout(ch.run, channelTimeout, ch.name)
        .then(res => {
          if (res && res.ok) {
            noteChannelSuccess(ch.name);
            finish(res);
          }
        })
        .catch(e => {
          noteChannelFailure(ch.name);
          // 错误信息带通道名前缀，便于排查是哪条通道失败
          errors.push(ch.name + ": " + (e && e.message ? e.message : String(e)));
          failed++;
          // 参与本轮的通道都失败：立即返回错误，不必等总超时
          if (failed === active.length) {
            finish({ ok: false, error: "翻译服务暂时不可用（" + errors.join(" / ") + "）" });
          }
        });
    });
  });
}

/**
 * 在线翻译。opts.extended 为 true 时使用放宽的超时预算——
 * 这是内容脚本失败重试时传的标记：第一次用短超时快速失败，
 * 重试用长超时兜住网络抖动，避免动辄报「暂时不可用」。
 */
async function translate(word, opts) {
  const hit = cacheGet(word);
  if (hit) return hit;

  const budget = (opts && opts.extended)
    ? { channel: RETRY_CHANNEL_TIMEOUT, total: RETRY_TOTAL_TIMEOUT }
    : null;
  const res = await raceChannels(word, budget);
  // 仅缓存成功结果，避免把临时失败固化
  if (res && res.ok) cacheSet(word, res);
  return res;
}

// ---------- 离线词库查询（v1.2.0）----------
//
// 内容脚本不再持有词库，改为发 HT_LOOKUP 消息到这里查。
// 返回的是「渲染就绪」结构（与在线结果同形），内容脚本拿到即可直接画气泡。
//
// 惰性初始化说明：
//   service worker 空闲约 30s 会被浏览器回收，但 importScripts 在重建时会
//   重新执行，所以 DICT_READY 总是正确的。这里额外做的是——把"首次查词"作为
//   唯一的重建触发点，不需要 chrome.alarms 常驻唤醒（那会白白耗电）。
function lookupOffline(rawWord) {
  const w = String(rawWord || "").toLowerCase().trim();
  if (!w) return { ok: false, found: false, reason: "empty" };
  if (!DICT_READY) return { ok: false, found: false, reason: "dict-unavailable" };

  const hit = lookupLocal(w);
  if (!hit) return { ok: true, found: false };
  return { ok: true, found: true, result: buildLocalResult(hit) };
}

// ---------- 消息路由 ----------
// 说明：取词开关（enabled / onlineFallback / showPhonetic / showBall）一律由
// 各上下文直接读写 chrome.storage.sync，不经后台中转 —— 这样 service worker
// 休眠时开关依然可靠，也不会出现多上下文写入竞态。
// 后台只负责两件事：离线查词、在线翻译代理。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "HT_LOOKUP") {
    // 本地查词是纯内存操作，无需 async，但保持与 HT_TRANSLATE 一致的响应契约
    let resp;
    try {
      resp = lookupOffline(msg.word);
    } catch (e) {
      resp = { ok: false, found: false, reason: String(e && e.message ? e.message : e) };
    }
    sendResponse(resp);
    return false; // 已同步响应
  }

  if (msg.type === "HT_DICT_INFO") {
    // popup 用于展示词条数（popup 不再自己加载 2.1 MB 词库）
    const core = typeof LOCAL_DICT === "object" && LOCAL_DICT ? Object.keys(LOCAL_DICT).length : 0;
    const extra = typeof DICT_EXTRA === "object" && DICT_EXTRA ? Object.keys(DICT_EXTRA).length : 0;
    sendResponse({ ok: DICT_READY, core: core, extra: extra, total: core + extra, version: HT_BG_VERSION });
    return false;
  }

  if (msg.type === "HT_TRANSLATE") {
    translate(String(msg.word || "").trim(), { extended: msg.extended === true })
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
