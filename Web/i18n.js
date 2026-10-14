/**
 * i18n.js — 悬停取词翻译官网 / 访客统计后台 的中英文切换
 *
 * 设计：
 *  - 以「中文原串」为 key 的字典，values 为英文；t(key) 按当前语言返回。
 *  - applyI18n(root) 遍历 DOM 文本节点与 placeholder/title/aria-label 属性完成翻译，
 *    并记录原始中文以便切回中文时还原（不破坏 DOM 结构）。
 *  - 需要内联标签的段落用 data-i18n-html 标记；纯文本块用 data-i18n 标记。
 *  - 语言存 localStorage（同源共享），默认中文。
 *  - 动态内容（后台表格/图表/分页）由页面调用 t() 生成，并通过 onChange 回调在切换时重渲染。
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'ht_lang';
  var DEFAULT_LANG = 'zh';
  var current = DEFAULT_LANG;
  var listeners = [];

  /* ============ 中文 → English（纯文本） ============ */
  var dict = {
    /* ---- 首页：标题 / 导航 ---- */
    "悬停取词翻译 — 鼠标悬停，即时翻译英文单词": "Hover Translate — Instant English word translation on hover",
    "浏览器扩展，鼠标悬停在英文单词或词组上自动显示中文释义。内置 13.4 万条离线词条，移开自动消失，不打断阅读。": "A browser extension that instantly shows Chinese definitions when you hover over English words or phrases. 134K offline entries built in; the bubble fades away without interrupting your reading.",
    "悬停取词翻译": "Hover Translate",
    "功能": "Features",
    "使用方式": "How to Use",
    "常见问题": "FAQ",
    "立即安装": "Install Now",

    /* ---- 首页：Hero ---- */
    "v1.5.0 现已发布 · 生词本 / 发音 / 划词查询": "v1.5.0 released · Vocabulary / Pronunciation / Selection lookup",
    "鼠标悬停，": "Hover your mouse,",
    "即时翻译英文单词": "translate English instantly",
    "看英文文档不必再复制粘贴到翻译网站。停在单词上约 320ms 自动弹出中文释义，移开自动消失——不打断你的阅读节奏。": "No more copying text into translation sites. Rest a word for about 320ms and the Chinese definition pops up automatically, then disappears when you move away — without breaking your reading flow.",
    "下载扩展 (ZIP · 3.1 MB)": "Download Extension (ZIP · 3.1 MB)",
    "安装指南": "Install Guide",
    "Chrome / Edge 兼容": "Works with Chrome / Edge",
    "完全免费开源": "Completely free & open source",
    "本地词库": "Local dictionary",
    "模拟；仿真；假装": "simulation; emulation; pretense",
    "发音": "Pronounce",
    "收藏": "Bookmark",

    /* ---- 首页：数据条 ---- */
    "13.4 万": "134K",
    "内置离线词条": "Built-in offline entries",
    "恒定内存占用": "Constant memory usage",
    "默认触发延迟": "Default trigger delay",
    "生词本容量": "Vocabulary capacity",

    /* ---- 首页：核心功能 ---- */
    "核心功能": "Core Features",
    "为流畅阅读而生的每一个细节": "Every detail, built for smooth reading",
    "从 13.4 万条离线词库到词组智能识别，从恒定内存到在线兜底——每一项都经过真实 Chromium 环境验证。": "From 134K offline entries to smart phrase detection, from constant memory to online fallback — every feature is verified in a real Chromium environment.",
    "悬停即译": "Hover to translate",
    "停一下，释义就来": "Pause for a moment, and the definition appears",
    "鼠标悬停在英文单词或词组上，约 320ms 后自动弹出中文释义气泡，跟随鼠标移动；移开气泡自动消失，完全不打断阅读。": "Hover over an English word or phrase; after about 320ms a Chinese definition bubble appears and follows your cursor. Move away and it disappears — your reading is never interrupted.",
    "同一段落内换词可持续翻译，无需重新触发": "Keep translating other words in the same paragraph without triggering again",
    "鼠标移入气泡可保持显示，方便复制释义": "Move the cursor into the bubble to keep it open and copy the definition",
    "按 Esc 立即关闭，触发延迟 80–900ms 可调": "Press Esc to close it instantly; trigger delay is adjustable from 80–900ms",
    "合计为；计算出；明白": "to work out; to calculate; to understand",

    /* ---- 首页：离线词库 ---- */
    "离线词库": "Offline dictionary",
    "13.4 万词条，离线零延迟": "134K entries, zero-latency offline",
    "内置精选单词 940 条 + 扩展单词 4.74 万条 + 常用词组 8.59 万条，合计 13.4 万条。日常、学术、技术、商务高频词全覆盖，断网也能查。": "Includes 940 curated words + 47.4K extended words + 85.9K common phrases — 134K entries in total. It covers high-frequency everyday, academic, technical and business words, and works even offline.",
    "分层优先：精选词 > 词组 > 扩展词，释义质量优先": "Layered priority: curated words > phrases > extended words, quality first",
    "扩展词库自带音标，本地查询即可显示": "The extended dictionary ships with phonetics, shown in local lookups",
    "词库由 Service Worker 统一持有，只解析一次": "The dictionary is held by a single Service Worker and parsed only once",
    "精选词库": "Curated dictionary",
    "手工维护 · 释义精炼": "Hand-maintained · concise definitions",
    "940 条": "940 entries",
    "词组词库": "Phrase dictionary",
    "常用搭配与短语动词": "Common collocations and phrasal verbs",
    "85,867 条": "85,867 entries",
    "扩展词库": "Extended dictionary",
    "ECDICT 高频词 · 带音标": "ECDICT high-frequency words · with phonetics",
    "47,370 条": "47,370 entries",

    /* ---- 首页：内存恒定 ---- */
    "内存恒定": "Constant memory",
    "开再多标签页，内存也不涨": "Open as many tabs as you like — memory does not grow",
    "词库由后台 Service Worker 统一持有，开多少标签页都只占一份内存。100 个 frame 场景下从约 3.4 GB 降到 9.5 MB，且不随标签页增长。": "The dictionary is held by a background Service Worker, so any number of tabs share one copy. In a 100-frame scenario, memory dropped from about 3.4 GB to 9.5 MB and no longer grows with tabs.",
    "Service Worker 堆恒定 9.5 MB，不随标签页线性增长": "The Service Worker heap stays at 9.5 MB and does not grow linearly with tabs",
    "内容脚本侧 LRU 缓存，同词重复悬停零开销": "LRU cache on the content-script side — zero overhead for repeated hovers",
    "查词逻辑单一实现，避免多份副本": "A single implementation of lookup logic, avoiding duplicate copies",
    "旧方案": "Old approach",
    "现方案": "Current approach",
    "* 100 个 frame 场景下的对比实测": "* Measured in a 100-frame scenario",

    /* ---- 首页：更多能力 ---- */
    "更多能力": "More Capabilities",
    "一个扩展，覆盖查词全场景": "One extension covering every lookup scenario",
    "从在线兜底到生词本，从划词查询到站点黑名单——你需要的都在这里。": "From online fallback to the vocabulary book, from selection lookup to the site blacklist — everything you need is here.",
    "在线兜底": "Online fallback",
    "本地未收录的词自动联网翻译，Google 主通道 + MyMemory 备用通道并行竞速，失败自动重试。": "Words missing locally are translated online: Google as the primary channel and MyMemory as backup race in parallel, with automatic retries.",
    "合成词拆词": "Compound word splitting",
    "decision-maker / real-time / mother-in-law 自动拆段查本地词库，无需联网，角标显示「本地词库 · 组合」。": "decision-maker / real-time / mother-in-law are automatically split and looked up locally with no network needed, marked with a “Local dictionary · compound” badge.",
    "词形还原": "Lemmatization",
    "implementations → implementation、running → run、analyses → analysis，不规则动词表 + 后缀规则双通路。": "implementations → implementation, running → run, analyses → analysis, via an irregular-verb table plus suffix rules.",
    "单词发音": "Word pronunciation",
    "气泡头部小喇叭按钮，点击即朗读当前词条，en-US 发音，语速 0.95，使用浏览器内置 TTS 引擎。": "Click the speaker button in the bubble header to read the current entry: en-US voice, 0.95 speed, using the browser's built-in TTS engine.",
    "划词查询": "Selection lookup",
    "鼠标选中页面文字后自动查询，单词走本地词库，多词走在线通道，气泡对齐到选区下方。": "Select text on a page to look it up automatically: single words use the local dictionary, multiple words use the online channel, and the bubble aligns below the selection.",
    "站点黑名单": "Site blacklist",
    "popup 一键将当前站点加入黑名单，黑名单内自动禁用悬停取词（划词查询豁免），跨设备同步。": "Add the current site to the blacklist in one click from the popup. Hover lookup is disabled there (selection lookup is exempt) and it syncs across devices.",
    "生词本": "Vocabulary book",
    "每次查词命中自动收录，上限 1000 条，支持列表查看、删除、清空、导出 CSV，仅本地存储。": "Every successful lookup is saved automatically, up to 1000 entries, with list view, delete, clear and CSV export — stored locally only.",
    "隐私可控": "Privacy control",
    "关闭在线兜底后完全离线，不发出任何网络请求。生词本仅存本地，不上传任何服务器。": "Turn off online fallback to run fully offline with no network requests. The vocabulary book is stored locally and never uploaded.",
    "三种开关": "Three ways to toggle",
    "悬浮球点击 / 右键菜单 / 快捷键 Alt+Shift+T，随心切换。悬浮球位置可拖动并记住。": "Toggle via the floating ball, the context menu, or the Alt+Shift+T shortcut. The floating ball is draggable and remembers its position.",

    /* ---- 首页：使用方式 ---- */
    "三步上手，即装即用": "Three steps to get started",
    "安装完成后，无需任何配置即可开始使用。": "No configuration needed — start using it right after installation.",
    "打开英文网页": "Open an English web page",
    "访问任意英文网站（如 Wikipedia、技术文档、英文新闻），刷新页面确保内容脚本注入。": "Visit any English site (e.g. Wikipedia, technical docs, English news) and refresh to make sure the content script is injected.",
    "悬停查词": "Hover to look up",
    "将鼠标停在任意英文单词或词组上，约 320ms 后释义气泡自动出现。移开鼠标，气泡自动消失。": "Rest the cursor on any English word or phrase; after about 320ms the definition bubble appears. Move away and it disappears.",
    "生词本复习": "Review in the vocabulary book",
    "查过的词自动收录到生词本，点击工具栏图标打开 popup 即可查看、导出 CSV 或清空，方便后续复习。": "Looked-up words are saved to the vocabulary book; click the toolbar icon to open the popup and view, export to CSV or clear it for later review.",

    /* ---- 首页：安装 ---- */
    "下载并安装扩展": "Download and install the extension",
    "免费、开源、无广告。下载 ZIP 后按下方步骤加载到浏览器即可。": "Free, open source and ad-free. Download the ZIP and follow the steps below to load it into your browser.",
    "GitHub 源码": "GitHub Source",
    "解压下载的 ZIP": "Extract the downloaded ZIP",
    "打开扩展管理页": "Open the extensions page",
    "开启开发者模式": "Enable Developer mode",
    "点击右上角的「开发者模式」开关，使其处于开启状态。": "Turn on the “Developer mode” toggle in the top-right corner.",
    "加载已解压的扩展": "Load the unpacked extension",
    "点击「加载已解压的扩展程序」，选择第 1 步解压后的文件夹，完成安装。": "Click “Load unpacked” and select the folder extracted in step 1 to finish the installation.",
    "安装后刷新已打开的英文网页，鼠标悬停到单词上即可使用。建议将扩展固定到工具栏。": "After installing, refresh any open English pages and hover over words to use it. Pinning the extension to the toolbar is recommended.",

    /* ---- 首页：FAQ ---- */
    "你可能想知道的": "Things you might want to know",
    "悬停不出气泡怎么办？": "What if no bubble appears on hover?",
    "多数情况是装完扩展后没有刷新页面——内容脚本只在页面加载时注入，已打开的页面不会自动获得脚本。按 F5 刷新即可。另外，chrome://、edge://、扩展商店页等受限页面禁止注入内容脚本，这是浏览器硬限制，请换普通网站（如 en.wikipedia.org）测试。": "In most cases the page was not refreshed after installing the extension — the content script is only injected on page load, so already-open pages do not get it automatically. Just press F5 to refresh. In addition, restricted pages such as chrome://, edge:// and the extension store forbid content-script injection; this is a hard browser limit, so please test on a normal site (e.g. en.wikipedia.org).",
    "本地词库能覆盖多少单词？": "How many words does the local dictionary cover?",
    "合计 13.4 万条：精选单词 940 条（手工维护）+ 扩展单词 47,370 条（ECDICT 高频词，带音标）+ 常用词组 85,867 条。覆盖日常、学术、技术、商务高频词。极生僻词和最新术语依赖在线兜底。": "134K entries in total: 940 curated words (hand-maintained) + 47,370 extended words (ECDICT high-frequency words, with phonetics) + 85,867 common phrases. It covers high-frequency everyday, academic, technical and business words. Very rare words and the latest terminology rely on online fallback.",
    "在线兜底翻译会泄露我的查词内容吗？": "Does online fallback leak what I look up?",
    "在线兜底使用 Google 免费端点和 MyMemory 公共接口，无需注册和 API Key。如果你对隐私有要求，可以在设置中关闭「在线兜底翻译」，此后扩展完全离线运行，不发出任何网络请求。生词本数据仅存储在本地 chrome.storage，不上传任何服务器。": "Online fallback uses Google's free endpoint and the public MyMemory API — no sign-up or API key required. If you care about privacy, you can turn off “Online fallback translation” in the settings, after which the extension runs fully offline with no network requests. The vocabulary book is stored only in local chrome.storage and never uploaded to any server.",
    "为什么有些词组只翻译了一部分？": "Why are some phrases only partially translated?",
    "词组按词数由短到长匹配。例如悬停 out of the blue 中的 blue，会先命中较短的 out of。这是有意为之——短搭配（as soon as、account for）本身就是合法释义单元。若想看到完整词组，把鼠标停在词组的最后一个词上即可。": "Phrases are matched from short to long. For example, hovering over blue in out of the blue first matches the shorter out of. This is intentional — short collocations (as soon as, account for) are valid translation units on their own. To see the full phrase, rest the cursor on its last word.",
    "支持哪些浏览器？": "Which browsers are supported?",
    "支持 Chrome 和 Edge（基于 Chromium 的浏览器），使用 Manifest V3 规范。需要浏览器版本支持 Service Worker 和 chrome.storage API。Firefox 暂未官方适配。": "Chrome and Edge (Chromium-based browsers) are supported, using the Manifest V3 spec. The browser version must support Service Worker and the chrome.storage API. Firefox is not officially supported yet.",
    "生词本的数据会丢失吗？": "Will my vocabulary book data be lost?",
    "生词本存储在 chrome.storage.local，仅本地保存。上限 1000 条，超出后淘汰最旧记录。你可以随时在 popup 中导出为 CSV 文件备份。卸载扩展会清除本地数据，建议定期导出。": "The vocabulary book is stored in chrome.storage.local, locally only. The limit is 1000 entries, beyond which the oldest records are dropped. You can export it to a CSV file for backup from the popup at any time. Uninstalling the extension clears local data, so regular exports are recommended.",

    /* ---- 首页：页脚 ---- */
    "产品": "Product",
    "资源": "Resources",
    "版本": "Version",
    "安装": "Install",
    "ECDICT 词库": "ECDICT Dictionary",
    "鼠标悬停英文单词或词组，即时显示中文释义。内置 13.4 万条离线词条，移开自动消失，不打断阅读。": "Hover over an English word or phrase to instantly see the Chinese definition. 134K offline entries built in; the bubble fades away without interrupting your reading.",
    "© 2026 悬停取词翻译 · 开源免费": "© 2026 Hover Translate · Open source & free",
    "使用 ECDICT (MIT) 词库数据": "Uses ECDICT (MIT) dictionary data",

    /* ---- 后台：登录 ---- */
    "访客统计后台 · 悬停取词翻译": "Visitor Analytics · Hover Translate",
    "访客统计后台": "Visitor Analytics",
    "仅站点管理员可访问，访客无法看到此页面。": "Accessible only to site admins. Visitors cannot see this page.",
    "管理口令": "Admin password",
    "请输入管理口令": "Enter admin password",
    "登 录": "Sign in",
    "退出登录": "Sign out",

    /* ---- 后台：卡片 ---- */
    "今日访问量 PV": "Today's page views (PV)",
    "自然日 00:00 起（北京时间）": "Since 00:00 (Beijing time)",
    "今日独立访客 UV": "Today's unique visitors (UV)",
    "按 IP 去重": "Deduplicated by IP",
    "累计访问量 PV": "Total page views (PV)",
    "自有记录以来": "Since records began",
    "累计独立访客 UV": "Total unique visitors (UV)",

    /* ---- 后台：图表 / 明细 ---- */
    "访问趋势": "Traffic trend",
    "日": "Day",
    "周": "Week",
    "月": "Month",
    "年": "Year",
    "最近 7 天": "Last 7 days",
    "最近 30 天": "Last 30 days",
    "最近 12 个月": "Last 12 months",
    "访客明细": "Visitor details",
    "搜索 IP / 归属地 / 浏览器…": "Search IP / location / browser…",
    "搜索": "Search",
    "每页": "Per page",
    "20 条": "20 rows",
    "50 条": "50 rows",
    "200 条": "200 rows",
    "1000 条": "1000 rows",
    "访问时间": "Time",
    "归属地（国家 / 省 / 市 / 区县）": "Location (country / province / city / district)",
    "运营商": "ISP",
    "设备": "Device",
    "浏览器 / 系统": "Browser / OS",
    "来源": "Referrer",
    "路径": "Path",
    "首页": "First",
    "上一页": "Prev",
    "下一页": "Next",
    "末页": "Last",
    "第": "Page",
    "页": "",

    /* ---- 后台：动态串（模板，供 t() 使用） ---- */
    "管理员 · {date}": "Admin · {date}",
    "访问趋势 · {title}（区间 PV {pv} / UV {uv}）": "Traffic trend · {title} (range PV {pv} / UV {uv})",
    "共 {total} 条记录，当前第 {page} / {pages} 页，每页 {size} 条": "{total} records, page {page} / {pages}, {size} per page",
    "所选时间段内暂无访问记录": "No visits in the selected period",
    "暂无符合条件的访客记录": "No matching visitor records",
    "爬虫": "Bot",
    "爬虫/机器人": "Bot / robot",
    "手机": "Phone",
    "平板": "Tablet",
    "未知": "Unknown",
    "直接访问": "Direct visit",

    /* ---- 后台：提示 / 服务端消息 ---- */
    "请输入口令": "Please enter the password",
    "登录中…": "Signing in…",
    "登录失败": "Sign-in failed",
    "口令错误": "Incorrect password",
    "请求失败": "Request failed",
    "未登录或登录已过期": "Not signed in or the session has expired",
    "服务器错误": "Server error",
    "服务器内部错误": "Internal server error",
    "接口不存在": "Endpoint not found",
    "禁止访问": "Access denied",
    "请求体过大": "Request body too large",
    "JSON 格式错误": "Invalid JSON format",
    "方法不允许": "Method not allowed",
    "服务器返回了非 JSON 响应（HTTP {status}）": "The server returned a non-JSON response (HTTP {status})"
  };

  /* ============ 中文 → English（含内联标签的 HTML 段落，按 slug 索引） ============ */
  var htmlDict = {
    "guideStep1": "Extract the downloaded <code>hover-translate-extension.zip</code> to any folder (remember the path).",
    "guideStep2": "Type <code>chrome://extensions</code> in the Chrome address bar (or <code>edge://extensions</code> in Edge)."
  };

  var ATTRS = ['placeholder', 'title', 'aria-label'];

  /* ============ 工具 ============ */

  function getStored() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }
  function store(l) {
    try { localStorage.setItem(STORAGE_KEY, l); } catch (e) { /* ignore */ }
  }

  function interpolate(s, vars) {
    if (!vars) return s;
    return String(s).replace(/\{(\w+)\}/g, function (m, k) {
      return vars[k] != null ? String(vars[k]) : m;
    });
  }

  /** 按当前语言翻译纯文本（支持 {var} 插值）；未知原串原样返回 */
  function t(str, vars) {
    var out = str;
    if (current === 'en' && dict[str] != null) out = dict[str];
    return interpolate(out, vars);
  }

  /** 翻译服务端返回的时间范围标题（如 “最近 7 天”“2026-10-14 按小时”） */
  function tTitle(s) {
    if (current !== 'en') return s;
    if (dict[s] != null) return dict[s];
    return String(s).replace(/按小时$/, 'by hour');
  }

  function replaceTrimmed(raw, trimmed, en) {
    var i = raw.indexOf(trimmed);
    if (i < 0) return en;
    return raw.slice(0, i) + en + raw.slice(i + trimmed.length);
  }

  /* ============ 文本 / 属性翻译 ============ */

  function translateTextNode(node) {
    var raw = node.nodeValue;
    if (!raw) return;
    var trimmed = raw.trim();
    if (!trimmed) return;
    if (current === 'en') {
      if (dict[trimmed] != null) {
        if (node.__htzh == null) node.__htzh = raw;
        node.nodeValue = replaceTrimmed(raw, trimmed, dict[trimmed]);
      }
    } else if (node.__htzh != null) {
      node.nodeValue = node.__htzh;
      node.__htzh = null;
    }
  }

  function walkText(root) {
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var n;
    while ((n = tw.nextNode())) translateTextNode(n);
  }

  function walkAttrs(root) {
    var els = root.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      for (var a = 0; a < ATTRS.length; a++) {
        var an = ATTRS[a];
        if (!e.hasAttribute(an)) continue;
        var val = e.getAttribute(an);
        var tv = val.trim();
        if (!tv) continue;
        var slot = '__htzh_' + an;
        if (current === 'en') {
          if (dict[tv] != null) {
            if (e[slot] == null) e[slot] = val;
            e.setAttribute(an, replaceTrimmed(val, tv, dict[tv]));
          }
        } else if (e[slot] != null) {
          e.setAttribute(an, e[slot]);
          e[slot] = null;
        }
      }
    }
  }

  function applyMarked(root) {
    var nodes = root.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (current === 'en') {
        if (el.__htzh == null) el.__htzh = el.textContent;
        el.textContent = t(el.getAttribute('data-i18n'));
      } else if (el.__htzh != null) {
        el.textContent = el.__htzh;
        el.__htzh = null;
      }
    }
    var htmlNodes = root.querySelectorAll('[data-i18n-html]');
    for (var j = 0; j < htmlNodes.length; j++) {
      var h = htmlNodes[j];
      var key = h.getAttribute('data-i18n-html');
      if (current === 'en') {
        if (h.__htzh == null) h.__htzh = h.innerHTML;
        h.innerHTML = htmlDict[key] != null ? htmlDict[key] : (dict[key] != null ? dict[key] : h.innerHTML);
      } else if (h.__htzh != null) {
        h.innerHTML = h.__htzh;
        h.__htzh = null;
      }
    }
  }

  /** 翻译 <head> 中的 title / description */
  var headOrig = {};
  function applyHead() {
    var tEl = document.querySelector('title');
    if (tEl) {
      if (headOrig.title == null) headOrig.title = tEl.textContent;
      tEl.textContent = current === 'en' ? (dict[headOrig.title.trim()] || headOrig.title) : headOrig.title;
    }
    var mEl = document.querySelector('meta[name="description"]');
    if (mEl) {
      if (headOrig.desc == null) headOrig.desc = mEl.getAttribute('content') || '';
      var d = headOrig.desc;
      mEl.setAttribute('content', current === 'en' ? (dict[d.trim()] || d) : d);
    }
  }

  /** 对指定子树应用当前语言（默认 document.body） */
  function applyI18n(root) {
    root = root || document.body;
    if (!root) return;
    applyMarked(root);
    walkText(root);
    walkAttrs(root);
  }

  /* ============ 语言切换器 ============ */

  function updateSwitcher() {
    var sw = document.getElementById('langSwitch');
    if (!sw) return;
    var btns = sw.querySelectorAll('button[data-lang]');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-lang') === current;
      if (on) btns[i].classList.add('on'); else btns[i].classList.remove('on');
    }
  }

  function buildSwitcher() {
    var sw = document.getElementById('langSwitch');
    if (!sw || sw.__htBound) return;
    sw.__htBound = true;
    if (!sw.querySelector('button[data-lang]')) {
      sw.innerHTML = '<button type="button" data-lang="zh">中</button>' +
        '<button type="button" data-lang="en">EN</button>';
    }
    sw.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('button[data-lang]') : null;
      if (!b) return;
      setLang(b.getAttribute('data-lang'));
    });
  }

  /* ============ 对外 API ============ */

  function setLang(l) {
    current = (l === 'en') ? 'en' : 'zh';
    store(current);
    document.documentElement.setAttribute('lang', current === 'en' ? 'en' : 'zh-CN');
    buildSwitcher();
    updateSwitcher();
    applyHead();
    applyI18n(document.body);
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](current); } catch (e) { /* ignore */ }
    }
  }

  function init() {
    current = getStored() === 'en' ? 'en' : DEFAULT_LANG;
    document.documentElement.setAttribute('lang', current === 'en' ? 'en' : 'zh-CN');
    buildSwitcher();
    updateSwitcher();
    applyHead();
    applyI18n(document.body);
  }

  global.I18N = {
    t: t,
    tTitle: tTitle,
    applyI18n: applyI18n,
    setLang: setLang,
    toggle: function () { setLang(current === 'en' ? 'zh' : 'en'); },
    getLang: function () { return current; },
    lang: function () { return current; },
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
