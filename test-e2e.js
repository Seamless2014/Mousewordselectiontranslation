/**
 * 端到端 DOM 模拟测试（开发自测用，非扩展运行时依赖）。
 *
 * 用 jsdom 构造真实页面 DOM，模拟 chrome API 与鼠标事件，
 * 加载 content.js 后验证：
 *   1. 悬停取词能正确提取光标下的单词
 *   2. 词形还原 + 离线词库命中，气泡渲染出正确释义
 *   3. 鼠标移出后气泡自动隐藏
 *   4. 开关逻辑（禁用后不再取词、气泡隐藏）
 *
 * v1.2.0 装配模型变化：
 *  词库不再随 content_scripts 注入，而是由 service worker 通过 importScripts 加载。
 *  因此本测试**真实执行 background.js**（在 vm 上下文中，提供 importScripts 等桩），
 *  并把 chrome.runtime.sendMessage 代理到该 worker 的消息监听器上。
 *  这样"内容脚本 -> 后台 -> 词库"的整条链路都被真实覆盖，
 *  而不是用假响应糊过去（那会掩盖装配缺陷，历史上吃过这个亏）。
 *
 * 运行：node test-e2e.js
 *   （需要 NODE_PATH 指向已安装 jsdom 的 node_modules）
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");

const DIR = __dirname;
const contentSrc = fs.readFileSync(path.join(DIR, "content.js"), "utf8");

// ---------------- 真实启动后台 worker ----------------
// 复制 test-background.js 的最小实现：加载 background.js，拿到消息监听器。
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
    contextMenus: {
      removeAll(cb) { cb && cb(); },
      create() {},
      onClicked: { addListener() {} },
    },
    commands: { onCommand: { addListener() {} } },
    tabs: { query(_q, cb) { cb && cb([]); }, sendMessage(_i, _m, cb) { cb && cb(); } },
    storage: { sync: { get(d, cb) { cb && cb(d); }, set(_p, cb) { cb && cb(); } } },
  };
  // 在线通道默认失败，以便本地命中路径被单独验证；
  // 需要测在线兜底的用例会临时替换这个实现。
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
    sandbox,
    hasHandler: () => typeof messageHandler === "function",
    /** 把消息丢给后台监听器，拿到响应 */
    dispatch(msg) {
      return new Promise((resolve, reject) => {
        if (typeof messageHandler !== "function") return reject(new Error("后台未注册监听器"));
        const timer = setTimeout(() => reject(new Error("后台响应超时: " + msg.type)), 2000);
        messageHandler(msg, { id: "test" }, resp => {
          clearTimeout(timer);
          resolve(resp);
        });
      });
    },
  };
}

const worker = createWorker();

// ---------------- 构造 DOM 环境 ----------------
const dom = new JSDOM(
  `<!DOCTYPE html><html><body>
     <p id="p1">The efficiency of this approach is significantly important.</p>
     <p id="p2">Implementations were deployed and configurations validated.</p>
     <p id="p3">The procurement cost keeps depreciating, while efficiency improves.</p>
   </body></html>`,
  { pretendToBeVisual: true, url: "https://example.com/" }
);

const { window } = dom;
const { document } = window;

// jsdom 未实现 caretRangeFromPoint，这里用 Range 模拟：给定坐标返回对应文本节点偏移
let hoverTarget = null; // { node, offset }
document.caretRangeFromPoint = function () {
  if (!hoverTarget) return null;
  const r = document.createRange();
  r.setStart(hoverTarget.node, hoverTarget.offset);
  r.setEnd(hoverTarget.node, hoverTarget.offset);
  return r;
};

// ---------------- 模拟 chrome API ----------------
const storage = { enabled: true, onlineFallback: false, showPhonetic: true, hoverDelay: 80, showBall: true };
const storageListeners = [];
const sentMessages = [];

const chromeMock = {
  runtime: {
    lastError: null,
    sendMessage(msg, cb) {
      sentMessages.push(msg);
      // 关键：真实转发给后台 worker，而不是伪造响应
      worker.dispatch(msg).then(resp => {
        if (cb) setTimeout(() => cb(resp), 0);
      }).catch(() => {
        if (cb) setTimeout(() => cb(undefined), 0);
      });
      return Promise.resolve();
    },
    onMessage: { addListener() {} }
  },
  storage: {
    sync: {
      get(defaults, cb) { cb(Object.assign({}, defaults, storage)); },
      set(patch, cb) { Object.assign(storage, patch); cb && cb(); }
    },
    onChanged: {
      addListener(fn) { storageListeners.push(fn); }
    }
  }
};

// 注入环境
window.chrome = chromeMock;
global.chrome = chromeMock;
global.window = window;
global.document = document;
global.Node = window.Node;
global.HTMLElement = window.HTMLElement;
global.getComputedStyle = window.getComputedStyle;

// ---------------- 加载 content.js ----------------
//
// v1.2.0 起 content_scripts 只注入 content.js 一个文件，词库与查词逻辑都在后台，
// 所以这里只执行 content.js —— 如果哪天有人把词库又塞回内容脚本，本测试的
// "装配校验"断言会立刻暴露（见下方 probe 检查）。
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
const injectOrder = manifest.content_scripts[0].js;
const fileMap = { "content.js": contentSrc };
const bootstrapped = injectOrder.map(f => {
  if (!(f in fileMap)) {
    throw new Error("manifest 注入了本测试不认识的脚本：" + f +
      "（v1.2.0 起内容脚本应只有 content.js）");
  }
  return "/* ==== " + f + " ==== */\n" + fileMap[f];
}).join("\n;\n");

try {
  new Function("window", "document", "chrome", "Node", "globalThis", bootstrapped)(
    window, document, chromeMock, window.Node, globalThis
  );
} catch (e) {
  console.error("内容脚本加载失败：", e.message);
  process.exit(1);
}

// 装配校验：内容脚本里不该再有词库。
if (injectOrder.some(f => /^dict/.test(f))) {
  console.error("装配缺陷：content_scripts 注入了词库文件 " + JSON.stringify(injectOrder) +
    "，v1.2.0 起词库只应由后台持有");
  process.exit(1);
}
if (!worker.hasHandler()) {
  console.error("装配缺陷：后台未注册消息监听器，内容脚本无法查词");
  process.exit(1);
}
// 后台词库就绪性在下方异步主流程开头校验（需要 await）。

// 触发 DOMContentLoaded 让脚本完成初始化
document.dispatchEvent(new window.Event("DOMContentLoaded"));

// ---------------- 测试工具 ----------------
let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
  if (cond) { pass++; results.push("  ✓ " + name); }
  else { fail++; results.push("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function findTextNode(el) {
  const walker = document.createTreeWalker(el, window.NodeFilter.SHOW_TEXT);
  return walker.nextNode();
}

// 模拟悬停：设置 hoverTarget 后派发 mousemove（新触发模型：mousemove 防抖）
async function hoverWord(el, word) {
  const node = findTextNode(el);
  const idx = node.nodeValue.indexOf(word);
  if (idx < 0) throw new Error("页面中找不到单词：" + word);
  // 取单词中间字符的偏移，模拟鼠标落在词中
  hoverTarget = { node: node, offset: idx + 1 };
  el.dispatchEvent(new window.MouseEvent("mousemove", {
    bubbles: true, clientX: 100, clientY: 100
  }));
  await sleep(160); // 超过 hoverDelay(80ms)
}

function getBubble() {
  return document.querySelector(".ht-bubble");
}
function bubbleText() {
  const b = getBubble();
  return b ? b.textContent : "";
}
function bubbleVisible() {
  const b = getBubble();
  return !!b && b.classList.contains("ht-show");
}

// ---------------- 用例 ----------------
(async function run() {
  console.log("=".repeat(60));
  console.log("端到端 DOM 模拟测试");
  console.log("=".repeat(60));

  // ---- 装配校验：后台词库必须真的就绪 ----
  const dictInfo = await worker.dispatch({ type: "HT_DICT_INFO" });
  if (!dictInfo || !dictInfo.ok || dictInfo.core < 100 || dictInfo.extra < 1000) {
    console.error("装配缺陷：后台词库未就绪 " + JSON.stringify(dictInfo) +
      " —— background.js 的 importScripts 是否漏配？");
    process.exit(1);
  }
  console.log("后台词库：精选 " + dictInfo.core + " 条 + 扩展 " + dictInfo.extra +
    " 条 = " + dictInfo.total + " 条（内容脚本不再持有词库）\n");

  const p1 = document.getElementById("p1");
  const p2 = document.getElementById("p2");

  // 1. 悬浮球应已注入
  await sleep(30);
  check("悬浮球已注入页面", !!document.querySelector(".ht-ball"));

  // 2. 悬停 efficiency（本地词库命中）
  await hoverWord(p1, "efficiency");
  check("悬停 efficiency 气泡可见", bubbleVisible());
  check("气泡显示 efficiency", bubbleText().includes("efficiency"), bubbleText().slice(0, 60));
  check("气泡显示释义「效率」", bubbleText().includes("效率"), bubbleText().slice(0, 80));
  check("气泡标记来源为本地词库", bubbleText().includes("本地词库"));
  check("气泡带词性标记 n.", bubbleText().includes("n."));

  // 3. 鼠标移到空白区域（无文本）-> 气泡隐藏
  hoverTarget = null;
  document.body.dispatchEvent(new window.MouseEvent("mousemove", {
    bubbles: true, clientX: 300, clientY: 300
  }));
  await sleep(420); // 防抖(80) + 隐藏延迟(120) + 余量
  check("鼠标移到空白区域后气泡隐藏", !bubbleVisible());

  // 3b. 同一段落内换词（旧版 mouseover 模型的盲区，用户实际遇到的场景）
  await hoverWord(p1, "efficiency");
  check("段落内第一个词 efficiency 正常弹出", bubbleVisible() && bubbleText().includes("效率"));
  // 不移出段落，直接换词
  await hoverWord(p1, "approach");
  check("同段落内换词 approach 也能翻译", bubbleText().includes("方法"),
    "气泡内容: " + bubbleText().slice(0, 60));
  check("气泡已切换为 approach", bubbleText().includes("approach"));

  // 4. 悬停 significantly（副词，本地命中）
  await hoverWord(p1, "significantly");
  check("悬停 significantly 命中且显示副词", bubbleText().includes("显著"), bubbleText().slice(0, 80));
  hoverTarget = null;
  document.body.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 300, clientY: 300 }));
  await sleep(420);

  // 5. 悬停 Implementations（复数 -> 词形还原到 implementation）
  await hoverWord(p2, "Implementations");
  check("悬停 Implementations 复数还原命中", bubbleText().includes("实现"), bubbleText().slice(0, 90));
  check("气泡提示原形 implementation", bubbleText().includes("implementation"), bubbleText().slice(0, 90));
  hoverTarget = null;
  document.body.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 300, clientY: 300 }));
  await sleep(420);

  // 6. 悬停 configurations（复数还原）
  await hoverWord(p2, "configurations");
  check("悬停 configurations 复数还原命中", bubbleText().includes("配置"), bubbleText().slice(0, 90));
  hoverTarget = null;
  document.body.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 300, clientY: 300 }));
  await sleep(420);

  // 7. 开关：禁用后不再取词
  const ball = document.querySelector(".ht-ball");
  ball.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(30);
  check("点击悬浮球后切换为关闭态", ball.classList.contains("ht-ball-off"));
  await hoverWord(p1, "efficiency");
  check("关闭状态下悬停不显示气泡", !bubbleVisible());

  // 8. Esc 关闭气泡（先重新开启）
  ball.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(30);
  check("再次点击切回开启态", ball.classList.contains("ht-ball-on"));

  await hoverWord(p1, "approach");
  check("重新开启后取词恢复", bubbleVisible());
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(30);
  check("按 Esc 关闭气泡", !bubbleVisible());

  // 9. 短词 / 非单词不应触发
  await hoverWord(p1, "is");
  check("长度 <2 的词不触发（is 为 2 字符，应命中词库）", bubbleVisible());

  // ---- 10. 扩展词库（ECDICT）路径 ----
  hoverTarget = null;
  document.body.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 300, clientY: 300 }));
  await sleep(420);

  const p3 = document.getElementById("p3");

  // procurement 只在扩展库，应命中且带音标、角标标注"扩展"
  await hoverWord(p3, "procurement");
  check("悬停扩展库词 procurement 弹出气泡", bubbleVisible());
  check("procurement 显示中文释义", /采购|获得/.test(bubbleText()), bubbleText().slice(0, 90));
  check("procurement 角标标注「本地词库 · 扩展」",
    bubbleText().includes("本地词库 · 扩展"), bubbleText().slice(0, 90));
  check("procurement 显示音标（来自扩展库 k 字段）",
    !!getBubble().querySelector(".ht-phonetic"), bubbleText().slice(0, 90));

  // depreciating 不在库里，需经词形还原命中 depreciate
  await hoverWord(p3, "depreciating");
  check("悬停 depreciating 经词形还原命中", bubbleVisible());
  check("depreciating 显示原形提示", bubbleText().includes("depreciate"), bubbleText().slice(0, 90));

  // 精选词库仍优先：efficiency 应标"本地词库"（不带"扩展"）
  await hoverWord(p3, "efficiency");
  const effBadge = getBubble().querySelector(".ht-badge");
  check("精选词条角标不含「扩展」",
    !!effBadge && !effBadge.textContent.includes("扩展"),
    effBadge ? effBadge.textContent : "无角标");

  hoverTarget = null;
  document.body.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 300, clientY: 300 }));
  await sleep(420);

  // ---------------- 输出 ----------------
  console.log(results.join("\n"));
  console.log("");
  console.log("通过 " + pass + " / " + (pass + fail));
  console.log(fail === 0 ? "\n全部通过 ✓" : "\n存在失败项 ✗");
  process.exit(fail === 0 ? 0 : 1);
})();
