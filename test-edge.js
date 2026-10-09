/**
 * 边界场景与消息契约校验（开发自测，无依赖）。
 *
 * 覆盖改造后（v1.2.0 词库归后台）容易被忽略、但线上真会遇到的路径：
 *   1. 内容脚本侧：超时兜底、lastError 处理、扩展上下文失效的 try/catch、
 *      异步响应竞态（reqSeq）、未 await 的 rejection 是否被吞掉
 *   2. 后台消息契约：HT_LOOKUP / HT_DICT_INFO 必须**同步**响应、
 *      HT_TRANSLATE 必须返回 true（异步通道）、未知类型不得返回 true（悬挂回调）
 *   3. 词库缺失（importScripts 目标不存在）时后台仍能加载并优雅降级
 *   4. popup 在后台未就绪时的降级显示
 *
 * 运行：node test-edge.js
 */
const fs = require("fs"), path = require("path"), vm = require("vm");
const DIR = __dirname;
let pass = 0, fail = 0;
const t = (n, c, x) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (x ? " → " + x : "")); } };

console.log("=".repeat(58));
console.log("边界场景与消息契约校验");
console.log("=".repeat(58));

// --- 1. 后台懒加载：sendMessage 在 worker 未就绪时的降级 ---
const contentSrc = fs.readFileSync(path.join(DIR, "content.js"), "utf8");
t("content.js 有 LOCAL_LOOKUP_TIMEOUT 超时兜底", /LOCAL_LOOKUP_TIMEOUT\s*=\s*\d+/.test(contentSrc));
t("content.js requestLocal 对 lastError 有处理", /chrome\.runtime\.lastError/.test(contentSrc));
t("content.js requestLocal 有 try/catch（扩展失效场景）",
  /function\s+requestLocal[\s\S]{0,1500}catch\s*\(/.test(contentSrc));
t("content.js translateWord 已改为 async", /async\s+function\s+translateWord/.test(contentSrc));
t("content.js 用 reqSeq 丢弃过期异步响应",
  /seq\s*!==\s*state\.reqSeq/.test(contentSrc));
t("content.js attemptTranslate 吞掉 translateWord 的 rejection",
  /translateWord\(hit\.word\)\.catch/.test(contentSrc));

// --- 2. 后台消息契约 ---
const bgSrc = fs.readFileSync(path.join(DIR, "background.js"), "utf8");
const dictLookupSrc = fs.readFileSync(path.join(DIR, "dict-lookup.js"), "utf8");
const sandbox = { console, setTimeout, clearTimeout, Promise, Map, Set, Object, Array, String, Number, Error, JSON };
vm.createContext(sandbox);
let handler = null;
sandbox.importScripts = function () {
  Array.prototype.slice.call(arguments).forEach(n =>
    vm.runInContext(fs.readFileSync(path.join(DIR, n), "utf8"), sandbox, { filename: n }));
};
sandbox.chrome = {
  runtime: { lastError: null, onMessage: { addListener(f) { handler = f; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
  contextMenus: { removeAll(cb) { cb && cb(); }, create() {}, onClicked: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
  tabs: { query(q, cb) { cb && cb([]); }, sendMessage(i, m, cb) { cb && cb(); } },
  storage: { sync: { get(d, cb) { cb && cb(d); }, set(p, cb) { cb && cb(); } } },
};
sandbox.fetch = () => Promise.reject(new Error("offline"));
sandbox.AbortController = function () { this.signal = {}; this.abort = function () {}; };
vm.runInContext(bgSrc, sandbox, { filename: "background.js" });

// 同步调用封装：模拟 chrome.runtime.sendMessage 的同步响应路径
function sendSync(msg) {
  let out;
  handler(msg, {}, r => { out = r; });
  return out;
}

t("HT_LOOKUP 不返回 true（同步响应，避免无谓的异步通道）",
  handler({ type: "HT_LOOKUP", word: "efficiency" }, {}, () => {}) !== true);
t("HT_LOOKUP 返回渲染就绪结构", (() => {
  const r = sendSync({ type: "HT_LOOKUP", word: "efficiency" });
  return r && r.ok && r.found && r.result && r.result.source === "local" && Array.isArray(r.result.groups);
})());
t("HT_DICT_INFO 同步返回", (() => {
  const r = sendSync({ type: "HT_DICT_INFO" });
  return r && r.ok === true && r.total === 30940;
})());
t("HT_TRANSLATE 仍返回 true（异步响应契约保持）",
  handler({ type: "HT_TRANSLATE", word: "test" }, {}, () => {}) === true);
t("未知类型不返回 true（避免悬挂回调）",
  handler({ type: "HT_UNKNOWN_XYZ" }, {}, () => {}) !== true);
t("无 type 字段不抛错",
  (() => { try { handler({}, {}, () => {}); return true; } catch (e) { return false; } })());

// --- 3. 词库缺失时的降级（无 dict.js）---
const sb2 = { console, setTimeout, clearTimeout, Promise, Map, Set, Object, Array, String, Number, Error, JSON };
vm.createContext(sb2);
let h2 = null;
sb2.importScripts = function () { /* 全部缺失 */ };
sb2.chrome = {
  runtime: { lastError: null, onMessage: { addListener(f) { h2 = f; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
  contextMenus: { removeAll(cb) { cb && cb(); }, create() {}, onClicked: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
  tabs: { query(q, cb) { cb && cb([]); }, sendMessage(i, m, cb) { cb && cb(); } },
  storage: { sync: { get(d, cb) { cb && cb(d); }, set(p, cb) { cb && cb(); } } },
};
sb2.fetch = () => Promise.reject(new Error("offline"));
sb2.AbortController = function () { this.signal = {}; this.abort = function () {}; };
let loaded2 = true;
try { vm.runInContext(bgSrc, sb2, { filename: "bg-nodict.js" }); } catch (e) { loaded2 = false; }
t("词库全部缺失时 background.js 仍能加载（不崩溃）", loaded2);
if (loaded2 && h2) {
  let r2;
  h2({ type: "HT_LOOKUP", word: "efficiency" }, {}, r => { r2 = r; });
  t("词库缺失时查词优雅降级为 found:false", r2 && r2.found === false && r2.reason === "dict-unavailable");
  let r3;
  h2({ type: "HT_DICT_INFO" }, {}, r => { r3 = r; });
  t("词库缺失时 HT_DICT_INFO 报告 ok:false", r3 && r3.ok === false);
}

// --- 4. popup 契约 ---
const popupJs = fs.readFileSync(path.join(DIR, "popup.js"), "utf8");
t("popup.js 对 HT_DICT_INFO 失败有降级显示", /未加载/.test(popupJs));
t("popup.js 用 try/catch 包裹 sendMessage", /try\s*\{[\s\S]{0,400}HT_DICT_INFO/.test(popupJs));

// --- 5. 在线失败重试与通道冷却（v1.2.1）---
// 场景：国内网络下在线通道经常在 700ms 边缘抖动，之前一次失败就报
// 「翻译服务暂时不可用」，再悬停又正常。现在内容脚本失败后静默重试一次
// （后台放宽超时），后台另带通道冷却，避免陪不可达通道反复耗到超时。
t("content.js 失败后静默重试一次（requestOnline 递归 + isRetry 标记）",
  /function\s+requestOnline\s*\([^)]*isRetry[\s\S]{0,1200}requestOnline\(rawWord,\s*seq,\s*true\)/.test(contentSrc));
t("重试请求带 extended 标记（让后台放宽超时预算）",
  /extended:\s*isRetry\s*===\s*true/.test(contentSrc));
t("重试期间显示「重试中」加载态而非报错", /重试中/.test(contentSrc));
t("background 支持 extended 超时预算（RETRY_CHANNEL_TIMEOUT / RETRY_TOTAL_TIMEOUT）",
  /RETRY_CHANNEL_TIMEOUT\s*=\s*\d+[\s\S]*?RETRY_TOTAL_TIMEOUT\s*=\s*\d+/.test(bgSrc));
t("HT_TRANSLATE 透传 extended 标记", /extended:\s*msg\.extended\s*===\s*true/.test(bgSrc));
t("background 有通道健康记忆（连续失败进入冷却）",
  /channelHealth[\s\S]*cooldownUntil/.test(bgSrc) && /CHANNEL_COOLDOWN_MS\s*=\s*\d+/.test(bgSrc));
t("通道成功时重置健康计数", /function\s+noteChannelSuccess[\s\S]{0,200}fails:\s*0/.test(bgSrc));
t("词典拆词支持连字符合成词（lookupCompound）", /function\s+lookupCompound/.test(dictLookupSrc));
t("拆词失败（任一段未命中）不硬凑、维持在线兜底", /if\s*\(!h\)\s*return\s*null;\s*\/\/ 任一段未命中/.test(dictLookupSrc));

console.log("\n通过 " + pass + " / " + (pass + fail));
process.exit(fail === 0 ? 0 : 1);
