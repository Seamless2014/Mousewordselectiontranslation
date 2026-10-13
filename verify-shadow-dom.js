/**
 * verify-shadow-dom.js —— Shadow DOM 取词兼容性真机验证
 *
 * 目的：回答一个「待真实验证」的问题——
 *   content.js 的取词靠 document.caretRangeFromPoint(x, y)，
 *   该 API 对 Shadow DOM（open / closed / 嵌套）的穿透行为随浏览器版本变化，
 *   纯靠文档/规范判断不可靠，必须真机测。
 *
 * 方法：启动真实 Chromium（--load-extension），加载含 Shadow DOM 的测试页，
 *   对每种 shadow 场景真实悬停，观察气泡是否出现、是否取到词、释义是否正确。
 *
 * 用法：
 *   set NODE_PATH=C:\Users\38335\.workbuddy\binaries\node\workspace\node_modules
 *   node verify-shadow-dom.js
 *
 * 退出码：全部通过 0，任一失败 1。
 */
const path = require("path");
const fs = require("fs");
const http = require("http");

const EXT_DIR = __dirname;
const CHROMIUM = path.join(
  process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"),
  "ms-playwright", "chromium-1234", "chrome-win64", "chrome.exe"
);

let pw;
try { pw = require("playwright-core"); }
catch (e) {
  console.error("找不到 playwright-core。请设 NODE_PATH：");
  console.error('  set NODE_PATH=C:/Users/38335/.workbuddy/binaries/node/workspace/node_modules');
  console.error('  node verify-shadow-dom.js');
  process.exit(1);
}

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

// ── Shadow DOM 测试页 ──
// 含 4 种场景：普通文本（对照）/ open shadow / closed shadow / open 嵌套 open
// 页面脚本创建 shadow 后把内部文本坐标存到 window.__rects，供测试脚本悬停。
const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Shadow DOM Test</title>
<style>body{font:16px/1.8 system-ui;padding:40px;max-width:760px;margin:0 auto}
.test{margin:24px 0;padding:8px;border:1px dashed #ccc}</style>
</head><body>
<h1>Shadow DOM 取词兼容性测试</h1>

<!-- ① 普通文本（对照基准，必须能取到） -->
<div class="test"><p id="light-text">The environment requires efficient negotiation.</p></div>

<!-- ② open shadow root -->
<div class="test"><div id="open-host"></div></div>

<!-- ③ closed shadow root -->
<div class="test"><div id="closed-host"></div></div>

<!-- ④ open shadow 内嵌套 open shadow -->
<div class="test"><div id="nested-host"></div></div>

<script>
// 页面加载完成后创建各 shadow root，并把内部文本坐标存到 window.__rects
window.__rects = {};
window.addEventListener('load', () => {
  // ② open shadow
  const openHost = document.getElementById('open-host');
  const openShadow = openHost.attachShadow({mode: 'open'});
  openShadow.innerHTML = '<p id="open-text">The procurement strategy needs implementation.</p>';

  // ③ closed shadow（外部无法访问 shadowRoot，但创建时持有引用）
  const closedHost = document.getElementById('closed-host');
  const closedShadow = closedHost.attachShadow({mode: 'closed'});
  closedShadow.innerHTML = '<p id="closed-text">The analyses of matrices is fundamental.</p>';

  // ④ 嵌套：open > open
  const nestedHost = document.getElementById('nested-host');
  const nestedShadow = nestedHost.attachShadow({mode: 'open'});
  nestedShadow.innerHTML = '<div id="inner-host"></div><p id="nested-text">Out of the blue, she agreed.</p>';
  const innerHost = nestedShadow.getElementById('inner-host');
  const innerShadow = innerHost.attachShadow({mode: 'open'});
  innerShadow.innerHTML = '<p id="deep-text">The decision-maker reviewed the contract.</p>';

  // 等一帧布局完成，计算各 shadow 内文本的坐标
  requestAnimationFrame(() => {
    // ① 普通文本
    const light = document.getElementById('light-text');
    window.__rects.light = rectOf(light.firstChild, 'environment');

    // ② open shadow 内文本（可经 host.shadowRoot 访问）
    const openText = openShadow.getElementById('open-text');
    window.__rects.open = rectOf(openText.firstChild, 'procurement');

    // ③ closed shadow 内文本——外部 shadowRoot 为 null，
    //    但创建时持有的 closedShadow 引用仍在闭包里，可直接用
    const closedText = closedShadow.getElementById('closed-text');
    window.__rects.closed = rectOf(closedText.firstChild, 'analyses');

    // ④ 嵌套 shadow 内文本
    const deepText = innerShadow.getElementById('deep-text');
    window.__rects.nested = rectOf(deepText.firstChild, 'decision-maker');

    // 额外：记录 shadow host 自身坐标（用于「悬停 host 空白区」对照）
    window.__rects.openHost = rectOfEl(openHost);
    window.__rects.closedHost = rectOfEl(closedHost);
    window.__rects.nestedHost = rectOfEl(nestedHost);
    window.__ready = true;
  });
});

function rectOfEl(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height };
}
function rectOf(textNode, word) {
  const idx = textNode.textContent.indexOf(word);
  if (idx < 0) return null;
  const r = document.createRange();
  r.setStart(textNode, idx);
  r.setEnd(textNode, idx + word.length);
  const rect = r.getBoundingClientRect();
  return { x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
}
</script>
</body></html>`;

function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE_HTML);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, base: "http://127.0.0.1:" + server.address().port + "/" });
    });
  });
}

// ── 主流程 ──
(async () => {
  console.log(C.b("\n════════════════════════════════════════════════════════════"));
  console.log(C.b(" Shadow DOM 取词兼容性 · 真机验证"));
  console.log(C.b("════════════════════════════════════════════════════════════"));
  console.log(C.d("  Chromium : " + CHROMIUM));
  console.log(C.d("  扩展目录 : " + EXT_DIR));

  if (!fs.existsSync(CHROMIUM)) {
    console.error(C.r("\n✗ 找不到 Chromium"));
    process.exit(1);
  }

  const userDataDir = path.join(
    process.env.TEMP || process.env.TMP || ".",
    "ht-shadow-profile-" + Date.now()
  );
  const { server, base } = await startServer();
  const TEST_URL = base;
  console.log(C.d("  测试页面 : " + TEST_URL));

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
        "--window-position=-2400,-2400",
        "--window-size=1280,900"
      ]
    });
  } catch (e) {
    console.error(C.r("\n✗ 启动 Chromium 失败：" + (e && e.message)));
    try { server.close(); } catch (_) {}
    process.exit(1);
  }

  try {
    // 等 SW 启动
    sec("第 1 步 · Service Worker 就绪");
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      try { await context.waitForEvent("serviceworker", { timeout: 8000 }); } catch (_) {}
      sw = context.serviceWorkers()[0];
    }
    ok("Service Worker 已启动", !!sw, sw ? sw.url() : "未找到");
    if (!sw) throw new Error("service-worker-not-found");

    sec("第 2 步 · 加载 Shadow DOM 测试页");
    const page = await context.newPage();
    const consoleLogs = [];
    page.on("console", m => consoleLogs.push(m.type() + ": " + m.text()));

    await page.goto(TEST_URL, { waitUntil: "load" });
    // 等 content.js 注入 + 页面脚本计算 shadow 内坐标
    await page.waitForTimeout(1200);

    const injectedLog = consoleLogs.find(l => /悬停取词翻译.*已加载/.test(l));
    ok("content script 已注入", !!injectedLog, injectedLog || "未捕获");

    // 读取页面脚本算好的 shadow 内文本坐标
    const rects = await page.evaluate(() => window.__rects);
    ok("页面已计算 shadow 内文本坐标", !!rects && rects.light && rects.open && rects.closed && rects.nested,
      rects ? JSON.stringify(rects) : "未就绪");

    // ── 悬停工具：真实带轨迹 mousemove，等气泡 ──
    async function hoverAt(x, y) {
      if (x == null || y == null) return null;
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
      await page.mouse.move(x - 60, y, { steps: 5 });
      await page.waitForTimeout(60);
      await page.mouse.move(x, y, { steps: 8 });
      await page.waitForTimeout(900);
      return page.evaluate(() => {
        const b = document.querySelector(".ht-bubble");
        if (!b) return null;
        const style = getComputedStyle(b);
        return {
          text: (b.textContent || "").trim(),
          visible: style.display !== "none" && style.visibility !== "hidden" && parseFloat(style.opacity || "1") > 0
        };
      });
    }

    // ── ① 普通文本（对照，必须成功）──
    sec("第 3 步 · 普通文本悬停（对照基准）");
    const lightBox = await hoverAt(rects.light.x, rects.light.y);
    ok("① 普通文本悬停弹出气泡", !!lightBox && lightBox.visible,
      lightBox ? JSON.stringify(lightBox.text.slice(0, 80)) : "无气泡");
    ok("① 普通文本气泡含 environment 释义", !!lightBox && /环境|环境词库|本地词库/.test(lightBox.text),
      lightBox ? lightBox.text.slice(0, 90) : "无气泡");

    // ── ② open shadow ──
    sec("第 4 步 · open shadow root 内文本悬停");
    const openBox = await hoverAt(rects.open.x, rects.open.y);
    ok("② open shadow 内文本悬停弹出气泡", !!openBox && openBox.visible,
      openBox ? JSON.stringify(openBox.text.slice(0, 80)) : "无气泡");
    if (openBox) {
      ok("② open shadow 气泡含 procurement 释义", /采购|获取|本地词库/.test(openBox.text),
        openBox.text.slice(0, 90));
    } else {
      ok("② open shadow 取词失败（caretRangeFromPoint 未穿透）", false, "无气泡——shadow DOM 不支持");
    }

    // ── ③ closed shadow（预期不支持 · Web 标准限制）──
    // closed shadow 的 shadowRoot 在外部为 null，elementFromPoint 拿不到内部元素，
    // caretRangeFromPoint 返回 host 元素本身——本就不可能取到 shadow 内文本。
    // 这是 Web 标准设计，非实现缺陷。这里验证"确实不支持"以记录该限制。
    sec("第 5 步 · closed shadow root 内文本悬停（预期不支持 · Web 标准限制）");
    const closedBox = await hoverAt(rects.closed.x, rects.closed.y);
    const closedPierce = !!closedBox && closedBox.visible
      && /分析|analyses/.test(closedBox.text);
    ok("③ closed shadow 不支持取词（Web 标准限制 · 预期）", !closedPierce,
      closedPierce ? "意外穿透：" + JSON.stringify(closedBox.text.slice(0, 60))
                   : "符合预期：closed shadow 不可穿透");

    // ── ④ 嵌套 shadow（open > open > open）──
    sec("第 6 步 · 嵌套 shadow 内文本悬停");
    const nestedBox = await hoverAt(rects.nested.x, rects.nested.y);
    ok("④ 嵌套 shadow 内文本悬停弹出气泡", !!nestedBox && nestedBox.visible,
      nestedBox ? JSON.stringify(nestedBox.text.slice(0, 80)) : "无气泡");
    if (nestedBox) {
      ok("④ 嵌套 shadow 气泡含 decision-maker 释义", /决策|决定|本地词库/.test(nestedBox.text),
        nestedBox.text.slice(0, 90));
    } else {
      ok("④ 嵌套 shadow 取词失败", false, "无气泡——嵌套 shadow 不支持");
    }

    // ── 诊断：无条件记录 caretRangeFromPoint 在各坐标上的真实行为 ──
    sec("第 7 步 · 诊断 caretRangeFromPoint / elementFromPoint 在 shadow 上的行为");
    const diag = await page.evaluate((r) => {
      const probe = (name) => {
        const c = r[name];
        if (!c) return { name, err: "no rect" };
        const el = document.elementFromPoint(c.x, c.y);
        const range = document.caretRangeFromPoint(c.x, c.y);
        // 若 elementFromPoint 命中 shadow host，尝试递归穿透 open shadow
        let shadowProbe = null;
        if (el && el.shadowRoot) {
          const inner = el.shadowRoot.elementFromPoint(c.x, c.y);
          const innerRange = el.shadowRoot.caretRangeFromPoint
            ? el.shadowRoot.caretRangeFromPoint(c.x, c.y)
            : null;
          shadowProbe = {
            shadowMode: "open",
            innerElement: inner ? inner.tagName + "#" + inner.id : "null",
            innerCaretNode: innerRange
              ? (innerRange.startContainer.nodeName === '#text'
                ? 'text:"' + (innerRange.startContainer.textContent || "").slice(0, 30) + '"'
                : innerRange.startContainer.nodeName) : "null"
          };
        }
        return {
          name,
          elementFromPoint: el ? el.tagName + "#" + el.id + (el.className ? "." + el.className : "") : "null",
          caretNode: range ? (range.startContainer.nodeName === '#text'
            ? 'text:"' + (range.startContainer.textContent || "").slice(0, 30) + '"'
            : range.startContainer.nodeName) : "null",
          caretOffset: range ? range.startOffset : -1,
          shadowProbe
        };
      };
      return [probe("light"), probe("open"), probe("closed"), probe("nested")];
    }, rects);
    console.log(C.y("  caretRangeFromPoint / elementFromPoint 真实行为："));
    diag.forEach(d => console.log(C.y("    " + JSON.stringify(d))));

    // ── 汇总 ──
    sec("验证汇总");
    const openOk = !!openBox && openBox.visible;
    const nestedOk = !!nestedBox && nestedBox.visible;
    // closed shadow 预期不支持（Web 标准限制）：未意外穿透即符合预期
    const closedExpected = !closedPierce;
    const shadowFixed = openOk && nestedOk;   // open + 嵌套已通过穿透代码修复
    console.log("  普通文本（对照）: " + (lightBox ? C.g("✓ 能取词") : C.r("✗ 失败")));
    console.log("  open shadow     : " + (openOk ? C.g("✓ 能取词（穿透代码生效）") : C.r("✗ 不支持")));
    console.log("  closed shadow   : " + (closedExpected ? C.y("⚠ 标准限制 · 不支持（预期）") : C.r("✗ 意外穿透")));
    console.log("  嵌套 shadow     : " + (nestedOk ? C.g("✓ 能取词（穿透代码生效）") : C.r("✗ 不支持")));
    console.log("");
    console.log("  " + C.g("通过 " + pass) + "  " + (fail ? C.r("失败 " + fail) : "失败 0"));
    if (fail) { console.log(C.r("\n  失败项：")); failures.forEach(f => console.log(C.r("    - " + f))); }

    // 结论
    console.log("");
    if (shadowFixed && closedExpected) {
      console.log(C.g("  ▶ 结论：穿透代码生效——open / 嵌套 shadow 可取词；"));
      console.log(C.g("    closed shadow 因 Web 标准限制不支持（shadowRoot 外部为 null，无解）。"));
    } else if (lightBox && !shadowFixed) {
      console.log(C.y("  ▶ 结论：普通文本正常但 open / 嵌套 shadow 取词失败——穿透代码未生效，需排查。"));
    } else if (!lightBox) {
      console.log(C.r("  ▶ 结论：连普通文本都失败——测试环境问题，需排查扩展加载。"));
    } else {
      console.log(C.y("  ▶ 结论：部分场景异常，详见上方失败项。"));
    }

    // 截图存档
    try {
      await page.screenshot({ path: path.join(EXT_DIR, "verify-shadow.png") });
      console.log(C.d("\n  已截图 verify-shadow.png"));
    } catch (_) {}

  } finally {
    await context.close().catch(() => {});
    try { server.close(); } catch (_) {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error(C.r("\n未捕获异常：" + (e && e.stack || e)));
  process.exit(1);
});
