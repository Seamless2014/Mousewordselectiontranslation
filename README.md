# 悬停取词翻译（Hover Translate）

浏览器扩展（Manifest V3）。**鼠标悬停在英文单词上，即时显示中文释义；鼠标移开，气泡自动消失。**

看英文文档不必再复制粘贴到翻译网站——悬停一下就够了。

---

## 功能特性

| 特性 | 说明 |
|---|---|
| 悬停即译 | 鼠标停在单词**或词组**上约 320ms 自动弹出中文释义，**同一段落内换词也能持续翻译** |
| 移开即隐 | 鼠标离开气泡自动消失，不打断阅读 |
| 本地词库优先 | **内置约 11.7 万词条**（精选单词 940 + ECDICT 高频扩展 3 万 + 词组 8.59 万），**离线可用** |
| 词组识别 | 悬停在 `figure out`、`out of the blue`、`a variety of` 等搭配上时自动识别**整条词组**并翻译，不必逐词拼凑 |
| 分层优先 | core 单词 > 词组 > extra 单词：判断词与词组均命中时，**core 精选单词胜出**，extra 机器词条让位词组 |
| 内存恒定 | 词库由后台统一持有，**开多少标签页都只占一份内存**（约 9.5 MB SW 堆，不随标签页增长） |
| 在线兜底 | 本地未收录的词自动联网翻译（Google 主通道 + MyMemory 备用通道），**失败自动重试**，连续失败的通道短暂冷却 |
| 合成词拆词 | `decision-maker` / `real-time` / `mother-in-law` 自动拆段查本地词库，无需联网 |
| 词形还原 | `implementations` → `implementation`、`running` → `run`、`analyses` → `analysis` |
| 音标显示 | 扩展词库自带音标，本地查询即可显示，无需联网 |
| 三种开关 | 悬浮球点击 / 右键菜单 / 快捷键 `Alt+Shift+T` |
| 可调延迟 | 80–900ms 可调，避免误触发 |
| 隐私可控 | 关闭在线兜底后**完全离线**，不发出任何网络请求 |

---

## 安装

1. 打开 Chrome / Edge，地址栏输入 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 右上角打开 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择本目录（`hover-translate`）
4. 打开任意英文网页，鼠标悬停到单词上试试

> 首次安装后建议刷新已打开的页面，确保内容脚本注入。

---

## 使用

| 操作 | 效果 |
|---|---|
| 鼠标悬停单词 | 弹出释义气泡（跟随鼠标） |
| 鼠标移开 | 气泡自动消失 |
| 鼠标移入气泡 | 气泡保持，方便复制释义 |
| 按 `Esc` | 立即关闭气泡 |
| 点击右下角悬浮球 | 开启 / 关闭取词功能 |
| 右键页面 → 开启/关闭悬停取词翻译 | 同上 |
| `Alt+Shift+T` | 同上 |
| 点击工具栏图标 | 打开设置面板 |

### 设置项

- **在线兜底翻译**：本地未收录时联网查询。关闭后完全离线。
- **显示音标**：显示音标（扩展词库本地即带音标，在线结果也会有）。
- **显示悬浮球**：页面右下角快捷开关。
- **触发延迟**：悬停多久弹出释义，默认 320ms。

---

## 故障排查

### 开关点了没反应 / 悬停不出气泡

按以下顺序检查（**多数情况是第 1、2 条**）：

**1. 装完扩展后没有刷新页面**
内容脚本只在页面加载时注入，扩展刚装上时**已打开的页面不会自动获得脚本**。
→ 按 `F5` 刷新页面，或在新标签页打开。

**2. 页面地址属于受限页面**
`chrome://`、`edge://`、`chrome.google.com/webstore`、扩展商店页等**禁止注入内容脚本**，
扩展无法在这些页面工作。这是浏览器硬限制。
→ 换一个普通网站（如 `https://en.wikipedia.org`）测试。

**3. 确认当前开关状态**
- 页面右下角有悬浮球：显示 **`译`** 为开启，**`×`** 为关闭。点击可切换。
- 没有悬浮球：说明内容脚本未注入（回到第 1、2 条），或设置里关了「显示悬浮球」。

**4. 确认脚本已加载（最快的自检）**
按 `F12` 打开控制台，应看到两行蓝字：
```
[悬停取词翻译] v1.3.0 已加载，悬停英文单词或词组即可翻译
[悬停取词翻译] 离线词库已就绪：精选 940 条 + 扩展 30000 条 + 词组 85867 条（由后台统一持有）
```
- 只有第一行、没有第二行 → **后台词库没起来**，去 `chrome://extensions` 点该扩展的
  「Service Worker」链接看报错；最常见原因是 `background.js` 的 `importScripts` 目标缺失。
- 两行都没有 → 脚本未注入（回到第 1、2 条），或扩展没刷新（见第 5 条）。
- 两行都有但仍不翻译 → 悬停停顿时间要超过设置里的"触发延迟"（默认 320ms），
  快速扫过单词不会触发；另外检查悬浮球是否为关闭态。

**5. 重新加载扩展**
改动过扩展文件后，需在 `chrome://extensions` 页面点击该扩展的**刷新↻按钮**，
否则运行的是旧代码。**扩展重载后，所有已打开页面也必须 F5 刷新**——
旧页面的内容脚本已随扩展重载失效（控制台会提示"扩展已更新，请刷新页面"）。

**6. 查看报错信息**
- 在扩展页面点 **「错误」** 按钮 或 **「Service Worker」** 链接，看后台有无异常。
  v1.2.0 起词库由后台加载，**若词库相关报错，一定在这里**——网页控制台看不到。
- 在任意网页按 `F12` → Console，看有无 `ht-` 相关报错。

**7. 权限被拦截**
某些企业策略或安全软件会阻止扩展注入。若上述都正常仍无效，
在 `chrome://extensions` 中确认扩展**已启用**、无「此扩展程序已损坏」提示。

### 气泡出现但显示「翻译服务暂时不可用」

在线兜底通道（Google 免费端点 / MyMemory）不可达。此时**本地词库仍正常工作**——
`efficiency`、`approach`、`implementations` 这类常用词照样能查。
错误提示里会标明是哪条通道失败、原因是什么（如 `Google: HTTP 429`），便于排查。
如需稳定翻译，可替换 `background.js` 中的接口为自建服务或大模型 API。

v1.2.1 起针对这类抖动做了三层缓解，偶发超时应大幅减少：

1. **失败自动重试**：第一次短超时（700ms）快失败后，自动静默重试一次并把
   超时放宽到 2.5s/3s，网络抖动大多在这一步被兜住（气泡会显示「重试中…」）
2. **通道冷却**：某通道连续失败 2 次后冷却 120 秒，期间不再陪它耗到超时
   （例如国内网络下 Google 端点常不可达，冷却后 MyMemory 独立承担、响应更快）；
   全部通道都在冷却时仍会照常尝试——有结果总比没有强
3. **连字符合成词本地拆词**：`decision-maker`、`real-time`、`mother-in-law`
   这类词整词查不到时自动拆段（各段都命中才合成），**根本不走网络**，
   角标显示「本地词库 · 组合」

### 某些单词查不到

本地词库约 11.7 万词条（单词约 3.1 万 + 词组约 8.6 万），覆盖日常、学术、技术、商务高频词
（含开发者文档常见词与月份星期），以及大量常用搭配与短语动词。
极生僻词、最新术语、以及未收录的长词组依赖在线兜底；若在线不可用则查不到。可按下方「词库说明」自行扩充。
在扩展设置面板底部可看到当前**实际加载的本地词条数**——若显示「未加载」或数字异常偏小，
说明**后台词库没加载成功**，请在 `chrome://extensions` 查看该扩展的
「Service Worker」是否有 `importScripts` 报错，然后**重新加载扩展**并刷新页面。

### 词组命中不理想

词组按**词数由短到长**匹配，因此悬停 `blue` 于 `out of the blue` 中时，会先命中较短的
`out of`（「在…外」）而非整条 `out of the blue`（「突然」）。

这是**有意为之**：英语里短搭配（`as soon as`、`account for`）本身就是合法且高频的释义单元，
若改成「最长优先」，`as soon as possible` 就会抢走 `as soon as` 的正确释义。若想看到完整词组，
把鼠标停在**词组的最后一个词**上（如 `blue`）即可——此时可用候选更长，命中更完整。

另一个已知取舍：若悬停词本身是 **core 精选单词**（如 `long`），即使它处于
`in the long run` 这类词组中，也会优先显示单词自身的释义。这是「分层优先」策略的结果：
手工维护的精选词条释义质量更高，不应被机器提取的词组覆盖。

---

## 目录结构

```
hover-translate/
├── manifest.json      # 扩展清单（MV3）
├── content.js         # 内容脚本（轻壳）：取词、向后台查词、气泡渲染、开关
├── content.css        # 气泡与悬浮球样式
├── dict.js            # 精选词库（940 条，手工维护）
├── dict-extra.js      # 扩展词库（3 万条，由 ECDICT 自动生成，勿手工编辑）
├── dict-phrase.js     # 词组词库（8.59 万条，由 ECDICT + 短语动词自动生成，勿手工编辑）
├── dict-lookup.js     # 词形还原 + 分层查词（单词/词组唯一实现，由后台 importScripts 加载）
├── build-dict.js      # 词库构建脚本：从 ECDICT CSV 生成 dict-extra.js
├── build-phrases.py   # 词组构建脚本：从 ECDICT SQLite 生成 dict-phrase.js（Python 3）
├── background.js      # Service Worker：持有词库、离线查词、在线翻译代理、菜单/快捷键
├── popup.html/js      # 设置面板（词条数向后台查询，不再自己加载词库）
├── icons/             # 扩展图标
├── run-tests.js       # 测试总入口（自动定位 jsdom，一键跑全部套件）
├── test-verify.js     # 精选词库与词形还原验证（开发自测）
├── test-extra.js      # 扩展词库与两级查词验证（开发自测）
├── test-background.js # 后台查词与 importScripts 装配验证（开发自测）
├── test-edge.js       # 边界场景与消息契约校验（开发自测）
├── test-e2e.js        # DOM 端到端模拟测试（开发自测）
├── test-switch.js     # 开关链路诊断（开发自测）
├── test-manifest.js   # 清单一致性检查（开发自测）
├── test-perf.js       # 在线翻译性能 + 离线查词耗时测试（开发自测）
├── verify-browser.js  # 真实 Chromium 验收：功能端到端 + CDP 内存实测（开发工具）
└── bench-memory.js    # 内存占用对比实测（开发工具）
```

---

## 自测

**推荐：一条命令跑全部**（自动定位 jsdom，无需手动设 `NODE_PATH`）

```bash
node run-tests.js              # 全部套件（281 个用例）
node run-tests.js e2e switch   # 只跑名字含 e2e / switch 的套件
```

退出码 0 表示全绿，可直接用于 CI。也可单独运行某个套件：

```bash
node test-verify.js      # 精选词库 + 词形还原（无需依赖）
node test-extra.js       # 扩展词库结构 + 分层查词优先级（无需依赖）
node test-background.js  # 后台查词 + importScripts 装配（无需依赖）
node test-edge.js        # 边界场景 + 消息契约（无需依赖）
node test-manifest.js    # 清单一致性：词库不得注入内容脚本（无需依赖）
node test-perf.js        # 在线竞速/超时/缓存 + 离线查词耗时（无需依赖）
node test-e2e.js         # 端到端 DOM 模拟（需 jsdom）
node test-switch.js      # 开关链路 + 查词链路（需 jsdom）
```

词库相关的独立校验（构建后跑一次）：

```bash
node check-phrase.js         # 词组词库形状 / 释义缺失 / 与单词库同名键
node check-phrase-lookup.js  # 词组查询链路抽查（含分层优先三种结局）
```

内存收益实测：

```bash
node --expose-gc bench-memory.js 20 5   # 20 标签页 × 5 iframe
```

### 真实浏览器验收（可选，需本机 Chromium）

`run-tests.js` 的八个套件跑在 Node/jsdom 模拟环境里；`verify-browser.js` 则启动
**真实 Chromium**（`--load-extension` 加载本目录），验证三件模拟环境测不到的事：

1. Service Worker 里 `importScripts` 真实装配 + 真实查词 + **真实词组分层裁决**（50 项断言）
2. 真实页面悬停取词：气泡渲染、中文释义、「本地词库 / 本地词库 · 扩展 / 本地词库 · 词组 / 本地词库 · 组合」角标、词形还原、Esc/移开隐藏
3. **CDP 内存实测**：1 → 16 个标签页，SW 堆是否恒定、网页堆是否不含词库副本

```bash
# 需要 NODE_PATH 指到 playwright-core 所在目录；窗口会开到屏幕外，不干扰操作
NODE_PATH=".../node_modules" node verify-browser.js        # 默认 13 个额外标签页
NODE_PATH=".../node_modules" node verify-browser.js 20     # 指定标签页数
NODE_PATH=".../node_modules" node verify-browser.js --no-memory   # 只验功能
```

v1.3.0 实测参考值（Chromium 151）：

| 指标 | 1 个标签页 | 16 个标签页 |
|---|---|---|
| Service Worker 堆 | 9.5 MB | **9.5 MB（+0.0%）** |
| 单个网页 JS 堆 | 2.2 MB | 1.4 MB（不含词库副本） |

注意：`content_scripts` 的 `<all_urls>` **不包含 `data:` URL**，验收脚本内置了一个
本地 HTTP 服务把测试页落在 `http://127.0.0.1` 上，属正常设计而非绕过。

---

## 实现要点

**词库归后台（v1.2.0，重要架构调整）**

v1.1 及之前，`dict.js` / `dict-extra.js` 由 `manifest.content_scripts` 注入。但**内容脚本是「每个 frame 一份独立 JS 环境」**（`all_frames: true` 下标签页的每个 iframe 也算一份），于是：

- 每份都要**独立解析**近 6.2 MB 的词库脚本（`dict.js` + `dict-extra.js` + `dict-phrase.js`）
- 每份都在 V8 堆里**独立持有**词库对象，实测堆增量约 **34 MB/份**（源文本的约 5.5 倍）

推算 20 个标签页 × 平均 5 个 iframe = 100 份 ≈ **3.4 GB**，且同一份脚本被重复解析 100 次。

v1.2.0 把词库移到 Service Worker（`background.js` 用 `importScripts("dict.js", "dict-extra.js", "dict-phrase.js", "dict-lookup.js")` 加载），**全局只持有一份**：

| 项目 | v1.1（注入内容脚本） | v1.2+（后台集中持有） |
|---|---|---|
| 内存占用（100 frame） | ≈ 3.4 GB（词库已扩至 11.7 万条） | **9.5 MB 恒定** |
| 随标签页增长 | 线性增长 | **恒定不变** |
| 词库解析次数 | 100 次 | **1 次** |
| 每次查词 | 纯内存查找 | 多一次消息往返（约 1–3 ms） |

代价是内容脚本查词要走一次 `chrome.runtime.sendMessage`。实测 worker 侧查词平均 **0.003 ms**，加上序列化与 IPC 约 1–3 ms，相对 `hoverDelay` 默认 320 ms 占比不到 1%，用户无感；且内容脚本侧仍有命中缓存，同一单词重复悬停不再往返。

配套设计：

- **惰性初始化**：Service Worker 空闲约 30 s 会被回收，用 `importScripts` 的重新执行 + 首次查词触发重建即可，**不需要 `chrome.alarms` 常驻唤醒**（那是白白耗电）。
- **超时降级**：内容脚本查后台设 200 ms 上限（`LOCAL_LOOKUP_TIMEOUT`），超时直接走在线兜底，不卡住取词。
- **查词逻辑单一实现**：词形还原、分层优先级（core 单词 / 词组 / extra 单词）、词条组装全部收在 `dict-lookup.js`；以前 `content.js` / `test-extra.js` / `test-verify.js` 各存一份副本，改一处要同步三处。
- **popup 不再加载词库**：词条数改为发 `HT_DICT_INFO` 询问后台，避免「开一次 popup 多一份 2.1 MB 堆占用」。

**为什么不用 SharedArrayBuffer**：跨进程共享内存需要页面自身返回 `COOP`/`COEP` 响应头，扩展无权为站点设置，因此不可行。

**取词**：用 `document.caretRangeFromPoint(x, y)` 拿到鼠标坐标处的文本节点与偏移，再向两侧扩展到完整单词。比 `mouseover` 事件目标更精确——同一段落内不同单词都能准确区分。

**触发模型（v1.0.2 重构）**：`mousemove` + 悬停防抖（时长即设置里的"触发延迟"）。
v1.0.1 及之前用 `mouseover` 触发——但 `mouseover` 只在鼠标**跨过元素边界**时触发，
同一段落内从词 A 挪到词 B 不会再次触发，导致段落里只有进入时碰到的第一个词能翻译。
改为 `mousemove` 驱动后，段落内每个词停顿即可翻译；悬停在图片/空白上气泡自动收起。

**词形还原**：先查不规则词表（`was→be`、`built→build`、`analyses→analysis`），再按后缀规则生成候选原形（复数、`-ing`、`-ed`、比较级、副词 `-ly`），逐个查词库。因此 `implementations`、`significantly`、`libraries` 都能命中。
注意：ECDICT 中大量变体形式（`negotiated`、`audited`、`running`）**本身就有独立词条**，
会走"原词直命中"而非还原——这是有意的，因为 ECDICT 对变体的释义更精确（会标注"（…的过去式）"）。

**分层词库查词**：`lookupLocal` 先查精选词库 `LOCAL_DICT`、再查词组库 `DICT_PHRASE`、
最后查扩展词库 `DICT_EXTRA`；原词优先于还原候选（即"词库直命中" > "词形还原命中"）。
查词用 `hasOwnProperty` 判断，避免键名撞上 `Object.prototype` 的属性；
`constructor` 这类词虽是 ECDICT 里的真实单词，也只会取到词典释义，不会拿到 JS 内置构造器。

**词组识别（v1.3.0）**：`content.js` 从悬停位置向左右收集相邻词，**枚举所有 2–6 词的子串**，
按**由短到长**排序后随消息一并发给后台；后台逐个尝试，第一个命中即返回。
不做「最长优先」是刻意的——`as soon as possible`（尽快）不该抢走 `as soon as`（一…就）的释义。
候选枚举见 `phraseCandidates()`，相邻词收集见 `neighborWords()`（段内必须是 `[A-Za-z][A-Za-z'-]*`）。

**分词难点**：`document.caretRangeFromPoint` 只给出字符偏移，词组边界要靠 `textContent` 回推，
因此**规范化**很关键——`normalizePhrase()` 会把不换行空格 `\u00a0`、全角空格、换行、多空格
统一成单空格，剥掉尾部标点，并在首字是冠词（`a`/`an`/`the`）时去掉冠词重试一次，
这样 `a variety of` 与 `variety of` 都能命中。

**在线兜底**：跨域请求统一由 Service Worker 代理（内容脚本受页面 CSP 限制，直接 fetch 会被拦截）。

**响应速度优化（v1.0.3）**：在线翻译从"主通道失败再试备用"的**串行**策略改为**并行竞速**。

| 场景 | 旧实现 | 现在 |
|---|---|---|
| 网络正常 | ~0.3–1s | **~60ms** |
| 主通道慢、备用快 | 等主通道超时 8s 后才试备用 | **~60ms**（取快者） |
| 双通道都不通 | 8s + 8s = **16s** | **~700ms**（超时即返回） |
| 同一词再次悬停 | 重新请求 | **0ms**（命中缓存） |

具体手段：
- **并行竞速**：两条通道同时发起，首个成功的结果立即返回，失败者 abort
- **超时收紧**：单通道 700ms、整体 1000ms（原为各 8s）
- **两级缓存**：后台 LRU 缓存（上限 800 条，跨标签页/iframe 复用）+ 内容脚本缓存
- **请求瘦身**：去掉不用的 `dt=rm` 参数，减小响应体、加快解析
- **加载态延迟 180ms**：网络快时用户直接看到结果，不会被"查询中…"闪一下

失败时**只缓存成功结果**，不会把临时故障固化。气泡角标会标明实际通道（Google / MyMemory）。

**开关状态同步**：所有开关（`enabled` / `onlineFallback` / `showPhonetic` / `showBall` / `hoverDelay`）
一律由各上下文**直接读写 `chrome.storage.sync`**，不经后台中转。这样做的原因：

- Service Worker 在空闲约 30 秒后会被浏览器终止。若开关状态要「内容脚本 → 后台 → storage → 回传内容脚本」绕一圈，
  后台休眠时这条链会断，表现为**点了开关没反应、或刷新后状态回滚**。
- 改直连 storage 后，写入立即落盘，各页面通过 `storage.onChanged` 自动同步，不存在竞态。
- 后台承担三件事：**离线查词**、在线翻译代理、右键菜单/快捷键的事件转发。
  （查词走 `HT_LOOKUP`，词条数查询走 `HT_DICT_INFO`；开关状态**不**走后台。）

**气泡跟随**：`position: fixed` + 鼠标 `clientX/clientY`，每帧更新位置，并做视口边界约束避免溢出。

---

## 已知限制

- **在线兜底依赖公共免费接口**（Google translate 免费端点 / MyMemory）。这些接口无需 Key，但可能不稳定、有频率限制，或在特定网络环境下不可达。此时仅本地词库生效。
- **不支持整句/整段翻译**，定位是「查词」——这正是轻量的前提。
- **本地词库约 11.7 万词条**（单词约 3.1 万 + 词组约 8.6 万），覆盖日常、学术、技术、商务场景。极生僻词、未收录的长词组与最新专业术语仍依赖在线兜底。
- 纯字母词才取词，因此不含数字键名、代码变量名中的下划线组合（如 `user_id` 会取到 `user` 与 `id`）。
- 部分页面（`chrome://`、扩展商店）禁止注入内容脚本，无法使用。

---

## 词库说明

本地查词为**分层结构**，按下列优先级命中：

| 优先级 | 层级 | 文件 | 词条数 | 气泡角标 | 特点 |
|---|---|---|---|---|---|
| 1 | 精选词库 | `dict.js` | 940 | **本地词库** | 手工维护，释义精炼、词性准确；**高于词组** |
| 2 | 词组词库 | `dict-phrase.js` | 85,867 | **本地词库 · 词组** | 常用搭配与短语动词，只有中文释义、无音标 |
| 3 | 扩展词库 | `dict-extra.js` | 30,000 | **本地词库 · 扩展** | ECDICT 按 BNC/COCA 词频筛出，带音标；**低于词组** |

### 分层优先规则（v1.3.0）

当鼠标同时命中「单词」和「词组」时，按下列顺序裁决：

1. 悬停词在**精选词库**里 → **直接返回单词释义**，不看词组
   （例：悬停 `long`，即使处于 `in the long run` 中也显示单词「长的」）
2. 否则**按候选由短到长**逐个尝试词组 → 命中即返回
   （例：悬停 `figure`，候选 `figure out` 命中 → 显示「合计为；计算出；明白」）
3. 词组都没命中 → **回落**到扩展词库单词
   （例：悬停 `procurement`，无相关词组 → 显示「获得；采购」）
4. 全都未收录 → 交给在线兜底通道

> 为什么 core 单词要高于词组：`dict.js` 是手工维护的，释义质量与词性准确度都高于
> 机器提取的词组；而 `dict-extra.js` 只是按词频机械筛选，释义常不如一条精准搭配。
> 因此让 extra 让位给词组、core 不让位，是「质量优先」与「覆盖面优先」的折中。

三级用**不同变量名**（`LOCAL_DICT` / `DICT_PHRASE` / `DICT_EXTRA`）声明。
查询走 `hasOwnProperty`，不会误命中原型链上的 `constructor`、`toString` 等属性。

**三个文件都由 Service Worker 通过 `importScripts` 加载**（顺序：`dict.js` → `dict-extra.js`
→ `dict-phrase.js` → `dict-lookup.js`，最后一个是查词实现，依赖前三者）。内容脚本不加载词库。
调整词库后需在 `chrome://extensions` **重新加载扩展**（后台会重新 importScripts），
而**不必**刷新所有页面——这正是集中持有带来的额外好处。

### 重新生成词组词库

词组从 ECDICT 的 **SQLite 版**（`stardict` 表，340 万词条）提取，比 CSV 版信息更全
（含 `collins` 柯林斯星级、`oxford` 牛津三千词标记，这两者 CSV 版没有）。

```bash
# 1. 下载 SQLite 版（约 216MB zip → 851MB stardict.db）
#    从 GitHub Release 下载最快；raw.githubusercontent 极慢，jsdelivr 拒绝 >20MB 文件
curl -L -o /tmp/ecdict/ecdict-sqlite.zip \
  https://github.com/skywind3000/ECDICT/releases/download/1.0.28/ecdict-sqlite-28.zip
cd /tmp/ecdict && unzip -o ecdict-sqlite.zip

# 2. 生成 dict-phrase.js（含全部通路）
python build-phrases.py

# 3. 校验（形状 / 释义缺失 / 与单词库同名键）
node check-phrase.js && node check-phrase-lookup.js
```

`build-phrases.py` 的提取逻辑（**两条通路**）：

**通路 A · 有质量标记**（满足其一即可）：
- 有音标 `phonetic`，**或**
- 有柯林斯星级 `collins`，**或**
- 有牛津三千标记 `oxford`

> 注意是「或」不是「与」：`as soon as`、`according to`、`a bit` 恰好**没有音标**，
> 但有 `collins`/`oxford` 标记，若要求「与」会全部漏掉。

**通路 B · 无质量标记的常用搭配**（补齐 `out of the blue`、`a variety of` 这类）：
- 无音标、无 collins、无 oxford
- 且 **首段或末段是介词**（约 60 个介词构成的集合）
- 且每段都落在「高频词表」（`bnc`/`frq` 排名前 20000）内
- 且段数 ≤ 5、总长 5–40 字符

> 「首/末段是介词」这个判据是试了四种后才确定的，前三种都被专业术语淹没：
>
> | 判据 | 筛出量 | 抽检结论 |
> |---|---|---|
> | 每段是真实单词 | 627,049 | ✗ 全是 `ab initio method` 这类专业术语 |
> | 每段在高频词表内 | 717,828 | ✗ 仍是实词堆叠 |
> | 含虚词 + 段数 ≤ 5 | 111,812 | △ 好转，仍混入 `ability to pay basis` |
> | **首段或末段是介词** | **32,783** | **✓ 150 条抽检全合格** |
>
> 原理：英语搭配与短语动词几乎都以介词收尾或开头（`account for`、`abstain from`、
> `accede to`、`abreast of`），而专业术语是名词短语、末段必为实词
> （`abandoned coal pillar`），于是被自然排除。

### 重新生成扩展词库

数据源：[ECDICT](https://github.com/skywind3000/ECDICT)（MIT License），约 77 万词条的英汉词典。

```bash
# 1. 下载词库 CSV（约 66MB）
curl -L -o /tmp/ecdict/ecdict.csv \
  https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv

# 2. 生成 dict-extra.js（默认 3 万词）
node build-dict.js /tmp/ecdict/ecdict.csv 30000

# 3. 校验
node test-extra.js
```

`build-dict.js` 的处理逻辑：
- 只保留**纯小写字母**单词（过滤 `-able` 后缀、带撇号、词组、缩写）；长度 2–24
- 按 **BNC 语料库词频**排序（无 BNC 数据时用当代语料库词频 `frq` 兜底）
- 跳过已存在于 `dict.js` 的词，避免重复
- 释义清洗：去 `[网络]`/`[医]` 等标记、去词性前缀、限制 3 个义项 / 60 字
- 词性归一化：`n:12%/v:88%` 取占比最高者
- 输出结构 `word: { t: 释义, p: 词性, k: 音标 }`

### 修改精选词库

编辑 `dict.js`，在对应分类下按格式追加：

```js
newword: { t: "中文释义1；中文释义2", p: "n." },
```

- 键必须是**纯小写字母**，不可重复（后声明会覆盖前者）
- `t` 多个义项用中文分号 `；` 分隔
- `p` 词性，多词性用 `/` 分隔，如 `v./n.`

文件末尾有自检逻辑，会自动剔除含数字等非法字符的键。
`dict-extra.js` 与 `dict-phrase.js` 由脚本生成，**不要手工编辑**——重新运行脚本会覆盖。

---

## 更新日志

### v1.3.0 —— 词组支持

**新增词组词库（85,867 条）**，从 ECDICT SQLite 版 + 短语动词表提取，去重后并入：

- 悬停在 `figure out`、`out of the blue`、`a variety of`、`take advantage of` 等搭配上时，
  自动识别**整条词组**并给出中文释义，角标显示「本地词库 · 词组」
- 单词库不变（精选 940 + 扩展 30,000）；词条总数 **9.4 万 → 11.7 万**

**新增分层优先策略**（三种结局均有真实浏览器验收覆盖）：

| 情形 | 结果 | 例 |
|---|---|---|
| 悬停词在精选词库 | **core 单词胜出**，不看词组 | `long` → 「长的」（而非 `in the long run`） |
| 悬停词只在扩展词库、且命中词组 | **词组胜出** | `figure` → `figure out`「合计为；计算出；明白」 |
| 悬停词在扩展词库、无相关词组 | **回落 extra 单词** | `procurement` → 「获得；采购」 |

**词组匹配按词数由短到长**，不做最长优先（保 `as soon as` 这类核心搭配的释义准确）。

**内存**：词库源文本 3.0 MB → 6.2 MB，SW 堆 9.5 MB（实测不随标签页增长）。
词组库是扁平结构 `{ 词组: { t: 释义 } }`，不存音标，因此内存效率高于同体积的单词库。

**测试**：281 → **330 项**（8 个套件全绿）；`verify-browser.js` 真实 Chromium 验收 30 → **58 项**。
新增 `check-phrase.js` / `check-phrase-lookup.js` 两个词库校验脚本。

### v1.2.1 —— 在线超时抖动修复

- 连字符合成词本地拆词（`decision-maker` / `real-time` / `mother-in-law`），整词查不到时自动拆段，不走网络
- 在线失败自动静默重试一次，超时放宽到 2.5s/3s
- 通道连续失败 2 次后冷却 120 秒，不再陪它耗到超时

### v1.2.0 —— 词库归后台（架构调整）

- 词库从 `content_scripts` 移到 Service Worker，`importScripts` 全局只持有一份
- 内存从「随 frame 线性增长」变为**恒定**（100 frame 场景由 ≈ 879 MB 降到 8.8 MB）
- 查词逻辑收敛到 `dict-lookup.js` 单一实现；popup 改走 `HT_DICT_INFO` 查询词条数
