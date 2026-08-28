# Lite Webviews · 网页卡片轻量化

An Obsidian desktop plugin that keeps embedded webpages from eating memory and making noise: embeds in Canvas / Excalidraw / web viewer show a static screenshot instead of a live page, load the real page only when you click the card, and auto-mute everywhere.

> [中文说明](#中文说明)见下文。

## Features

- **Auto-mute**: embedded webpages in Canvas, Excalidraw, and web viewer tabs are muted by default (scope is configurable per area).
- **Screenshot mode**: suspended cards show a screenshot and unload the real page, freeing roughly 100–400 MB per card. Click the card to load the real page; dragging never triggers a load.
- **Auto-suspend**: cards switch back to screenshots after you interact with other cards, leave the tab, or switch apps (delays configurable; per-card "keep alive" exempts it).
- **Card actions**: hover the top-right corner of a live card for mute / keep-alive / suspend buttons; right-click a suspended card for load / refresh screenshot / copy screenshot / open in browser.
- **Commands**: toggle screenshot mode, stop all embeds, restore all embeds, keep-alive / suspend / refresh screenshot for the current card — all bindable to hotkeys.
- **Memory & performance**: optional "fully unload on suspend" (kills the renderer process), bounded concurrent background captures, automatic screenshot cache cleanup.
- **UX**: fixed on-screen button size regardless of canvas zoom, adapts to light/dark themes, works in popout windows.

## Installation

### From the community plugin store

Once approved: Settings → Community plugins → Browse → search **Lite Webviews**.

### Via BRAT (before store approval)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. BRAT → Add Beta Plugin → enter `xxblog/Obsidian-Lite-Webviews`.
3. Enable **Lite Webviews** in Settings → Community plugins.

### Manual

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/xxblog/Obsidian-Lite-Webviews/releases).
2. Place them in `<vault>/.obsidian/plugins/lite-webviews/`.
3. Enable the plugin in Settings → Community plugins.

Desktop only (`isDesktopOnly: true`), requires Obsidian 1.1.0+.

## Development

```bash
npm install
npm run dev    # watch mode, rebuilds main.js on change
npm run build  # type-check + production build
```

Source lives in `src/` (TypeScript); `main.js` at the repo root is the build artifact — do not edit it directly.

## Notes

- Screenshots are cached under `.obsidian/plugins/lite-webviews/cache/` (auto-created). If you use Obsidian Sync or another sync tool, exclude that folder to avoid syncing large images.
- Settings are stored in `data.json` in the plugin folder.

---

## 中文说明

这是一个 **Vibe Coding 项目**，主要为我自己的使用而开发。做它是因为我在 Obsidian 画布 / Excalidraw 中放了太多嵌入网页，导致：浏览网页时经常自动出声；很多网页就算不打开也一直占着内存。所以这个插件解决两件事：**自动静音** 和 **截图省内存**。

由于是个人自用项目，功能优先满足我自己的场景，维护节奏随缘，欢迎使用、提 Issue / 反馈 / Fork；长期使用前建议先自己测试。

### 功能特性

- **自动静音**：画布（Canvas）、Excalidraw、网页浏览器标签页中的嵌入网页默认静音，范围可分别配置。
- **截图省内存**：平时只显示截图、页面被卸载（每张释放约 100~400MB）；点击卡片才加载真实网页，拖动不会触发加载。
- **自动挂起**：操作其他卡片、画布空白处或切走应用后自动切回截图（时长可配）；「保活」卡片免疫自动挂起和 `Esc`。
- **卡片操作**：真网页卡片右上角有「静音 / 保活 / 挂起」按钮；挂起卡片右键菜单支持加载网页 / 刷新截图 / 复制截图 / 在浏览器打开。
- **命令**（均可绑定快捷键）：切换截图省内存模式、停止所有嵌入网页、恢复所有嵌入网页、保活/取消保活当前卡片、挂起当前卡片、刷新当前卡片截图。
- **内存与性能**：可选「挂起时彻底卸载」（杀渲染进程）、临时抓图并发限制、截图缓存自动/手动清理。
- **体验**：按钮固定屏幕字号不随画布缩放、自动适配明暗主题、支持弹窗（popout）窗口。

### 使用方式

- 卡片默认显示截图；**单击**加载真网页，**拖动**不会触发。
- 「保活」后自动挂起计时和 `Esc` 不生效，只有点击「挂起」才切回截图。
- 在挂起截图上右键，可刷新截图、复制截图或在浏览器打开。

### 目录说明

```text
.
├── manifest.json   # 插件信息与版本
├── versions.json   # 版本与最低 Obsidian 版本映射（社区市场上架用）
├── main.js         # 构建产物（请勿直接修改）
├── src/            # TypeScript 源码
└── cache/          # 截图缓存（运行时自动生成）
```

截图缓存在 `cache/` 目录，使用 Obsidian Sync 等同步工具时建议排除该目录；插件设置保存在 `data.json`。

## License

[MIT](LICENSE) — 你可以自由使用、修改、分发，包括用于商业项目。
