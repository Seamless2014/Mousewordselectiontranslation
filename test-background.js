/**
 * 后台 Service Worker 查词测试（开发自测，无依赖）。
 *
 * 目的：v1.2.0 把词库搬到后台后，"装配"从 manifest 挪到了 importScripts，
 * 成了新的易错点。本脚本在 Node 里模拟 worker 环境（提供 importScripts /
 * chrome.runtime.onMessage / chrome.contextMenus 等），真实执行 background.js，
 * 然后像内容脚本那样发消息查词，端到端验证：
 *
 *   1. importScripts 三个文件后 LOCAL_DICT / DICT_EXTRA / lookupLocal 均可用
 *   2. HT_LOOKUP 能正确返回精选词条、扩展词条、词形还原结果
 *   3. HT_DICT_INFO 返回的词条数与词库文件实际条目数一致
 *   4. 查不到的词返回 found:false（交由内容脚本走在线兜底）
 *   5. 空词 / 异常输入不崩溃
 *   6. 词库缺失时优雅降级（不抛错，返回 found:false）
 *
 * 运行：node test-background.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const DIR = __dirname;

let pass = 0, fail = 0;
const log = [];
function check(name, cond, extra) {
  if (cond) { pass++; log.push("  ✓ " + name); }
  else { fail++; log.push("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

console.log("=".repeat(58));
console.log("后台 Service Worker 查词测试");
console.log("=".repeat(58));

/**
 * 构造一个尽量贴近真实 MV3 worker 的运行环境并执行 background.js。
 *
 * @param {object} opts
 * @param {boolean} opts.withDict 是否真的提供词库文件（false 用于测降级）
 */
function createWorker(opts) {
  const o = opts || {};
  const runtime = {};
  let messageHandler = null;   // 记录 onMessage 注册的监听器
  let installedHandler = null;
  let ctx = null;              // vm 上下文，供 importScripts 注入脚本

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Map, Set, Object, Array, String, Number, Error, JSON,
  };

  // ---- importScripts：真实执行词库与查词模块，注入到同一 sandbox 全局 ----
  const importCalls = [];
  sandbox.importScripts = function () {
    const names = Array.prototype.slice.call(arguments);
    names.forEach(n => {
      importCalls.push(n);
      if (!o.withDict && (n === "dict.js" || n === "dict-extra.js" || n === "dict-phrase.js")) {
        return; // 模拟词库文件缺失
      }
      const p = path.join(DIR, n);
      if (!fs.existsSync(p)) throw new Error("importScripts 目标不存在: " + n);
      const src = fs.readFileSync(p, "utf8");
      // 在同一个上下文中执行：顶层 var 会成为该上下文的全局属性，
      // 与真实 worker 里 importScripts 的语义一致。
      vm.runInContext(src, ctx, { filename: n });
    });
  };

  // ---- chrome API 桩 ----
  sandbox.chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(fn) { messageHandler = fn; }
      },
      onInstalled: { addListener(fn) { installedHandler = fn; } },
      onStartup: { addListener() {} },
    },
    contextMenus: {
      removeAll(cb) { cb && cb(); },
      create() {},
      onClicked: { addListener() {} },
    },
    commands: { onCommand: { addListener() {} } },
    tabs: {
      query(_q, cb) { cb && cb([]); },
      sendMessage(_id, _msg, cb) { cb && cb(); },
    },
    storage: {
      sync: {
        get(defaults, cb) { cb && cb(defaults); },
        set(_p, cb) { cb && cb(); },
      },
    },
  };

  // fetch 桩：让在线通道可用（但本测试基本只走离线路径）
  sandbox.fetch = function () {
    return Promise.reject(new Error("offline test"));
  };
  sandbox.AbortController = function () {
    this.signal = {};
    this.abort = function () {};
  };

  // 创建上下文（必须先建好，importScripts 执行时需要向其中注入脚本）
  ctx = vm.createContext(sandbox);

  // background.js 里写的是 importScripts(...)，Node 环境没有这个全局函数。
  // 这里把它整体改名为 sandboxImportScripts（同一个函数对象），
  // 这样 background.js 源码不用改，也能在我们的桩上运行。
  sandbox.sandboxImportScripts = sandbox.importScripts;
  const bgSrc = fs
    .readFileSync(path.join(DIR, "background.js"), "utf8")
    .replace(/^importScripts\(/m, "sandboxImportScripts(");
  vm.runInContext(bgSrc, ctx, { filename: "background.js" });

  return {
    sandbox,
    importCalls,
    hasMessageHandler: () => typeof messageHandler === "function",
    hasInstalledHandler: () => typeof installedHandler === "function",
    /** 像内容脚本那样发消息并拿响应（同步响应场景） */
    send(msg) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("消息超时未响应: " + msg.type)), 2000);
        let done = false;
        const ret = messageHandler(msg, { id: "test" }, resp => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(resp);
        });
        // 监听器返回 true 表示异步响应；本测试的 HT_LOOKUP / HT_DICT_INFO 应返回假值
        if (ret !== true) {
          // 已同步响应，若上面回调还没触发说明监听器没调 sendResponse
          if (!done) {
            clearTimeout(timer);
            reject(new Error("监听器未调用 sendResponse（返回 " + JSON.stringify(ret) + "）"));
          }
        }
      });
    },
  };
}

// ---------- 载入真实词库条目数，用于交叉校验 ----------
function countDict(file, varName) {
  const src = fs.readFileSync(path.join(DIR, file), "utf8");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: file });
  return Object.keys(sandbox[varName] || {}).length;
}
const realCore = countDict("dict.js", "LOCAL_DICT");
const realExtra = countDict("dict-extra.js", "DICT_EXTRA");
const realPhrase = countDict("dict-phrase.js", "DICT_PHRASE");
console.log("词库文件实际条目：精选 " + realCore + " 条，扩展 " + realExtra +
  " 条，词组 " + realPhrase + " 条\n");

// ---------- 主流程 ----------
(async function run() {
  const w = createWorker({ withDict: true });

  // ---- 装配校验 ----
  check("importScripts 调用了 4 个文件", w.importCalls.length === 4, JSON.stringify(w.importCalls));
  check("importScripts 顺序正确（dict -> dict-extra -> dict-phrase -> dict-lookup）",
    w.importCalls.join(",") === "dict.js,dict-extra.js,dict-phrase.js,dict-lookup.js",
    JSON.stringify(w.importCalls));
  check("worker 全局可见 LOCAL_DICT",
    w.sandbox.LOCAL_DICT && Object.keys(w.sandbox.LOCAL_DICT).length === realCore,
    "实际 " + (w.sandbox.LOCAL_DICT ? Object.keys(w.sandbox.LOCAL_DICT).length : "undefined"));
  check("worker 全局可见 DICT_EXTRA",
    w.sandbox.DICT_EXTRA && Object.keys(w.sandbox.DICT_EXTRA).length === realExtra,
    "实际 " + (w.sandbox.DICT_EXTRA ? Object.keys(w.sandbox.DICT_EXTRA).length : "undefined"));
  check("worker 全局可见 DICT_PHRASE",
    w.sandbox.DICT_PHRASE && Object.keys(w.sandbox.DICT_PHRASE).length === realPhrase,
    "实际 " + (w.sandbox.DICT_PHRASE ? Object.keys(w.sandbox.DICT_PHRASE).length : "undefined"));
  check("worker 全局可见 lookupLocal 函数", typeof w.sandbox.lookupLocal === "function");
  check("worker 全局可见 buildLocalResult 函数", typeof w.sandbox.buildLocalResult === "function");
  check("已注册 onMessage 监听器", w.hasMessageHandler());
  check("已注册 onInstalled 监听器", w.hasInstalledHandler());

  // ---- HT_DICT_INFO ----
  const info = await w.send({ type: "HT_DICT_INFO" });
  check("HT_DICT_INFO 返回成功", info && info.ok === true, JSON.stringify(info));
  check("HT_DICT_INFO 词条数与文件一致",
    info && info.core === realCore && info.extra === realExtra && info.phrase === realPhrase,
    info ? `core ${info.core}/${realCore}，extra ${info.extra}/${realExtra}，phrase ${info.phrase}/${realPhrase}` : "无响应");
  check("HT_DICT_INFO 返回合计与版本",
    info && info.total === realCore + realExtra + realPhrase &&
    info.words === realCore + realExtra && typeof info.version === "string",
    info ? "total " + info.total + "，version " + info.version : "无响应");

  // ---- HT_LOOKUP：精选词库 ----
  const core = await w.send({ type: "HT_LOOKUP", word: "efficiency" });
  check("查 efficiency 命中精选词库", core && core.ok && core.found, JSON.stringify(core));
  check("efficiency 结果结构完整（可直接渲染）",
    core && core.result && core.result.tier === "core" &&
    core.result.source === "local" && Array.isArray(core.result.groups) &&
    core.result.groups.length > 0,
    core && core.result ? JSON.stringify(core.result).slice(0, 120) : "无");
  check("efficiency 释义含「效率」",
    core && core.result && /效率/.test(core.result.plain || ""),
    core && core.result ? core.result.plain : "无");
  check("efficiency 带词性 n.",
    core && core.result && core.result.groups.some(g => g.pos === "n."),
    core && core.result ? JSON.stringify(core.result.groups) : "无");

  // ---- HT_LOOKUP：扩展词库（含音标）----
  const extra = await w.send({ type: "HT_LOOKUP", word: "procurement" });
  check("查 procurement 命中扩展词库", extra && extra.found, JSON.stringify(extra));
  check("procurement 标记 tier=extra", extra && extra.result && extra.result.tier === "extra");
  check("procurement 带音标（扩展库 k 字段）",
    extra && extra.result && !!extra.result.phonetic && extra.result.phonetic.length > 0,
    extra && extra.result ? JSON.stringify(extra.result.phonetic) : "无");

  // ---- HT_LOOKUP：词形还原 ----
  const infl = await w.send({ type: "HT_LOOKUP", word: "depreciating" });
  check("查 depreciating 经词形还原命中", infl && infl.found, JSON.stringify(infl));
  check("depreciating 返回 inflected=true 且原形为 depreciate",
    infl && infl.result && infl.result.inflected === true && infl.result.matched === "depreciate",
    infl && infl.result ? "matched=" + infl.result.matched + " inflected=" + infl.result.inflected : "无");

  const plural = await w.send({ type: "HT_LOOKUP", word: "Implementations" });
  check("查 Implementations（大写复数）还原到 implementation",
    plural && plural.found && plural.result.matched === "implementation",
    plural && plural.result ? "matched=" + plural.result.matched : "无");

  // ---- 精选优先于扩展（同键时不该被扩展覆盖）----
  const coreTier = await w.send({ type: "HT_LOOKUP", word: "efficiency" });
  check("精选词条不会被扩展库覆盖（tier 仍为 core）",
    coreTier && coreTier.result && coreTier.result.tier === "core");

  // ---- HT_LOOKUP：词组查询（v1.3.0）----
  console.log("\n[词组] 多词查询链路（分层优先）");

  // 单词未收录 → 词组命中
  // 注意：必须选「首词不在单词词库里」的词组，否则单词优先会先命中单词，
  // 词组分支根本走不到（abide by 就是反例：abide 本身在扩展词库里）。
  const ph = await w.send({ type: "HT_LOOKUP", word: "insofar", phrases: ["insofar as"] });
  check("单词未收录时回退词组命中", ph && ph.ok && ph.found, JSON.stringify(ph).slice(0, 140));
  check("词组结果标记 tier=phrase",
    ph && ph.result && ph.result.tier === "phrase",
    ph && ph.result ? ph.result.tier : "无");
  check("词组 matched 为完整词组",
    ph && ph.result && ph.result.matched === "insofar as",
    ph && ph.result ? ph.result.matched : "无");
  check("词组释义含中文", ph && ph.result && /范围|限度|在/.test(ph.result.plain || ""),
    ph && ph.result ? ph.result.plain : "无");

  // ---- 分层优先：core 单词胜出 ----
  // environment 是精选词条（core），即使词组也命中，仍应返回单词
  const coreWins = await w.send({
    type: "HT_LOOKUP", word: "environment", phrases: ["environment protection"]
  });
  check("core 单词优先（精选词条不被词组抢走）",
    coreWins && coreWins.result && coreWins.result.tier === "core" &&
    coreWins.result.matched === "environment",
    coreWins && coreWins.result ? coreWins.result.tier + "/" + coreWins.result.matched : "无");

  // the 是 core 虚词 → 返回 the 而非 out of the blue
  const theCore = await w.send({
    type: "HT_LOOKUP", word: "the", phrases: ["of the blue", "out of the blue"]
  });
  check("core 虚词 the 优先于长词组 out of the blue",
    theCore && theCore.result && theCore.result.tier === "core" &&
    theCore.result.matched === "the",
    theCore && theCore.result ? theCore.result.tier + "/" + theCore.result.matched : "无");

  // ---- 分层优先：extra 单词让位词组 ----
  // pool 只在扩展词库（extra），swimming pool 是词组 → 词组应胜出
  const poolPhrase = await w.send({
    type: "HT_LOOKUP", word: "pool", phrases: ["swimming pool"]
  });
  check("extra 单词让位词组（pool → swimming pool）",
    poolPhrase && poolPhrase.result && poolPhrase.result.tier === "phrase",
    poolPhrase && poolPhrase.result ? poolPhrase.result.tier + "/" + poolPhrase.result.matched : "无");
  check("让位后释义为「游泳池」",
    poolPhrase && poolPhrase.result && /游泳池/.test(poolPhrase.result.plain || ""),
    poolPhrase && poolPhrase.result ? poolPhrase.result.plain : "无");

  // extra 单词但词组未命中 → 回落到该单词
  const extraFallback = await w.send({
    type: "HT_LOOKUP", word: "pool", phrases: ["pool zzzzq"]
  });
  check("extra 单词在词组未命中时回落返回单词",
    extraFallback && extraFallback.result && extraFallback.result.tier === "extra" &&
    extraFallback.result.matched === "pool",
    extraFallback && extraFallback.result ? extraFallback.result.tier + "/" + extraFallback.result.matched : "无");

  // 候选按「由短到长」试，短的先命中即止
  const shortest = await w.send({
    type: "HT_LOOKUP", word: "zzzzq", phrases: ["insofar as", "insofar as zzzzq"]
  });
  check("候选按由短到长命中（短的优先）",
    shortest && shortest.result && shortest.result.matched === "insofar as",
    shortest && shortest.result ? shortest.result.matched : "无");

  // 无 phrases 字段时行为与旧版一致（向后兼容）
  const noPhrase = await w.send({ type: "HT_LOOKUP", word: "efficiency" });
  check("缺 phrases 字段时仍正常查单词（向后兼容）",
    noPhrase && noPhrase.found && noPhrase.result.tier === "core");

  // 单词与词组都未收录
  const bothMiss = await w.send({ type: "HT_LOOKUP", word: "zzzzqqq", phrases: ["zzzz qqq"] });
  check("单词与词组都未收录时返回 found:false",
    bothMiss && bothMiss.ok === true && bothMiss.found === false, JSON.stringify(bothMiss));

  // 词组含首部冠词冗余 → lookupPhrase 去掉冠词重试
  const stripArt = await w.send({ type: "HT_LOOKUP", word: "zzzzqqq", phrases: ["the insofar as"] });
  check("词组含冗余首冠词时仍能命中（去冠词重试）",
    stripArt && stripArt.result && stripArt.result.tier === "phrase",
    stripArt && stripArt.result ? stripArt.result.matched : "未命中");

  // 空白/全角空格规范化
  const messy = await w.send({ type: "HT_LOOKUP", word: "zzzzqqq", phrases: ["  insofar\u00a0\u00a0 as  "] });
  check("词组空白/不换行空格被规范化后命中",
    messy && messy.result && messy.result.tier === "phrase",
    messy && messy.result ? messy.result.matched : "未命中");

  // 词组含标点 → 形状校验失败，不误命中
  const punct = await w.send({ type: "HT_LOOKUP", word: "zzzzqqq", phrases: ["insofar as, and"] });
  check("词组含标点时判为未命中（不硬凑）",
    punct && punct.found === false, JSON.stringify(punct));

  // 单段候选（不含空格）不应被当成词组
  const single = await w.send({ type: "HT_LOOKUP", word: "zzzzqqq", phrases: ["insofar"] });
  check("候选不含空格时不走词组分支",
    single && single.found === false, JSON.stringify(single));

  // phrases 非数组时不抛错
  const badPhrases = await w.send({ type: "HT_LOOKUP", word: "efficiency", phrases: "not-an-array" });
  check("phrases 非数组时忽略并正常返回单词",
    badPhrases && badPhrases.found && badPhrases.result.tier === "core",
    JSON.stringify(badPhrases).slice(0, 120));

  // 未收录词 ----
  const miss = await w.send({ type: "HT_LOOKUP", word: "zzzzqqq" });
  check("未收录词返回 ok:true + found:false（交由在线兜底）",
    miss && miss.ok === true && miss.found === false, JSON.stringify(miss));

  // ---- 边界输入 ----
  const empty = await w.send({ type: "HT_LOOKUP", word: "" });
  check("空词返回未命中且不崩溃", empty && empty.found === false, JSON.stringify(empty));
  const undef = await w.send({ type: "HT_LOOKUP" });
  check("缺 word 字段返回未命中且不崩溃", undef && undef.found === false, JSON.stringify(undef));

  // ---- 原型链防护（在 worker 侧同样成立）----
  const proto = await w.send({ type: "HT_LOOKUP", word: "__proto__" });
  check("__proto__ 不误命中原型链", proto && proto.found === false, JSON.stringify(proto));
  const ctor = await w.send({ type: "HT_LOOKUP", word: "constructor" });
  check("constructor 命中词条对象而非 JS 内置构造器",
    !ctor || !ctor.found || (ctor.result && typeof ctor.result.plain === "string"),
    JSON.stringify(ctor && ctor.result ? ctor.result.plain : ctor));

  // ---- 未知消息类型不应抛错 ----
  let unknownOk = true;
  try {
    // 监听器对未知类型直接 return，不会调 sendResponse
    w.sandbox.chrome.runtime; // noop
  } catch (_) { unknownOk = false; }
  check("未知消息类型不会导致模块加载失败", unknownOk);

  // ---------- 降级场景：词库缺失 ----------
  console.log("\n[降级] 词库文件缺失时的行为");
  const w2 = createWorker({ withDict: false });
  const info2 = await w2.send({ type: "HT_DICT_INFO" });
  check("词库缺失时 HT_DICT_INFO 返回 ok:false", info2 && info2.ok === false, JSON.stringify(info2));
  const look2 = await w2.send({ type: "HT_LOOKUP", word: "efficiency" });
  check("词库缺失时 HT_LOOKUP 返回 found:false 而不抛错",
    look2 && look2.found === false, JSON.stringify(look2));
  check("词库缺失时标记 reason=dict-unavailable",
    look2 && look2.reason === "dict-unavailable", JSON.stringify(look2));

  console.log(log.join("\n"));
  console.log("\n通过 " + pass + " / " + (pass + fail));
  console.log(fail === 0 ? "\n全部通过 ✓" : "\n存在失败项 ✗");
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error("测试执行异常：", e && e.stack ? e.stack : e);
  process.exit(1);
});
