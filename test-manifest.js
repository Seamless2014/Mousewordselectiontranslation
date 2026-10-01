/**
 * Manifest 一致性检查（开发自测，无依赖）。
 *
 * 背景：曾因 manifest 的 content_scripts 漏配 dict.js，导致真实浏览器中
 * LOCAL_DICT 未定义而报 ReferenceError（jsdom 测试壳手动注入词库掩盖了此问题）。
 * 本脚本把「注入清单与代码引用一致」固化为自动化检查。
 *
 * 检查项：
 *   1. content_scripts 注入的每个 JS 文件都存在
 *   2. content.js 依赖的 dict.js 必须先于 content.js 注入
 *   3. background / popup / 图标等清单引用文件都存在
 *   4. popup.html 显式引入了 dict.js（popup 独立上下文需要）
 *   5. dict.js 使用 var 声明（避免重复注入时重声明报错）
 *   6. content.js 对 LOCAL_DICT 有防御性判断（词库缺失时优雅降级）
 *
 * 运行：node test-manifest.js
 */
const fs = require("fs");
const path = require("path");
const DIR = __dirname;

let pass = 0, fail = 0;
const log = [];
function check(name, cond, extra) {
  if (cond) { pass++; log.push("  ✓ " + name); }
  else { fail++; log.push("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

console.log("=".repeat(58));
console.log("Manifest 一致性检查");
console.log("=".repeat(58));

// 1/2. content_scripts 注入清单
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
check("manifest.json 可解析", true);
check("manifest_version === 3", manifest.manifest_version === 3);

const cs = manifest.content_scripts || [];
check("content_scripts 非空", cs.length > 0);
if (cs.length) {
  const js = cs[0].js || [];
  js.forEach(f => {
    check("注入文件存在: " + f, fs.existsSync(path.join(DIR, f)));
  });
  const di = js.indexOf("dict.js");
  const ei = js.indexOf("dict-extra.js");
  const ci = js.indexOf("content.js");
  check("dict.js 在注入清单中", di >= 0, "content_scripts.js = " + JSON.stringify(js));
  check("dict-extra.js 在注入清单中", ei >= 0, "content_scripts.js = " + JSON.stringify(js));
  check("dict.js 先于 content.js 注入", di >= 0 && ci > di,
    "dict 索引 " + di + "，content 索引 " + ci);
  check("dict-extra.js 先于 content.js 注入", ei >= 0 && ci > ei,
    "dict-extra 索引 " + ei + "，content 索引 " + ci);
  check("css 文件存在", (cs[0].css || []).every(f => fs.existsSync(path.join(DIR, f))));
}

// 3. 清单引用的其余文件
const refs = [
  manifest.background && manifest.background.service_worker,
  manifest.action && manifest.action.default_popup
].filter(Boolean);
refs.forEach(f => check("清单引用存在: " + f, fs.existsSync(path.join(DIR, f))));

const icons = Object.values(manifest.icons || {});
icons.forEach(f => check("图标存在: " + f, fs.existsSync(path.join(DIR, f))));

// 4. popup.html 引入 dict.js / dict-extra.js
const popupHtml = fs.readFileSync(path.join(DIR, "popup.html"), "utf8");
check("popup.html 引入 dict.js", /<script[^>]+src=["']dict\.js["']/.test(popupHtml));
check("popup.html 引入 dict-extra.js", /<script[^>]+src=["']dict-extra\.js["']/.test(popupHtml));
check("popup.html 引入 popup.js", /<script[^>]+src=["']popup\.js["']/.test(popupHtml));

// 5. dict.js / dict-extra.js 用 var 声明
const dictSrc = fs.readFileSync(path.join(DIR, "dict.js"), "utf8");
check("dict.js 使用 var 声明 LOCAL_DICT", /^var\s+LOCAL_DICT\s*=/m.test(dictSrc),
  "应避免 const/let（重复注入时重声明会抛错）");

const extraPath = path.join(DIR, "dict-extra.js");
if (fs.existsSync(extraPath)) {
  const extraSrc = fs.readFileSync(extraPath, "utf8");
  check("dict-extra.js 使用 var 声明 DICT_EXTRA", /^var\s+DICT_EXTRA\s*=/m.test(extraSrc),
    "应避免 const/let（重复注入时重声明会抛错）");
  check("dict-extra.js 以 DICT_EXTRA 而非 LOCAL_DICT 命名",
    !/^\s*var\s+LOCAL_DICT\s*=/m.test(extraSrc),
    "扩展词库必须用独立变量名，否则会覆盖精选词库");
} else {
  check("dict-extra.js 存在", false, "应运行 build-dict.js 生成");
}

// 6. content.js 防御性判断（两个词库都要有）
const contentSrc = fs.readFileSync(path.join(DIR, "content.js"), "utf8");
check("content.js 对 LOCAL_DICT 有 typeof 防御",
  /typeof\s+LOCAL_DICT\s*===?\s*["']undefined["']/.test(contentSrc),
  "词库缺失时应降级为纯在线模式而非崩溃");
check("content.js 对 DICT_EXTRA 有 typeof 防御",
  /typeof\s+DICT_EXTRA\s*===?\s*["']undefined["']/.test(contentSrc),
  "扩展词库缺失时应能继续用精选词库");
// 用 hasOwnProperty 查词，避免命中原型链上的 toString / constructor
check("content.js 查词使用 hasOwnProperty 防原型污染",
  /hasOwnProperty\.call\(dict,\s*key\)/.test(contentSrc));

// content.js 不应再引用已删除的 HT_SET_ENABLED
check("无残留 HT_SET_ENABLED 消息类型", !/HT_SET_ENABLED/.test(contentSrc) &&
  !/HT_SET_ENABLED/.test(fs.readFileSync(path.join(DIR, "background.js"), "utf8")));

console.log(log.join("\n"));
console.log("\n通过 " + pass + " / " + (pass + fail));
console.log(fail === 0 ? "\n全部通过 ✓" : "\n存在失败项 ✗");
process.exit(fail === 0 ? 0 : 1);
