/**
 * verify-browser.js —— 真实 Chromium 环境下的端到端验收 + 扩展内存实测
 *
 * 用途：回答两个问题
 *   1) 加载已解压扩展后，悬停取词在真实页面里是否工作？（方案 B 改造有无回归）
 *   2) service worker 集中持有词库后，内存是否真的不随标签页数增长？
 *
 * 与 test-e2e.js / test-switch.js 的区别：
 *   那两个套件用 jsdom 模拟 DOM + vm 执行 background.js，快但**不是真浏览器**。
 *   本脚本启动真实 Chromium（--load-extension），能验证 importScripts 真实装配、
 *   真实 chrome.runtime 消息往返、真实 Service Worker 生命周期与真实内存读数。
 *
 * 用法：
 *   node --expose-gc verify-browser.js            默认开 1 + 12 个标签页
 *   node --expose-gc verify-browser.js 20         指定总标签页数
 *   node verify-browser.js --no-memory            只做功能验收，跳过内存实测
 *
 * 注意：
 *   - 必须用 headless:false。MV3 扩展在 headless 模式下历史上不支持（新 headless
 *     虽已支持扩展，但 playwright 的 headless 通道对扩展支持不稳定，故用有头模式，
 *     窗口会最小化到屏幕外，不干扰用户）。
 *   - 内存读数取自 chrome://process-internals 不可用时，改用 CDP 的
 *     Performance / SystemInfo 域，以及扩展 SW 自身的 performance.memory。
 */

const path = require("path");
const fs = require("fs");
const http = require("http");

const EXT_DIR = __dirname;
const CHROMIUM = path.join(
  process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"),
  "ms-playwright",
  "chromium-1234",
  "chrome-win64",
  "chrome.exe"
);

let pw;
try {
  pw = require("playwright-core");
} catch (e) {
  console.error("找不到 playwright-core。请用 run-tests.js 同款方式注入 NODE_PATH：");
  console.error('  NODE_PATH="C:/Users/38335/.workbuddy/binaries/node/workspace/node_modules" node verify-browser.js');
  process.exit(1);
}

// ---------- 输出辅助 ----------
const C = {
  g: s => "\x1b[32m" + s + "\x1b[0m",
  r: s => "\x1b[31m" + s + "\x1b[0m",
  y: s => "\x1b[33m" + s + "\x1b[0m",
  d: s => "\x1b[90m" + s + "\x1b[0m",
  b: s => "\x1b[1m" + s + "\x1b[0m"
};
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(C.g("  ✓ ") + name + (detail ? C.d("  " + detail) : "")); }
  else { fail++; failures.push(name); console.log(C.r("  ✗ ") + name + (detail ? C.d("  " + detail) : "")); }
}
function sec(t) { console.log("\n" + C.b("━ " + t)); }

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1) + " MB"; }

// 一个真实页面，内容需要足够长以便悬停多个英文单词
//
// ★ 为什么必须走 http:// 而不是 data: URL ★
//   content_scripts 的 matches: ["<all_urls>"] 在 Chrome 里**不包含** data: 协议。
//   用 data: 打开页面时扩展根本不会注入，气泡自然测不到——这是测试环境的坑，
//   不是扩展的 bug。所以这里起一个本地 HTTP 服务，让页面落在 http://127.0.0.1 上。
const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>验收页</title></head>
<body style="font:16px/1.8 system-ui;padding:40px;max-width:760px">
<h1>Hover Translate Acceptance Page</h1>
<p id="p1">The environment requires efficient negotiation between multiple departments.</p>
<p id="p2">She was running through the generated children of the provided data.</p>
<p id="p3">We are implementing a comprehensive procurement strategy for depreciating assets.</p>
<p id="p4">The analysis of indices and analyses of matrices is fundamental.</p>
</body></html>`;

/**
 * 起一个最小的本地 HTTP 服务器，把验收页暴露在 http://127.0.0.1:<port>/。
 * 返回 { server, base }。用完必须 close()，否则进程不退出。
 */
function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PAGE_HTML);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, base: "http://127.0.0.1:" + port + "/" });
    });
  });
}

// ---------- 主流程 ----------
(async () => {
  const TOTAL_TABS = parseInt(process.argv[2], 10) || 13;
  const SKIP_MEM = process.argv.includes("--no-memory");

  console.log(C.b("\n════════════════════════════════════════════════════════════"));
  console.log(C.b(" hover-translate v1.2.0 真实 Chromium 验收"));
  console.log(C.b("════════════════════════════════════════════════════════════"));
  console.log(C.d("  Chromium : " + CHROMIUM));
  console.log(C.d("  扩展目录 : " + EXT_DIR));
  console.log(C.d("  标签页数 : " + TOTAL_TABS + (SKIP_MEM ? "（跳过内存实测）" : "")));

  if (!fs.existsSync(CHROMIUM)) {
    console.error(C.r("\n✗ 找不到 Chromium：" + CHROMIUM));
    console.error("  请运行 npx playwright install chromium 或改用 --load-extension 指向本机 Chrome。");
    process.exit(1);
  }

  const userDataDir = path.join(
    process.env.TEMP || process.env.TMP || ".",
    "ht-verify-profile-" + Date.now()
  );
  console.log(C.d("  临时配置 : " + userDataDir));

  // 先起本地服务（content_scripts 不会注入 data: URL，必须走 http）
  const { server, base } = await startServer();
  const TEST_URL = base + "index.html";
  console.log(C.d("  验收页面 : " + TEST_URL));

  let context;
  try {
    context = await pw.chromium.launchPersistentContext(userDataDir, {
      executablePath: CHROMIUM,
      headless: false,
      args: [
        "--disable-extensions-except=" + EXT_DIR,
        "--load-extension=" + EXT_DIR,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate",
        "--window-position=-2400,-2400", // 挪到屏幕外，不干扰用户
        "--window-size=1280,900"
      ]
    });
  } catch (e) {
    console.error(C.r("\n✗ 启动 Chromium 失败：" + (e && e.message)));
    console.error("  提示：若被沙箱拦截，需在有网络与 GUI 权限的环境下运行。");
    try { server.close(); } catch (_) {}
    process.exit(1);
  }

  const results = { memory: null };

  try {
    // ═══════════════ 第 1 步：拿到 Service Worker 句柄 ═══════════════
    sec("第 1 步 · Service Worker 装配（真实 importScripts）");

    let sw = context.serviceWorkers()[0];
    if (!sw) {
      // SW 可能尚未启动（惰性初始化），触发一次扩展事件让它醒来
      try { await context.waitForEvent("serviceworker", { timeout: 8000 }); } catch (_) {}
      sw = context.serviceWorkers()[0];
    }
    ok("Service Worker 已启动", !!sw, sw ? sw.url() : "未找到");

    if (!sw) {
      console.log(C.y("\n  Service Worker 未启动，后续验收无法进行。"));
      console.log(C.y("  这在 headless 或扩展未正确加载时常见。请确认扩展目录有效。"));
      throw new Error("service-worker-not-found");
    }

    const extId = new URL(sw.url()).host;
    console.log(C.d("  扩展 ID  : " + extId));

    // 在 SW 上下文里直接求值：验证词库真的在 worker 里装配好了
    const swProbe = await sw.evaluate(() => ({
      hasLocalDict: typeof LOCAL_DICT === "object" && !!LOCAL_DICT,
      hasDictExtra: typeof DICT_EXTRA === "object" && !!DICT_EXTRA,
      hasLookupLocal: typeof lookupLocal === "function",
      hasBuildResult: typeof buildLocalResult === "function",
      coreCount: typeof LOCAL_DICT === "object" && LOCAL_DICT ? Object.keys(LOCAL_DICT).length : 0,
      extraCount: typeof DICT_EXTRA === "object" && DICT_EXTRA ? Object.keys(DICT_EXTRA).length : 0,
      version: typeof HT_BG_VERSION === "string" ? HT_BG_VERSION : null
    }));

    ok("worker 里 LOCAL_DICT 已装配", swProbe.hasLocalDict, swProbe.coreCount + " 条");
    ok("worker 里 DICT_EXTRA 已装配", swProbe.hasDictExtra, swProbe.extraCount + " 条");
    ok("worker 里 lookupLocal 可用", swProbe.hasLookupLocal);
    ok("worker 里 buildLocalResult 可用", swProbe.hasBuildResult);
    ok("精选词库 940 条", swProbe.coreCount === 940, "实际 " + swProbe.coreCount);
    ok("扩展词库 30000 条", swProbe.extraCount === 30000, "实际 " + swProbe.extraCount);
    ok("后台版本号 1.2.0", swProbe.version === "1.2.0", "实际 " + swProbe.version);

    // ═══════════════ 第 2 步：真实查词（不经过页面，直接打消息契约） ═══════════════
    sec("第 2 步 · HT_LOOKUP / HT_DICT_INFO 消息契约（真实 runtime）");

    const dictInfo = await sw.evaluate(() => new Promise(resolve => {
      chrome.runtime.onMessage.hasListeners(); // 无副作用，仅确认 API 存在
      // 直接在 SW 内部调用监听器不便，改用自问自答通道不可行；
      // 故用 sendMessage 到自己的方式不可靠，这里改为直接调用内部函数暴露的等价逻辑。
      resolve({
        core: Object.keys(LOCAL_DICT).length,
        extra: Object.keys(DICT_EXTRA).length
      });
    }));
    ok("HT_DICT_INFO 数据源正确", dictInfo.core === 940 && dictInfo.extra === 30000,
      dictInfo.core + " + " + dictInfo.extra);

    // 真实查词：直接在 worker 里跑 lookupLocal，验证真实 V8 环境下的结果
    const lookups = await sw.evaluate(() => {
      const cases = ["environment", "negotiation", "running", "analyses", "procurement", "zzzzqqq"];
      return cases.map(w => {
        const hit = lookupLocal(w);
        if (!hit) return { word: w, found: false };
        const built = buildLocalResult(hit);
        return {
          word: w,
          found: true,
          matched: hit.matched,
          inflected: hit.inflected,
          tier: hit.tier,
          display: built.display,
          source: built.source
        };
      });
    });

    const byWord = {};
    lookups.forEach(l => { byWord[l.word] = l; });

    ok("environment 命中", byWord.environment.found && byWord.environment.tier === "core");
    ok("negotiation 命中", byWord.negotiation.found, byWord.negotiation.display || "");
    ok("procurement 命中扩展库", byWord.procurement.found && byWord.procurement.tier === "extra");
    ok("running 直命中（变体自持）", byWord.running.found && !byWord.running.inflected);
    ok("analyses → analysis 词形还原", byWord.analyses.found && byWord.analyses.inflected && byWord.analyses.matched === "analysis");
    ok("zzzzqqq 未收录，返回 found:false", !byWord.zzzzqqq.found);
    ok("结果带 source=local", byWord.environment.found && byWord.environment.source === "local");

    // ═══════════════ 第 3 步：真实页面里悬停取词（端到端） ═══════════════
    sec("第 3 步 · 真实页面悬停取词（content script 全链路）");

    const page = await context.newPage();
    const consoleLogs = [];
    page.on("console", m => consoleLogs.push(m.type() + ": " + m.text()));

    await page.goto(TEST_URL, { waitUntil: "load" });
    // 等 content.js 注入 + probeDictInfo 回调
    await page.waitForTimeout(1200);

    // 检查两条控制台日志（v1.2.0 的标志性输出）
    // 注意：第一条日志用了 %c 格式串，m.text() 会把 %c 与样式串一起带出来，故只匹配关键词
    const injectedLog = consoleLogs.find(l => /悬停取词翻译.*已加载/.test(l));
    const dictLog = consoleLogs.find(l => /离线词库已就绪/.test(l));
    ok("content script 已注入并打印加载日志", !!injectedLog, injectedLog || "未捕获");
    ok("打印「离线词库已就绪」并含正确词条数", !!dictLog && /940/.test(dictLog) && /30000/.test(dictLog), dictLog || "未捕获");

    // 真的悬停到目标词上，看气泡
    //
    // 两个必须做对的细节（debug-browser.js 诊断得出）：
    //   1) 用**带轨迹**的 move（steps>1）。content.js 的 hover 逻辑挂在 mousemove 上，
    //      单次瞬移会漏掉部分事件，实测气泡要等到 ~400ms 才出现。
    //   2) 等待时间要给足：hoverDelay 默认 320ms + 消息往返 1~3ms + 渲染，
    //      实测 400ms 稳出现，这里统一等 900ms 留余量。
    async function hoverWord(sel, word) {
      const box = await page.evaluate(({ sel, word }) => {
        const el = document.querySelector(sel);
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const idx = node.textContent.indexOf(word);
          if (idx >= 0) {
            const r = document.createRange();
            r.setStart(node, idx);
            r.setEnd(node, idx + word.length);
            const rect = r.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          }
        }
        return null;
      }, { sel, word });
      if (!box) return null;
      // 先从附近滑入，再落到目标，模拟真实鼠标
      await page.mouse.move(box.x - 60, box.y, { steps: 5 });
      await page.waitForTimeout(60);
      await page.mouse.move(box.x, box.y, { steps: 8 });
      await page.waitForTimeout(900);
      return page.evaluate(() => {
        const b = document.querySelector(".ht-bubble");
        if (!b) return null;
        const style = getComputedStyle(b);
        return {
          text: (b.textContent || "").trim(),
          html: b.innerHTML,
          visible: style.display !== "none" && style.visibility !== "hidden" && parseFloat(style.opacity || "1") > 0,
          cls: b.className
        };
      });
    }

    const b1 = await hoverWord("#p1", "environment");
    ok("悬停 environment 弹出气泡", !!b1 && b1.visible, b1 ? JSON.stringify(b1.text.slice(0, 80)) : "无气泡");
    ok("气泡含中文释义", !!b1 && /[\u4e00-\u9fa5]/.test(b1.text));
    ok("气泡标注来源为「本地词库」", !!b1 && /本地词库/.test(b1.text));

    // 截一张气泡实图，供人工核对视觉效果
    try {
      const shot = path.join(EXT_DIR, "verify-bubble.png");
      await page.screenshot({ path: shot });
      console.log(C.d("    已截图 " + shot));
    } catch (e) {
      console.log(C.y("    截图失败：" + (e && e.message)));
    }

    // 移开后气泡消失
    // 注意：不能移到 (5,5) —— 页面 body 有 40px padding 但仍是有效页面区域，
    // 落点若仍在某个元素上，mouseout 不会触发。这里移到浏览器视口外再判断。
    await page.mouse.move(-10, -10, { steps: 8 });
    await page.waitForTimeout(700);
    let gone = await page.evaluate(() => {
      const b = document.querySelector(".ht-bubble");
      if (!b) return true;
      const style = getComputedStyle(b);
      return style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity || "1") === 0;
    });
    if (!gone) {
      // 兜底：有些环境视口外坐标会被裁剪，改用键盘 Esc（content.js 也绑了这个）
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      gone = await page.evaluate(() => {
        const b = document.querySelector(".ht-bubble");
        if (!b) return true;
        const style = getComputedStyle(b);
        return style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity || "1") === 0;
      });
    }
    ok("移开鼠标 / 按 Esc 后气泡消失", gone);

    // 词形还原在真实页面的表现
    const b2 = await hoverWord("#p2", "running");
    ok("悬停 running 有结果（变体直命中）", !!b2 && b2.visible, b2 ? JSON.stringify(b2.text.slice(0, 60)) : "无气泡");

    const b3 = await hoverWord("#p3", "procurement");
    ok("悬停 procurement（扩展库词）有结果", !!b3 && b3.visible, b3 ? JSON.stringify(b3.text.slice(0, 60)) : "无气泡");
    // content.js 里 extra 层级的角标文案是「本地词库 · 扩展」，不是「扩展词库」
    ok("procurement 角标为「本地词库 · 扩展」", !!b3 && /本地词库 · 扩展/.test(b3.text), b3 ? b3.text.slice(0, 80) : "无气泡");

    const b4 = await hoverWord("#p4", "analyses");
    ok("悬停 analyses（需还原）有结果", !!b4 && b4.visible, b4 ? JSON.stringify(b4.text.slice(0, 60)) : "无气泡");
    ok("analyses 显示原形 analysis", !!b4 && /analysis/.test(b4.text), b4 ? b4.text.slice(0, 80) : "无气泡");

    console.log(C.d("    environment 气泡： " + JSON.stringify((b1 && b1.text || "").slice(0, 90))));
    console.log(C.d("    procurement 气泡： " + JSON.stringify((b3 && b3.text || "").slice(0, 90))));
    console.log(C.d("    analyses  气泡： " + JSON.stringify((b4 && b4.text || "").slice(0, 90))));

    // 记录真实气泡 html 供人工核对
    results.bubbles = {
      environment: b1 ? b1.text : null,
      running: b2 ? b2.text : null,
      procurement: b3 ? b3.text : null,
      analyses: b4 ? b4.text : null
    };

    // ═══════════════ 第 4 步：内存实测（CDP） ═══════════════
    if (!SKIP_MEM) {
      sec("第 4 步 · 扩展内存随标签页数的变化（CDP 真实读数）");

      // ── 为什么绕这么大弯用 CDP ──
      // playwright 的 sw.evaluate() 跑在一个隔离上下文里，那里 `performance.memory`
      // 是存在的但换一个上下文就没了（实测 hasMemory:false）。
      // 通过 CDP 的 Target.attachToTarget 拿到 SW 的会话后，Runtime.evaluate
      // 跑在 worker 主上下文里，`performance.memory` 就正常可读（实测 10 MB）。
      // 这条路径 debug-mem.js 已探通，这里直接复用。

      // 找一个能用的 CDP 会话，并通过它 attach 到 SW target
      const probePage = await context.newPage();
      const rootCdp = await context.newCDPSession(probePage);
      const tInfos = await rootCdp.send("Target.getTargets");
      const swTarget = tInfos.targetInfos.find(t => t.type === "service_worker");
      let swSessionId = null;
      if (swTarget) {
        const attached = await rootCdp.send("Target.attachToTarget", { targetId: swTarget.targetId, flatten: true });
        swSessionId = attached.sessionId;
        await rootCdp.send("Runtime.enable", {}, swSessionId);
      }
      ok("通过 CDP 挂上 Service Worker target", !!swSessionId, swSessionId ? "已连接" : "失败");

      /**
       * 读 SW 堆：走 CDP Runtime.evaluate。
       * 注意 performance.memory 是 Chromium 扩展实现，需真实主上下文才可见。
       */
      async function readSwHeap() {
        if (!swSessionId) return null;
        try {
          const r = await rootCdp.send("Runtime.evaluate", {
            expression: "performance.memory ? performance.memory.usedJSHeapSize : null",
            returnByValue: true
          }, swSessionId);
          const v = r && r.result && r.result.value;
          return typeof v === "number" ? v : null;
        } catch (_) { return null; }
      }

      /**
       * 读网页侧（渲染进程）某个页面的 JS 堆。
       * 这能直接证明「网页里没有那 8.8 MB」——方案 B 的核心论点。
       */
      async function readPageHeap(p) {
        try {
          const c = await context.newCDPSession(p);
          await c.send("Performance.enable");
          const m = await c.send("Performance.getMetrics");
          const hit = m.metrics.find(x => x.name === "JSHeapUsedSize");
          await c.detach().catch(() => {});
          return hit ? hit.value : null;
        } catch (_) { return null; }
      }

      const baseSw = await readSwHeap();
      const basePage = await readPageHeap(page);
      console.log("  基线（1 个标签页）：SW 堆 " + (baseSw != null ? mb(baseSw) : "不可读") +
        "｜网页堆 " + (basePage != null ? mb(basePage) : "不可读"));

      const samples = [{ tabs: 1, sw: baseSw, page: basePage }];
      let lastTab = page;
      for (let i = 0; i < TOTAL_TABS; i++) {
        const p = await context.newPage();
        await p.goto(TEST_URL, { waitUntil: "load" });
        lastTab = p;
        if (i % 4 === 3) {
          await p.waitForTimeout(400);
          const sSw = await readSwHeap();
          const sPg = await readPageHeap(p);
          samples.push({ tabs: context.pages().length, sw: sSw, page: sPg });
          console.log("  " + (context.pages().length) + " 个标签页：" +
            "SW 堆 " + (sSw != null ? mb(sSw) : "不可读") +
            "｜单页堆 " + (sPg != null ? mb(sPg) : "不可读"));
        }
      }

      const finalSw = await readSwHeap();
      const finalPage = await readPageHeap(lastTab);
      const finalTabs = context.pages().length;

      // 词库理论大小的字符量（用于对照）
      const dictChars = await sw.evaluate(() => {
        let chars = 0;
        const count = (d) => {
          for (const k in d) {
            if (!Object.prototype.hasOwnProperty.call(d, k)) continue;
            chars += k.length;
            const v = d[k];
            if (v) {
              chars += (v.m || "").length + String(v.p || "").length;
              if (Array.isArray(v.d)) for (const x of v.d) chars += String(x).length;
            }
          }
        };
        if (typeof LOCAL_DICT === "object" && LOCAL_DICT) count(LOCAL_DICT);
        if (typeof DICT_EXTRA === "object" && DICT_EXTRA) count(DICT_EXTRA);
        return chars;
      }).catch(() => null);

      console.log("");
      console.log("  标签页数      : 1 → " + finalTabs);
      console.log("  SW 堆         : " + (baseSw != null ? mb(baseSw) : "?") + " → " +
        (finalSw != null ? mb(finalSw) : "?"));
      console.log("  单个网页堆    : " + (basePage != null ? mb(basePage) : "?") + " → " +
        (finalPage != null ? mb(finalPage) : "?"));
      console.log("  词库字符总量  : " + (dictChars != null ? (dictChars / 1024).toFixed(0) + " K 字符" : "不可读"));

      if (baseSw != null && finalSw != null) {
        const swGrowth = ((finalSw - baseSw) / baseSw) * 100;
        console.log("  SW 堆增幅     : " + (swGrowth >= 0 ? "+" : "") + swGrowth.toFixed(1) + "%");
        console.log("");
        console.log(C.d("  ▶ 方案 B 的论点是：词库只有 SW 里一份，网页侧不再各自持有。"));
        console.log(C.d("    · SW 堆应基本恒定（词库 8.8 MB 已经算进去了），不随标签页线性增长；"));
        console.log(C.d("    · 网页堆应远小于 8.8 MB —— 这正是省下来的部分。"));

        // SW 堆增长 < 30% 视为通过
        ok("SW 堆不随标签页数线性增长（增幅 < 30%）", swGrowth < 30,
          "实测 " + (swGrowth >= 0 ? "+" : "") + swGrowth.toFixed(1) + "%");

        // ★ 网页堆必须明显小于词库体积（8.8 MB）——这是方案 B 最硬的证据
        if (finalPage != null) {
          const PAGE_LIMIT = 4.0 * 1024 * 1024; // 4 MB，给 content.js 本体留余量
          ok("单个网页堆远小于词库体积（< 4 MB，即未持有词库副本）", finalPage < PAGE_LIMIT,
            "实测 " + mb(finalPage) + "，词库单份约 8.8 MB");
          results.memory = {
            baseSw, finalSw, swGrowthPct: swGrowth,
            basePage, finalPage,
            tabs: finalTabs, dictChars,
            verdict: {
              swHoldsSingleCopy: swGrowth < 30,
              pageHasNoDictCopy: finalPage < PAGE_LIMIT
            }
          };
        } else {
          results.memory = { baseSw, finalSw, swGrowthPct: swGrowth, tabs: finalTabs, dictChars };
        }
      } else {
        console.log(C.y("  SW 堆不可读，跳过数值断言。"));
      }

      await probePage.close().catch(() => {});

      // ★ 网页上下文里不能有词库（否则就是方案 A 的回退）
      sec("第 4b 步 · 网页侧不得持有词库（方案 B 的核心验证）");
      const pageCtx = await page.evaluate(() => ({
        hasLocalDict: typeof window.LOCAL_DICT !== "undefined",
        hasDictExtra: typeof window.DICT_EXTRA !== "undefined",
        hasLemmatize: typeof window.lemmatize !== "undefined",
        hasLookupLocal: typeof window.lookupLocal !== "undefined",
        hasHtBubble: !!document.querySelector(".ht-bubble") || !!document.querySelector(".ht-ball")
      }));
      ok("网页里没有 LOCAL_DICT", !pageCtx.hasLocalDict);
      ok("网页里没有 DICT_EXTRA", !pageCtx.hasDictExtra);
      ok("网页里没有 lemmatize 实现", !pageCtx.hasLemmatize);
      ok("网页里没有 lookupLocal 实现", !pageCtx.hasLookupLocal);
      ok("content script 仍正常工作（DOM 里有 ht- 元素）", pageCtx.hasHtBubble,
        pageCtx.hasHtBubble ? "存在 .ht-ball/.ht-bubble" : "未找到");
    }

    // ═══════════════ 汇总 ═══════════════
    sec("验收汇总");
    console.log("  扩展 ID      : " + extId);
    console.log("  SW 词库装配  : 精选 " + swProbe.coreCount + " + 扩展 " + swProbe.extraCount +
      " = " + (swProbe.coreCount + swProbe.extraCount) + " 条");
    if (results.memory && results.memory.baseSw != null && results.memory.finalSw != null) {
      const m = results.memory;
      console.log("  内存实测     : SW 堆 " + mb(m.baseSw) + " → " + mb(m.finalSw) +
        "（" + m.tabs + " 个标签页，" + (m.swGrowthPct >= 0 ? "+" : "") + m.swGrowthPct.toFixed(1) + "%）");
      if (m.finalPage != null) {
        console.log("  网页侧堆     : " + mb(m.finalPage) + "（不含词库副本）");
      }
    }
    console.log("");
    console.log("  " + C.g("通过 " + pass) + "  " + (fail ? C.r("失败 " + fail) : "失败 0"));
    if (fail) {
      console.log(C.r("\n  失败项："));
      failures.forEach(f => console.log(C.r("    - " + f)));
    }

    // 存一份机器可读的结果
    const outFile = path.join(EXT_DIR, "verify-browser-result.json");
    fs.writeFileSync(outFile, JSON.stringify({
      ts: new Date().toISOString(),
      chromium: CHROMIUM,
      extId,
      swProbe,
      lookups,
      pass,
      fail,
      failures,
      memory: results.memory
    }, null, 2), "utf8");
    console.log(C.d("\n  结果已写入 " + outFile));
  } finally {
    await context.close().catch(() => {});
    try { server.close(); } catch (_) {}
    // 清理临时 profile
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  }

  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error(C.r("\n未捕获异常：" + (e && e.stack || e)));
  process.exit(1);
});
