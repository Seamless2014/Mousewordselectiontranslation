// 词组词库快速校验（开发工具）
const fs = require("fs");
const vm = require("vm");

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync("dict-phrase.js", "utf8"), ctx, { filename: "dict-phrase.js" });

const n = vm.runInContext("Object.keys(DICT_PHRASE).length", ctx);
const keys = vm.runInContext("Object.keys(DICT_PHRASE)", ctx);
console.log("词条数:", n);

// 键形状校验
const badShape = keys.filter(k => !/^[a-z]+(?: [a-z]+)*$/.test(k));
console.log("键形状不合格:", badShape.length, badShape.slice(0, 5));

// 段数分布
const seg = {};
for (const k of keys) {
  const c = k.split(" ").length;
  seg[c] = (seg[c] || 0) + 1;
}
console.log("段数分布:", JSON.stringify(seg));

// 释义缺失
const noTrans = vm.runInContext(
  "Object.keys(DICT_PHRASE).filter(function(k){return !DICT_PHRASE[k] || !DICT_PHRASE[k].t;})",
  ctx
);
console.log("无释义条目:", noTrans.length);

// 抽样（在 vm 内求值，var 不会挂到外层）
console.log("\n抽样：");
const samples = [
  "look forward to", "nervous system", "abide by", "take care",
  "swimming pool", "in order to", "exclusion zone", "a bite to eat",
  "come up with", "make up for", "as soon as", "according to",
  "no such phrase here", "zzzz qqqq"
];
const sampleOut = vm.runInContext(
  "(" + JSON.stringify(samples) + ").map(function(s){var e=DICT_PHRASE[s];return s+' => '+(e?e.t:'(未收录)');})",
  ctx
);
for (const line of sampleOut) console.log("  " + line);

// 与单词库冲突检查（同名键）
const core = vm.createContext({});
vm.runInContext(fs.readFileSync("dict.js", "utf8"), core, { filename: "dict.js" });
vm.runInContext(fs.readFileSync("dict-extra.js", "utf8"), core, { filename: "dict-extra.js" });
const wordKeys = new Set(vm.runInContext("Object.keys(LOCAL_DICT).concat(Object.keys(DICT_EXTRA))", core));
const overlap = keys.filter(k => wordKeys.has(k));
console.log("与单词库同名键:", overlap.length, overlap.slice(0, 5));
