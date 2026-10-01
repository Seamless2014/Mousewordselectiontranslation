/**
 * Manifest 一致性检查（开发自测，无依赖）。
 *
 * 背景 A：曾因 manifest 的 content_scripts 漏配 dict.js，导致真实浏览器中
 * LOCAL_DICT 未定义而报 ReferenceError（jsdom 测试壳手动注入词库掩盖了此问题）。
 *
 * 背景 B（v1.2.0 架构调整）：为解决「内存随标签页线性增长」，词库已从内容脚本
 * 移到 service worker。于是这里的断言方向**反转**：
 *   - 词库**必须不在** content_scripts 里（否则又变成每 frame 一份）
 *   - 词库**必须被** background.js 通过 importScripts 加载（否则查词全落空）
 * 这两条正好互为镜像，是本次架构调整最容易漏的地方。
 *
 * 检查项：
 *   1. content_scripts 注入的每个 JS / CSS 文件都存在
 *   2. content_scripts 里**不得**出现 dict.js / dict-extra.js / dict-lookup.js
 *   3. background.js 通过 importScripts 加载三者，且顺序为 dict -> dict-extra -> dict-lookup
 *   4. background / popup / 图标等清单引用文件都存在
 *   5. popup.html 不再引入词库（改为向后台查询词条数）
 *   6. 词库文件用 var 声明，且 dict-extra.js 不误用 LOCAL_DICT 命名
 *   7. content.js 不再直接引用词库，改为发 HT_LOOKUP 消息
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
console.log("Manifest 一致性检查（v1.2.0 词库归后台）");
console.log("=".repeat(58));

// 1. content_scripts 注入清单
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
check("manifest.json 可解析", true);
check("manifest_version === 3", manifest.manifest_version === 3);
check("版本号已升级到 1.2.0+",
  /^1\.(?:[2-9]|\d{2,})\./.test(String(manifest.version)),
  "当前 " + manifest.version + "，本次架构调整应升版本号");

const cs = manifest.content_scripts || [];
check("content_scripts 非空", cs.length > 0);
if (cs.length) {
  const js = cs[0].js || [];
  js.forEach(f => {
    check("注入文件存在: " + f, fs.existsSync(path.join(DIR, f)));
  });
  check("css 文件存在", (cs[0].css || []).every(f => fs.existsSync(path.join(DIR, f))));

  // ---- 核心断言：词库必须不在内容脚本注入清单中 ----
  check("content.js 在注入清单中", js.indexOf("content.js") >= 0, JSON.stringify(js));
  check("dict.js 不在 content_scripts 中（否则每 frame 各存一份）",
    js.indexOf("dict.js") < 0, "content_scripts.js = " + JSON.stringify(js));
  check("dict-extra.js 不在 content_scripts 中（3 万词会被复制 N×M 份）",
    js.indexOf("dict-extra.js") < 0, "content_scripts.js = " + JSON.stringify(js));
  check("dict-lookup.js 不在 content_scripts 中（查词逻辑归后台）",
    js.indexOf("dict-lookup.js") < 0, "content_scripts.js = " + JSON.stringify(js));
}

// 2. 清单引用的其余文件
const bgFile = manifest.background && manifest.background.service_worker;
const refs = [bgFile, manifest.action && manifest.action.default_popup].filter(Boolean);
refs.forEach(f => check("清单引用存在: " + f, fs.existsSync(path.join(DIR, f))));

const icons = Object.values(manifest.icons || {});
icons.forEach(f => check("图标存在: " + f, fs.existsSync(path.join(DIR, f))));

// 3. background.js 必须 importScripts 三个文件且顺序正确
const bgSrc = fs.readFileSync(path.join(DIR, bgFile || "background.js"), "utf8");
check("background.js 使用 importScripts 加载词库",
  /importScripts\s*\(/.test(bgSrc), "service worker 才能集中持有词库");
check("importScripts 包含 dict-lookup.js", /importScripts[^)]*dict-lookup\.js/.test(bgSrc));
check("importScripts 包含 dict.js", /importScripts[^)]*["']dict\.js["']/.test(bgSrc));
check("importScripts 包含 dict-extra.js", /importScripts[^)]*dict-extra\.js/.test(bgSrc));
{
  const m = bgSrc.match(/importScripts\s*\(([^)]*)\)/);
  const args = m ? m[1].split(",").map(s => s.trim().replace(/["']/g, "")) : [];
  const iLookup = args.indexOf("dict-lookup.js");
  const iCore = args.indexOf("dict.js");
  const iExtra = args.indexOf("dict-extra.js");
  check("importScripts 顺序：dict.js -> dict-extra.js -> dict-lookup.js",
    iCore >= 0 && iExtra > iCore && iLookup > iExtra,
    "实际顺序 " + JSON.stringify(args));
}

// 4. background.js 必须处理 HT_LOOKUP / HT_DICT_INFO
check("background.js 处理 HT_LOOKUP 消息", /["']HT_LOOKUP["']/.test(bgSrc));
check("background.js 处理 HT_DICT_INFO 消息", /["']HT_DICT_INFO["']/.test(bgSrc));

// 5. popup.html 不再引入词库
const popupHtml = fs.readFileSync(path.join(DIR, "popup.html"), "utf8");
check("popup.html 不再引入 dict.js",
  !/<script[^>]+src=["']dict\.js["']/.test(popupHtml), "popup 加载词库会多占一份内存");
check("popup.html 不再引入 dict-extra.js",
  !/<script[^>]+src=["']dict-extra\.js["']/.test(popupHtml));
check("popup.html 引入 popup.js", /<script[^>]+src=["']popup\.js["']/.test(popupHtml));

const popupJs = fs.readFileSync(path.join(DIR, "popup.js"), "utf8");
check("popup.js 通过 HT_DICT_INFO 查询词条数", /["']HT_DICT_INFO["']/.test(popupJs));
check("popup.js 不再直接引用 LOCAL_DICT / DICT_EXTRA",
  !/\bLOCAL_DICT\b|\bDICT_EXTRA\b/.test(popupJs));
check("popup.js 不再直接引用 LOCAL_DICT / DICT_EXTRA",
  !/\bLOCAL_DICT\b|\bDICT_EXTRA\b/.test(popupJs));

// 6. 词库文件用 var 声明
const dictSrc = fs.readFileSync(path.join(DIR, "dict.js"), "utf8");
check("dict.js 使用 var 声明 LOCAL_DICT", /^var\s+LOCAL_DICT\s*=/m.test(dictSrc),
  "应避免 const/let（重复 importScripts 时重声明会抛错）");

const extraPath = path.join(DIR, "dict-extra.js");
if (fs.existsSync(extraPath)) {
  const extraSrc = fs.readFileSync(extraPath, "utf8");
  check("dict-extra.js 使用 var 声明 DICT_EXTRA", /^var\s+DICT_EXTRA\s*=/m.test(extraSrc),
    "应避免 const/let（重复 importScripts 时重声明会抛错）");
  check("dict-extra.js 以 DICT_EXTRA 而非 LOCAL_DICT 命名",
    !/^\s*var\s+LOCAL_DICT\s*=/m.test(extraSrc),
    "扩展词库必须用独立变量名，否则会覆盖精选词库");
} else {
  check("dict-extra.js 存在", false, "应运行 build-dict.js 生成");
}

// 7. dict-lookup.js 结构
const lookupPath = path.join(DIR, "dict-lookup.js");
check("dict-lookup.js 存在", fs.existsSync(lookupPath));
if (fs.existsSync(lookupPath)) {
  const lookupSrc = fs.readFileSync(lookupPath, "utf8");
  check("dict-lookup.js 导出 lookupLocal", /function\s+lookupLocal\s*\(/.test(lookupSrc));
  check("dict-lookup.js 导出 buildLocalResult", /function\s+buildLocalResult\s*\(/.test(lookupSrc));
  check("dict-lookup.js 提供 lemmatize", /function\s+lemmatize\s*\(/.test(lookupSrc));
  check("dict-lookup.js 查词使用 hasOwnProperty 防原型污染",
    /hasOwnProperty\.call\(\s*dict\s*,\s*key\s*\)/.test(lookupSrc));
  check("dict-lookup.js 对词库缺失有 typeof 防御",
    /typeof\s+LOCAL_DICT\s*===?\s*["']undefined["']/.test(lookupSrc));
}

// 8. content.js 已卸下词库，改为消息查词
const contentSrc = fs.readFileSync(path.join(DIR, "content.js"), "utf8");
// 剥掉注释再断言：注释里提到词库变量名是正常的历史说明，不算引用。
// 这里用逐行剥离 // 与 /* */ 的方式，避免误判。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")   // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // 行注释（避免误吞 http://）
}
const contentCode = stripComments(contentSrc);
check("content.js 代码中不再引用 LOCAL_DICT", !/\bLOCAL_DICT\b/.test(contentCode),
  "词库引用残留会把每 frame 一份的旧问题带回来");
check("content.js 代码中不再引用 DICT_EXTRA", !/\bDICT_EXTRA\b/.test(contentCode));
check("content.js 不再自带词形还原实现", !/\bfunction\s+lemmatize\s*\(/.test(contentCode),
  "词形还原应只在 dict-lookup.js 中有一份实现");
check("content.js 不再自带 lookupLocal 实现", !/\bfunction\s+lookupLocal\s*\(/.test(contentCode));
check("content.js 通过 HT_LOOKUP 向后台查词", /["']HT_LOOKUP["']/.test(contentCode));
check("content.js 有本地查词超时保护",
  /LOCAL_LOOKUP_TIMEOUT/.test(contentCode), "后台重建时不应卡住取词");

// content.js 不应再引用已删除的 HT_SET_ENABLED
check("无残留 HT_SET_ENABLED 消息类型", !/HT_SET_ENABLED/.test(contentSrc) &&
  !/HT_SET_ENABLED/.test(bgSrc));

console.log(log.join("\n"));
console.log("\n通过 " + pass + " / " + (pass + fail));
console.log(fail === 0 ? "\n全部通过 ✓" : "\n存在失败项 ✗");
process.exit(fail === 0 ? 0 : 1);
