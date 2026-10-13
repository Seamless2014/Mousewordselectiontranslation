/**
 * 开关链路诊断脚本（开发自测）。
 * 逐一验证：悬浮球点击 / 消息切换 / storage 同步 三条开关路径是否生效。
 *
 * v1.2.0：词库已移到 service worker，本测试同样真实启动 background.js
 * 并代理 sendMessage，保证"开关 + 查词"在同一套真实装配下被验证。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");

const DIR = __dirname;
const contentSrc = fs.readFileSync(path.join(DIR, "content.js"), "utf8");

// ---------------- 启动真实后台 ----------------
function createWorker() {
  let messageHandler = null;
  let ctx = null;
  // v1.5.0：TTS 调用记录（background.js chrome.tts.speak 走到这里）
  const ttsCalls = [];
  // v1.5.0：生词本落 chrome.storage.local.ht_history，mock 出 local 区
  const localStorageState = {};
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Map, Set, Object, Array, String, Number, Error, JSON,
  };
  sandbox.importScripts = function () {
    Array.prototype.slice.call(arguments).forEach(n => {
      const p = path.join(DIR, n);
      if (!fs.existsSync(p)) throw new Error("importScripts 目标不存在: " + n);
      vm.runInContext(fs.readFileSync(p, "utf8"), ctx, { filename: n });
    });
  };
  sandbox.chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener(fn) { messageHandler = fn; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
    contextMenus: { removeAll(cb) { cb && cb(); }, create() {}, onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    tabs: { query(_q, cb) { cb && cb([]); }, sendMessage(_i, _m, cb) { cb && cb(); } },
    storage: {
      sync: { get(d, cb) { cb && cb(d); }, set(_p, cb) { cb && cb(); } },
      // v1.5.0：local 区 mock（生词本 ht_history 落这里）
      local: {
        get(keys, cb) {
          const out = {};
          const pick = k => { if (localStorageState[k] !== undefined) out[k] = localStorageState[k]; };
          if (typeof keys === "string") pick(keys);
          else if (Array.isArray(keys)) keys.forEach(pick);
          else if (keys && typeof keys === "object") Object.keys(keys).forEach(k => {
            out[k] = localStorageState[k] !== undefined ? localStorageState[k] : keys[k];
          });
          cb && cb(out);
        },
        set(patch, cb) { Object.assign(localStorageState, patch); cb && cb(); }
      }
    },
    // v1.5.0：TTS mock（记录 speak 调用供测试断言）
    tts: {
      speak(text, opts) { ttsCalls.push({ text: text, opts: opts }); },
      stop() {}
    },
  };
  sandbox.fetch = () => Promise.reject(new Error("offline test"));
  sandbox.AbortController = function () { this.signal = {}; this.abort = function () {}; };

  ctx = vm.createContext(sandbox);
  sandbox.sandboxImportScripts = sandbox.importScripts;
  vm.runInContext(
    fs.readFileSync(path.join(DIR, "background.js"), "utf8")
      .replace(/^importScripts\(/m, "sandboxImportScripts("),
    ctx,
    { filename: "background.js" }
  );

  return {
    dispatch(msg) {
      return new Promise((resolve, reject) => {
        if (typeof messageHandler !== "function") return reject(new Error("后台未注册监听器"));
        const t = setTimeout(() => reject(new Error("后台响应超时: " + msg.type)), 2000);
        messageHandler(msg, { id: "test" }, resp => { clearTimeout(t); resolve(resp); });
      });
    },
    ttsCalls: ttsCalls,
    localStorage: localStorageState,
  };
}
const worker = createWorker();

const dom = new JSDOM(
  `<!DOCTYPE html><html><body><p id="p1">efficiency approach implementation</p></body></html>`,
  { pretendToBeVisual: true, url: "https://example.com/" }
);
const { window } = dom;
const { document } = window;

let hoverTarget = null;
document.caretRangeFromPoint = function () {
  if (!hoverTarget) return null;
  const r = document.createRange();
  r.setStart(hoverTarget.node, hoverTarget.offset);
  r.setEnd(hoverTarget.node, hoverTarget.offset);
  return r;
};

// ---- 划词查询 mock：jsdom 的 Selection API 不完整，手动 mock ----
let mockSel = null;
window.getSelection = function () {
  return mockSel || {
    isCollapsed: true,
    rangeCount: 0,
    toString: function () { return ""; },
    getRangeAt: function () { return null; }
  };
};
function setSelection(text, rect) {
  mockSel = {
    isCollapsed: false,
    rangeCount: 1,
    toString: function () { return text; },
    getRangeAt: function () {
      return {
        getBoundingClientRect: function () {
          return rect || { left: 50, top: 50, width: 100, height: 20, bottom: 70 };
        }
      };
    }
  };
}
function clearSelection() { mockSel = null; }

// ---- 模拟 chrome ----
const storageState = { enabled: true, onlineFallback: false, showPhonetic: true, hoverDelay: 80, showBall: true };
// 悬浮球拖动后的位置落在 content 侧的 chrome.storage.local
const contentLocalState = {};
const storageListeners = [];
const onMessageListeners = [];
const sentToBackground = [];

const chromeMock = {
  runtime: {
    lastError: null,
    sendMessage(msg, cb) {
      sentToBackground.push(msg);
      // 真实转发给后台（HT_LOOKUP / HT_DICT_INFO 都会走到这里）
      worker.dispatch(msg).then(resp => {
        if (cb) setTimeout(() => cb(resp), 0);
      }).catch(() => {
        if (cb) setTimeout(() => cb(undefined), 0);
      });
      return Promise.resolve();
    },
    onMessage: { addListener(fn) { onMessageListeners.push(fn); } }
  },
  storage: {
    sync: {
      get(defaults, cb) { cb(Object.assign({}, defaults, storageState)); },
      set(patch, cb) { Object.assign(storageState, patch); cb && cb(); }
    },
    // 悬浮球位置读写走 local 区
    local: {
      get(key, cb) {
        const out = {};
        if (typeof key === "string") {
          if (contentLocalState[key] !== undefined) out[key] = contentLocalState[key];
        } else if (Array.isArray(key)) {
          key.forEach(k => { if (contentLocalState[k] !== undefined) out[k] = contentLocalState[k]; });
        } else if (key && typeof key === "object") {
          Object.keys(key).forEach(k => {
            out[k] = contentLocalState[k] !== undefined ? contentLocalState[k] : key[k];
          });
        }
        cb && cb(out);
      },
      set(patch, cb) { Object.assign(contentLocalState, patch); cb && cb(); }
    },
    onChanged: { addListener(fn) { storageListeners.push(fn); } }
  }
};

window.chrome = chromeMock;
global.chrome = chromeMock;
global.window = window;
global.document = document;
global.Node = window.Node;
global.HTMLElement = window.HTMLElement;
global.getComputedStyle = window.getComputedStyle;
global.location = window.location;

// 按 manifest 声明顺序注入（v1.2.0 起内容脚本只有 content.js）。
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
const fileMap = { "content.js": contentSrc };
const bootstrapped = manifest.content_scripts[0].js.map(f => {
  if (!(f in fileMap)) {
    throw new Error("manifest 注入了本测试不认识的脚本：" + f +
      "（v1.2.0 起内容脚本应只有 content.js）");
  }
  return "/* ==== " + f + " ==== */\n" + fileMap[f];
}).join("\n;\n");
new Function("window", "document", "chrome", "Node", "globalThis", bootstrapped)(
  window, document, chromeMock, window.Node, globalThis
);
document.dispatchEvent(new window.Event("DOMContentLoaded"));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const log = [];
function check(name, cond, extra) {
  if (cond) { pass++; log.push("  ✓ " + name); }
  else { fail++; log.push("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
function findTextNode(el) {
  const w = document.createTreeWalker(el, window.NodeFilter.SHOW_TEXT);
  return w.nextNode();
}
async function hover(el, word) {
  const node = findTextNode(el);
  const i = node.nodeValue.indexOf(word);
  hoverTarget = { node, offset: i + 1 };
  el.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 50, clientY: 50 }));
  // 比 v1.1 略长：现在查询要走一次 chrome.runtime 消息往返（后台查词）
  await sleep(200);
}
const bubbleVisible = () => {
  const b = document.querySelector(".ht-bubble");
  return !!b && b.classList.contains("ht-show");
};
const bubbleText = () => {
  const b = document.querySelector(".ht-bubble");
  return b ? b.textContent : "";
};

(async function run() {
  console.log("=".repeat(58));
  console.log("开关链路诊断");
  console.log("=".repeat(58));
  await sleep(40);

  const p1 = document.getElementById("p1");
  const ball = document.querySelector(".ht-ball");
  check("悬浮球已注入", !!ball);
  if (!ball) { console.log(log.join("\n")); process.exit(1); }

  // ---------- 路径 0：查词链路走后台 ----------
  console.log("\n[路径 0] 离线查词是否经后台（v1.2.0 新链路）");
  await hover(p1, "efficiency");
  check("悬停 efficiency 弹出气泡", bubbleVisible());
  check("气泡显示后台返回的释义（含「效率」）", bubbleText().includes("效率"),
    bubbleText().slice(0, 80));
  check("确实发出了 HT_LOOKUP 消息",
    sentToBackground.some(m => m.type === "HT_LOOKUP"),
    "已发消息类型：" + JSON.stringify([...new Set(sentToBackground.map(m => m.type))]));
  check("本地命中时不再发在线请求（HT_TRANSLATE 未发出）",
    !sentToBackground.some(m => m.type === "HT_TRANSLATE"));
  hoverTarget = null;
  p1.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 400, clientY: 400 }));
  await sleep(420);

  // ---------- 路径 A：悬浮球点击 ----------
  console.log("\n[路径 A] 悬浮球点击");
  check("初始状态为开启(on)", ball.classList.contains("ht-ball-on"));

  ball.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(30);
  check("点击后变为关闭态(off)", ball.classList.contains("ht-ball-off"),
    "当前 class: " + ball.className);
  check("关闭后图标变为 ×", ball.textContent === "×", "当前文本: " + JSON.stringify(ball.textContent));

  await hover(p1, "efficiency");
  check("关闭状态下悬停不弹气泡", !bubbleVisible());

  ball.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(30);
  check("再次点击回到开启态(on)", ball.classList.contains("ht-ball-on"));

  await hover(p1, "efficiency");
  check("开启后悬停恢复弹气泡", bubbleVisible());
  hoverTarget = null;
  p1.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 400, clientY: 400 }));
  await sleep(420);

  // ---------- 路径 B：notification from background (HT_TOGGLE) ----------
  console.log("\n[路径 B] 消息切换 HT_TOGGLE（右键菜单/快捷键走这条）");
  check("已注册 onMessage 监听", onMessageListeners.length > 0);
  if (onMessageListeners.length) {
    let resp = null;
    onMessageListeners.forEach(fn => fn({ type: "HT_TOGGLE" }, {}, r => { resp = r; }));
    await sleep(30);
    check("收到 HT_TOGGLE 后返回状态", resp && resp.ok === true, JSON.stringify(resp));
    check("HT_TOGGLE 后切换为关闭态", ball.classList.contains("ht-ball-off"),
      "当前 class: " + ball.className);
    // 切回来
    onMessageListeners.forEach(fn => fn({ type: "HT_TOGGLE" }, {}, () => {}));
    await sleep(30);
    check("再次 HT_TOGGLE 回到开启", ball.classList.contains("ht-ball-on"));
  }

  // ---------- 路径 C：storage.onChanged 同步 ----------
  console.log("\n[路径 C] storage 同步（popup 里改开关走这条）");
  check("已注册 onChanged 监听", storageListeners.length > 0);
  if (storageListeners.length) {
    storageListeners.forEach(fn => fn({ enabled: { newValue: false } }, "sync"));
    await sleep(30);
    check("storage 置 false 后悬浮球变关闭态", ball.classList.contains("ht-ball-off"),
      "当前 class: " + ball.className);
    await hover(p1, "efficiency");
    check("storage 关闭后悬停不弹气泡", !bubbleVisible());

    storageListeners.forEach(fn => fn({ enabled: { newValue: true } }, "sync"));
    await sleep(30);
    check("storage 置 true 后恢复开启态", ball.classList.contains("ht-ball-on"));

    // 顺带验证 showBall 开关
    storageListeners.forEach(fn => fn({ showBall: { newValue: false } }, "sync"));
    await sleep(30);
    check("showBall=false 后悬浮球被移除", !document.querySelector(".ht-ball"));
    storageListeners.forEach(fn => fn({ showBall: { newValue: true } }, "sync"));
    await sleep(30);
    check("showBall=true 后悬浮球重新注入", !!document.querySelector(".ht-ball"));
  }

  // ---------- 持久化：setEnabled 是否直接写入 storage ----------
  console.log("\n[持久化] 悬浮球点击是否直接写入 storage");
  const b2 = document.querySelector(".ht-ball");
  const beforeVal = storageState.enabled;
  b2.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(30);
  check("点击悬浮球直接翻转 storage.enabled", storageState.enabled === !beforeVal,
    `storage.enabled: ${beforeVal} -> ${storageState.enabled}`);
  check("不再经由后台中转写 storage", sentToBackground.filter(m => m.type === "HT_SET_ENABLED").length === 0,
    "仍观察到 HT_SET_ENABLED 消息");

  // 模拟「先关闭，页面刷新后重新加载」是否保持关闭
  console.log("\n[持久化] 状态持久性（模拟刷新）");
  // 此时 storage.enabled 应为 false，重新构造一个内容脚本实例验证读取
  check("storage 中持久化了关闭状态", storageState.enabled === false,
    "storage.enabled=" + storageState.enabled);

  // ---------- 路径 D：站点黑名单 ----------
  console.log("\n[路径 D] 站点黑名单（disabledSites）");
  // 先恢复 enabled=true（上面持久化测试把它关了）
  storageListeners.forEach(fn => fn({ enabled: { newValue: true } }, "sync"));
  await sleep(30);
  check("恢复 enabled 后悬浮球存在", !!document.querySelector(".ht-ball"));

  // D1：屏蔽当前站点 example.com
  storageListeners.forEach(fn => fn({ disabledSites: { newValue: ["example.com"] } }, "sync"));
  await sleep(30);
  check("屏蔽当前站点后悬浮球被移除", !document.querySelector(".ht-ball"),
    "仍有悬浮球");
  await hover(p1, "efficiency");
  check("屏蔽当前站点后悬停不弹气泡", !bubbleVisible());
  hoverTarget = null;
  p1.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 400, clientY: 400 }));
  await sleep(120);

  // D2：解除屏蔽
  storageListeners.forEach(fn => fn({ disabledSites: { newValue: [] } }, "sync"));
  await sleep(30);
  check("解除屏蔽后悬浮球恢复", !!document.querySelector(".ht-ball"));
  await hover(p1, "efficiency");
  check("解除屏蔽后悬停恢复弹气泡", bubbleVisible());
  hoverTarget = null;
  p1.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 400, clientY: 400 }));
  await sleep(420);

  // D3：屏蔽其他站点不影响当前
  storageListeners.forEach(fn => fn({ disabledSites: { newValue: ["other.com"] } }, "sync"));
  await sleep(30);
  check("屏蔽其他站点不影响当前悬浮球", !!document.querySelector(".ht-ball"));
  await hover(p1, "efficiency");
  check("屏蔽其他站点后当前仍可悬停弹气泡", bubbleVisible());
  hoverTarget = null;
  p1.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 400, clientY: 400 }));
  await sleep(420);

  // ---------- 路径 E：单词发音（v1.5.0） ----------
  console.log("\n[路径 E] 单词发音按钮（HT_TTS）");
  // 恢复 showTts 默认开启
  storageListeners.forEach(fn => fn({ showTts: { newValue: true } }, "sync"));
  await sleep(30);

  // E1：悬停后气泡含发音按钮
  await hover(p1, "efficiency");
  const ttsBtn = document.querySelector(".ht-bubble .ht-tts");
  check("E1 气泡中存在发音按钮 .ht-tts", !!ttsBtn, "未渲染 .ht-tts");
  if (ttsBtn) {
    check("E1 发音按钮带 data-word 属性（值为 efficiency）",
      ttsBtn.getAttribute("data-word") === "efficiency",
      "data-word = " + ttsBtn.getAttribute("data-word"));
  }

  // E2：点击发音按钮 → 发 HT_TTS 消息 → 后台 chrome.tts.speak 被调用
  if (ttsBtn) {
    const ttsCallsBefore = worker.ttsCalls.length;
    const sentTtsBefore = sentToBackground.filter(m => m.type === "HT_TTS").length;
    ttsBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(50);
    check("E2 点击发音按钮后发出 HT_TTS 消息",
      sentToBackground.filter(m => m.type === "HT_TTS").length > sentTtsBefore,
      "HT_TTS 消息数未增加");
    check("E2 后台 chrome.tts.speak 被调用且参数正确",
      worker.ttsCalls.length > ttsCallsBefore &&
      worker.ttsCalls[worker.ttsCalls.length - 1].text === "efficiency",
      "ttsCalls = " + JSON.stringify(worker.ttsCalls.map(c => c.text)));
    check("E2 speak 调用使用 en-US 语音",
      worker.ttsCalls[worker.ttsCalls.length - 1].opts.lang === "en-US");
  }

  // E3：showTts=false → 下次悬停气泡不再含发音按钮
  storageListeners.forEach(fn => fn({ showTts: { newValue: false } }, "sync"));
  await sleep(30);
  hoverTarget = null;
  p1.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 400, clientY: 400 }));
  await sleep(420);
  await hover(p1, "efficiency");
  check("E3 showTts=false 后气泡不再含发音按钮",
    !document.querySelector(".ht-bubble .ht-tts"),
    "仍存在 .ht-tts");

  // E4：恢复 showTts=true → 重新出现发音按钮
  storageListeners.forEach(fn => fn({ showTts: { newValue: true } }, "sync"));
  await sleep(30);
  hoverTarget = null;
  p1.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 400, clientY: 400 }));
  await sleep(420);
  await hover(p1, "efficiency");
  check("E4 showTts=true 恢复后发音按钮重新出现",
    !!document.querySelector(".ht-bubble .ht-tts"));
  hoverTarget = null;
  p1.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 400, clientY: 400 }));
  await sleep(420);

  // ---------- 路径 F：划词/双击查询（v1.5.0） ----------
  console.log("\n[路径 F] 划词/双击查询（enableSelection）");
  // 确保总开关 + 划词开关都开
  storageListeners.forEach(fn => fn({ enabled: { newValue: true } }, "sync"));
  storageListeners.forEach(fn => fn({ enableSelection: { newValue: true } }, "sync"));
  await sleep(30);

  // F1：双击单词（mock selection = "efficiency"）→ 气泡显示释义
  setSelection("efficiency");
  p1.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, clientX: 60, clientY: 60 }));
  await sleep(120);
  check("F1 选区单词 efficiency 触发查询并弹气泡", bubbleVisible(),
    "气泡状态: " + (bubbleVisible() ? "visible" : "hidden"));
  check("F1 气泡含 efficiency 释义", /效率/.test(bubbleText()),
    bubbleText().slice(0, 80));
  check("F1 走 HT_LOOKUP 消息（单词查词库）",
    sentToBackground.some(m => m.type === "HT_LOOKUP" && m.word === "efficiency"));
  clearSelection();

  // F2：多词选区 → 走 HT_TRANSLATE 整句翻译
  // 先开 onlineFallback 让多词查询能走到 HT_TRANSLATE 分支
  storageListeners.forEach(fn => fn({ onlineFallback: { newValue: true } }, "sync"));
  await sleep(30);
  const sentTranslateBefore = sentToBackground.filter(m => m.type === "HT_TRANSLATE").length;
  setSelection("efficiency approach");
  p1.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, clientX: 60, clientY: 60 }));
  await sleep(150);
  check("F2 多词选区触发 HT_TRANSLATE 消息",
    sentToBackground.filter(m => m.type === "HT_TRANSLATE").length > sentTranslateBefore,
    "HT_TRANSLATE 数未增加");
  check("F2 HT_TRANSLATE 携带完整多词文本",
    sentToBackground.some(m => m.type === "HT_TRANSLATE" && m.word === "efficiency approach"));
  clearSelection();

  // F3：enableSelection=false → mouseup 不触发查询
  storageListeners.forEach(fn => fn({ enableSelection: { newValue: false } }, "sync"));
  await sleep(30);
  // 先关掉当前气泡
  p1.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 400, clientY: 400 }));
  await sleep(420);
  const sentLookupBefore = sentToBackground.filter(m => m.type === "HT_LOOKUP").length;
  const sentTranslateBefore2 = sentToBackground.filter(m => m.type === "HT_TRANSLATE").length;
  setSelection("implementation");
  p1.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, clientX: 60, clientY: 60 }));
  await sleep(150);
  check("F3 enableSelection=false 后 mouseup 不发 HT_LOOKUP",
    sentToBackground.filter(m => m.type === "HT_LOOKUP").length === sentLookupBefore);
  check("F3 enableSelection=false 后 mouseup 不发 HT_TRANSLATE",
    sentToBackground.filter(m => m.type === "HT_TRANSLATE").length === sentTranslateBefore2);
  clearSelection();
  // 恢复
  storageListeners.forEach(fn => fn({ enableSelection: { newValue: true } }, "sync"));
  await sleep(30);

  // F4：站点黑名单不影响划词查询（划词豁免 siteDisabled）
  storageListeners.forEach(fn => fn({ disabledSites: { newValue: ["example.com"] } }, "sync"));
  await sleep(30);
  check("F4 站点屏蔽后悬浮球被移除（对照）", !document.querySelector(".ht-ball"));
  setSelection("approach");
  p1.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, clientX: 60, clientY: 60 }));
  await sleep(150);
  check("F4 站点屏蔽下划词仍弹气泡（划词豁免黑名单）", bubbleVisible(),
    "气泡状态: " + (bubbleVisible() ? "visible" : "hidden"));
  check("F4 站点屏蔽下划词仍发 HT_LOOKUP",
    sentToBackground.some(m => m.type === "HT_LOOKUP" && m.word === "approach"));
  clearSelection();
  // 清理：解除屏蔽
  storageListeners.forEach(fn => fn({ disabledSites: { newValue: [] } }, "sync"));
  await sleep(30);

  // ---------- 路径 G：生词本端到端（v1.5.0）----------
  console.log("\n[路径 G] 查词命中后落盘到生词本（端到端）");
  // 前面 hover 测试已落盘多条，这里重置到干净起点
  worker.localStorage.ht_history = undefined;
  // 确保总开关开
  storageListeners.forEach(fn => fn({ enabled: { newValue: true } }, "sync"));
  await sleep(30);

  // G1：发 HT_LOOKUP（命中精选词库）→ 后台 recordHistory 落盘到 worker.localStorage
  //     注：不依赖 hover 触发，因为前面 hover 测试已让 content 侧缓存了 efficiency，
  //     hover 命中缓存不会重新发 HT_LOOKUP（这是 v1.2.0 内容侧 LRU 缓存的正常行为）。
  //     这里直接发消息验证 background 的 recordHistory 落盘链路端到端可用。
  const g1Resp = await new Promise(resolve => {
    chromeMock.runtime.sendMessage({ type: "HT_LOOKUP", word: "efficiency" }, resp => resolve(resp));
  });
  check("G1 HT_LOOKUP 返回 found:true", g1Resp && g1Resp.found === true, JSON.stringify(g1Resp));
  await sleep(20);
  check("G1 worker.localStorage.ht_history 已落盘",
    Array.isArray(worker.localStorage.ht_history) && worker.localStorage.ht_history.length >= 1,
    "实际：" + JSON.stringify(worker.localStorage.ht_history));
  check("G1 落盘 word 为 efficiency",
    worker.localStorage.ht_history && worker.localStorage.ht_history[0] &&
    worker.localStorage.ht_history[0].word === "efficiency",
    worker.localStorage.ht_history && worker.localStorage.ht_history[0] ?
    worker.localStorage.ht_history[0].word : "无");
  check("G1 落盘 source 为 local",
    worker.localStorage.ht_history && worker.localStorage.ht_history[0] &&
    worker.localStorage.ht_history[0].source === "local");

  // G2：HT_GET_WORDS 消息链路（通过 chromeMock 转发到 worker）
  const g2Resp = await new Promise(resolve => {
    chromeMock.runtime.sendMessage({ type: "HT_GET_WORDS" }, resp => resolve(resp));
  });
  check("G2 HT_GET_WORDS 返回 ok:true", g2Resp && g2Resp.ok === true, JSON.stringify(g2Resp));
  check("G2 HT_GET_WORDS 返回 efficiency 条目",
    g2Resp && Array.isArray(g2Resp.words) && g2Resp.words.some(it => it.word === "efficiency"),
    g2Resp ? "words.length=" + g2Resp.words.length : "无");

  // G3：HT_DEL_WORD 删除单条
  const g3Resp = await new Promise(resolve => {
    chromeMock.runtime.sendMessage({ type: "HT_DEL_WORD", word: "efficiency" }, resp => resolve(resp));
  });
  check("G3 HT_DEL_WORD 返回 ok:true", g3Resp && g3Resp.ok === true);
  const g3Get = await new Promise(resolve => {
    chromeMock.runtime.sendMessage({ type: "HT_GET_WORDS" }, resp => resolve(resp));
  });
  check("G3 删除后 HT_GET_WORDS 不再含 efficiency",
    g3Get && g3Get.words && !g3Get.words.some(it => it.word === "efficiency"));

  // G4：HT_CLEAR_WORDS 清空
  const g4Resp = await new Promise(resolve => {
    chromeMock.runtime.sendMessage({ type: "HT_CLEAR_WORDS" }, resp => resolve(resp));
  });
  check("G4 HT_CLEAR_WORDS 返回 ok:true", g4Resp && g4Resp.ok === true);
  const g4Get = await new Promise(resolve => {
    chromeMock.runtime.sendMessage({ type: "HT_GET_WORDS" }, resp => resolve(resp));
  });
  check("G4 清空后 HT_GET_WORDS 返回空数组",
    g4Get && g4Get.words && g4Get.words.length === 0,
    "实际：" + JSON.stringify(g4Get));

  // ---------- 路径 H：悬浮球拖拽定位 ----------
  console.log("\n[路径 H] 悬浮球拖拽定位 + 位置持久化");
  // 确保总开关开、悬浮球显示、站点未屏蔽
  storageListeners.forEach(fn => fn({ enabled: { newValue: true } }, "sync"));
  storageListeners.forEach(fn => fn({ showBall: { newValue: true } }, "sync"));
  storageListeners.forEach(fn => fn({ disabledSites: { newValue: [] } }, "sync"));
  await sleep(30);

  const hBall = document.querySelector(".ht-ball");
  check("H0 悬浮球存在（拖拽前置条件）", !!hBall);
  if (hBall) {
    const pev = (type, x, y) =>
      hBall.dispatchEvent(new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));

    // H0：初始未拖动过 → 无 inline 定位（沿用 CSS 默认右下角）
    check("H0 初始未拖动时无 inline left/top",
      hBall.style.left === "" && hBall.style.top === "",
      "left=" + JSON.stringify(hBall.style.left));

    // H1：拖动 (100,100) → (160,140)：写入 left/top 并落盘
    //     注：jsdom 里 getBoundingClientRect 全为 0，故起点 left/top 从 0 算起
    pev("pointerdown", 100, 100);
    pev("pointermove", 160, 140);
    pev("pointerup", 160, 140);
    await sleep(20);
    check("H1 拖动后设置 inline left=60px", hBall.style.left === "60px",
      "left=" + JSON.stringify(hBall.style.left));
    check("H1 拖动后设置 inline top=40px", hBall.style.top === "40px",
      "top=" + JSON.stringify(hBall.style.top));
    check("H1 改用 left/top 并释放 right/bottom",
      hBall.style.right === "auto" && hBall.style.bottom === "auto",
      "right=" + JSON.stringify(hBall.style.right) + " bottom=" + JSON.stringify(hBall.style.bottom));
    check("H1 位置已落盘到 storage.local.ht_ball_pos",
      contentLocalState.ht_ball_pos &&
      contentLocalState.ht_ball_pos.left === 60 && contentLocalState.ht_ball_pos.top === 40,
      "实际：" + JSON.stringify(contentLocalState.ht_ball_pos));
    check("H1 拖动结束后移除拖动中样式类", !hBall.classList.contains("ht-ball-dragging"),
      "class=" + hBall.className);

    // H2：拖拽尾随的 click 不应切换开关
    check("H2 拖动后开关仍为开启态", hBall.classList.contains("ht-ball-on"),
      "class=" + hBall.className);
    hBall.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(20);
    check("H2 拖拽后的 click 被抑制，开关不变", hBall.classList.contains("ht-ball-on"),
      "class=" + hBall.className);

    // H3：普通点击（无位移）仍能切换开关
    pev("pointerdown", 200, 200);
    pev("pointerup", 200, 200);
    hBall.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(20);
    check("H3 无拖动的点击仍切换为关闭态", hBall.classList.contains("ht-ball-off"),
      "class=" + hBall.className);
    pev("pointerdown", 200, 200);
    pev("pointerup", 200, 200);
    hBall.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(20);
    check("H3 再次点击切回开启态", hBall.classList.contains("ht-ball-on"),
      "class=" + hBall.className);

    // H4：位移 ≤ 4px 视为手抖，仍按点击处理
    pev("pointerdown", 300, 300);
    pev("pointermove", 302, 301);
    pev("pointerup", 302, 301);
    hBall.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(20);
    check("H4 位移≤4px 不算拖动，点击仍生效（切为关闭态）",
      hBall.classList.contains("ht-ball-off"), "class=" + hBall.className);
    pev("pointerdown", 300, 300);
    pev("pointerup", 300, 300);
    hBall.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(20);

    // H5：越界拖动被夹紧在视口内（jsdom 视口 1024×768，球 38px，边距 4px）
    pev("pointerdown", 500, 500);
    pev("pointermove", 5000, 5000);
    pev("pointerup", 5000, 5000);
    await sleep(20);
    check("H5 越界拖动 left 被夹紧为 982px", hBall.style.left === "982px",
      "left=" + JSON.stringify(hBall.style.left));
    check("H5 越界拖动 top 被夹紧为 726px", hBall.style.top === "726px",
      "top=" + JSON.stringify(hBall.style.top));

    // H6：隐藏再显示悬浮球 → 位置被还原
    storageListeners.forEach(fn => fn({ showBall: { newValue: false } }, "sync"));
    await sleep(30);
    check("H6 showBall=false 后悬浮球被移除", !document.querySelector(".ht-ball"));
    storageListeners.forEach(fn => fn({ showBall: { newValue: true } }, "sync"));
    await sleep(30);
    const hBall2 = document.querySelector(".ht-ball");
    check("H6 showBall=true 后悬浮球恢复", !!hBall2);
    check("H6 恢复的悬浮球还原上次拖动位置",
      hBall2 && hBall2.style.left === "982px" && hBall2.style.top === "726px",
      hBall2 ? ("left=" + JSON.stringify(hBall2.style.left) + " top=" + JSON.stringify(hBall2.style.top)) : "无悬浮球");
  }

  console.log(log.join("\n"));
  console.log("\n通过 " + pass + " / " + (pass + fail));
  process.exit(fail === 0 ? 0 : 1);
})();
