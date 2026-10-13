# 悬停取词翻译 v1.5.0 发布说明

发布日期：2026-10-13

## 概述

v1.5.0 在 v1.4.0（词库后台集中持有 + 词组查询）基础上，新增四项用户可感知功能：站点黑名单、单词发音（TTS）、划词查询、生词本。全部功能经真实 Chromium 环境加载验证。

## 新增功能

### 1. 站点黑名单
- popup 新增「在此站点停用」按钮，一键将当前站点加入黑名单
- 黑名单列表展示在 popup 中，可逐个移除
- 黑名单站点的悬停取词自动禁用（划词查询豁免，设计如此）
- 存储于 `chrome.storage.sync.disabledSites`，跨设备同步

### 2. 单词发音（TTS）
- 气泡头部新增发音按钮（小喇叭图标），点击即朗读当前词条
- 英文发音 `en-US`，语速 0.95
- 需在 manifest 中声明 `tts` 权限（已加入）
- popup 新增「显示发音按钮」开关，默认开启

### 3. 划词查询
- 鼠标选中页面文字后自动查询（50ms 防抖）
- 单词走本地词库，多词走在线通道
- 气泡对齐到选区下方
- popup 新增「启用划词查询」开关，默认开启
- 站点黑名单不影响划词（豁免）

### 4. 生词本 / 查词历史
- 每次查词命中（本地或在线）自动收录到生词本
- 存储于 `chrome.storage.local.ht_history`，仅本地，不上传任何服务器
- 上限 1000 条，超限淘汰最旧；同一词重复查询自动去重并置顶
- popup 新增生词本面板：列表（词/音标/释义）、刷新、删除单条、清空（二次确认）
- 支持导出 CSV（UTF-8 BOM，Excel 可直接打开中文）

## 技术要点

- 生词本落盘在后台 Service Worker 统一完成，跨标签页/iframe 去重一致
- 任何存储异常均捕获并降级为 `console.warn`，不影响查词主流程
- 离线查询 / 在线翻译成功后才落盘，失败结果不污染历史
- 数据完整性：未改动 v1.4.0 已有的 8 个 sync 配置键（enabled/onlineFallback/showPhonetic/showTts/enableSelection/hoverDelay/showBall/disabledSites）

## 验证情况（全部真实测试，非模拟）

| 验证项 | 结果 |
|---|---|
| 单元/集成测试（8 套件） | 366 / 366 通过 |
| 真机 Chromium 加载验证 | 26 / 26 通过 |
| Shadow DOM 穿透真机验证 | 10 / 10 通过 |
| SW 版本号 / tts 权限 / storage.local | 真实读数确认 |
| 悬停气泡 + 发音按钮 + 点击 | 真实 DOM + chrome.tts 确认 |
| 划词查询 | 真实鼠标拖拽选区确认 |
| 生词本落盘 / popup 渲染 / 删除联动 | 真实 storage 读数确认 |
| 站点黑名单禁用 / 恢复 | 真实页面行为确认 |

## 版本号同步

以下四处均已更新为 1.5.0：
- `manifest.json` → `"version": "1.5.0"`
- `package.json` → `"version": "1.5.0"`
- `background.js` → `HT_BG_VERSION = "1.5.0"`
- `content.js` → `HT_VERSION = "1.5.0"`

## 安装

- 已解压加载：`chrome://extensions` → 开发者模式 → 加载 `dist-hover-translate/`
- crx 安装包：`dist-hover-translate.crx`（3.1 MB，含签名密钥 `hover-translate.pem`，后续更新需用同一密钥）

## 兼容性

- Chrome / Edge（MV3）
- 无新增 host 权限；新增 `tts` 权限（发音功能必需）
