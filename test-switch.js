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
    storage: { sync: { get(d, cb) { cb && cb(d); }, set(_p, cb) { cb && cb(); } } },
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

// ---- 模拟 chrome ----
const storageState = { enabled: true, onlineFallback: false, showPhonetic: true, hoverDelay: 80, showBall: true };
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

  console.log(log.join("\n"));
  console.log("\n通过 " + pass + " / " + (pass + fail));
  process.exit(fail === 0 ? 0 : 1);
})();
