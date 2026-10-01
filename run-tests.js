/**
 * 测试总入口 —— 一条命令跑完全部套件。
 *
 * 解决的问题：
 *   1. test-e2e.js / test-switch.js 依赖 jsdom，但 jsdom 装在托管 Node 工作区
 *      （~/.workbuddy/binaries/node/workspace/node_modules），直接 node test-xxx.js
 *      会报 MODULE_NOT_FOUND。以前每次都要手动设 NODE_PATH，批量回归时容易漏，
 *      漏了就是"假失败"。本脚本自动探测 jsdom 位置，并通过 NODE_PATH 传给子进程。
 *   2. 各套件大量使用 async IIFE + process.exit()，同步 require 捕获不到结果，
 *      因此每个套件用子进程跑、按退出码判定（这也是它们正常的运行方式）。
 *
 * 用法：
 *   node run-tests.js                # 跑全部
 *   node run-tests.js e2e switch     # 只跑文件名/名称含 e2e / switch 的套件
 *
 * 退出码：全部通过为 0，任一失败为 1（可用于 CI）。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const DIR = __dirname;

// ---------- 定位 jsdom 并注入 NODE_PATH ----------
// 必须在 require 套件之前完成：Node 的模块解析会读取 NODE_PATH。
function findJsdomRoot() {
  const candidates = [];
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) {
    candidates.push(path.join(home, ".workbuddy", "binaries", "node", "workspace", "node_modules"));
  }
  let cur = DIR;
  for (let i = 0; i < 6; i++) {
    candidates.push(path.join(cur, "node_modules"));
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  (process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean)
    .forEach(p => candidates.push(p));

  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, "jsdom"))) return c;
  }
  return null;
}

const jsdomRoot = findJsdomRoot();
const childEnv = Object.assign({}, process.env);
if (jsdomRoot) {
  childEnv.NODE_PATH = childEnv.NODE_PATH
    ? jsdomRoot + path.delimiter + childEnv.NODE_PATH
    : jsdomRoot;
}

// ---------- 套件清单（从底层到上层，便于定位）----------
const SUITES = [
  { file: "test-manifest.js",   name: "清单一致性", needsJsdom: false },
  { file: "test-verify.js",     name: "词库与还原", needsJsdom: false },
  { file: "test-extra.js",      name: "扩展词库",   needsJsdom: false },
  { file: "test-background.js", name: "后台查词",   needsJsdom: false },
  { file: "test-edge.js",       name: "边界与契约", needsJsdom: false },
  { file: "test-perf.js",       name: "在线性能",   needsJsdom: false },
  { file: "test-e2e.js",        name: "端到端",     needsJsdom: true },
  { file: "test-switch.js",     name: "开关链路",   needsJsdom: true },
];

const filters = process.argv.slice(2);
const selected = filters.length
  ? SUITES.filter(s => filters.some(f => s.file.includes(f) || s.name.includes(f)))
  : SUITES;

if (!selected.length) {
  console.error("没有匹配的测试套件，可用关键字：" +
    SUITES.map(s => s.file.replace(/\.js$/, "")).join(", "));
  process.exit(1);
}

console.log("=".repeat(64));
console.log("悬停取词翻译 —— 测试总入口");
console.log("=".repeat(64));
console.log("Node       : " + process.version);
console.log("jsdom 位置 : " + (jsdomRoot || "未找到（依赖 jsdom 的套件会跳过）"));
console.log("");

// ---------- 逐套件执行（子进程）----------
const summary = [];
let passTotal = 0, allTotal = 0, failedSuites = 0, skipped = 0;

for (const s of selected) {
  const p = path.join(DIR, s.file);
  if (!fs.existsSync(p)) {
    summary.push({ name: s.name, file: s.file, result: "缺失", ok: false });
    failedSuites++;
    continue;
  }
  if (s.needsJsdom && !jsdomRoot) {
    summary.push({ name: s.name, file: s.file, result: "跳过", ok: null });
    skipped++;
    console.log("— " + s.file + " 跳过（未找到 jsdom）");
    continue;
  }

  // 子进程执行：各套件都用 async IIFE + process.exit，这样最贴近真实运行方式。
  let captured = "", exitCode = 0;
  try {
    captured = execSync("node " + JSON.stringify(s.file), {
      cwd: DIR,
      env: childEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (e) {
    // 非 0 退出码会抛错，但 stdout/stderr 仍可读，测试报告就在里面
    captured = (e.stdout || "") + (e.stderr || "");
    exitCode = typeof e.status === "number" ? e.status : 1;
  }

  const m = captured.match(/通过\s+(\d+)\s*\/\s*(\d+)/);
  const nPass = m ? Number(m[1]) : 0;
  const nAll = m ? Number(m[2]) : 0;
  const ok = exitCode === 0 && m && nPass === nAll;

  passTotal += nPass;
  allTotal += nAll;
  if (!ok) failedSuites++;

  summary.push({
    name: s.name,
    file: s.file,
    result: m ? (nPass + " / " + nAll) : "无输出",
    ok: ok,
  });

  console.log((ok ? "✓" : "✗") + " " + s.file.padEnd(22) +
    (m ? (nPass + " / " + nAll).padEnd(12) : "无输出".padEnd(12)) + s.name);

  if (!ok) {
    console.log("\n" + "-".repeat(64));
    console.log(captured.trim());
    console.log("-".repeat(64) + "\n");
  }
}

console.log("");
console.log("=".repeat(64));
console.log("汇总");
console.log("=".repeat(64));
for (const s of summary) {
  const mark = s.ok === true ? "✓" : (s.ok === null ? "—" : "✗");
  console.log("  " + mark + " " + s.name.padEnd(14) + s.file.padEnd(22) + s.result);
}
console.log("");
console.log("用例合计：" + passTotal + " / " + allTotal +
  (skipped ? "（跳过 " + skipped + " 个套件）" : ""));
console.log(failedSuites === 0
  ? "\n全部套件通过 ✓"
  : "\n存在失败套件 ✗（" + failedSuites + " 个）");
process.exit(failedSuites === 0 ? 0 : 1);
