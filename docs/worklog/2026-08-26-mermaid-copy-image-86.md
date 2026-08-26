# 2026-08-26 Mermaid 复制为图片:样式内联 + 2x 光栅化 + ClipboardItem 分流降级下载(#86 / Task #24326)

## 起因

issue #86:mermaid 图表目前只能复制源码/看图,用户想把图直接贴进聊天/文档——需要「复制为图片」。任务规格四件套:**mermaidExport 样式内联 + 2x 光栅化 + ClipboardItem 分流降级下载 + i18n**。

## 设计

新增 `frontend/src/lib/mermaidExport.ts`(命名对齐既有 `mermaidRenderer.ts`),三段流水线:

1. **buildStandaloneSvg(样式内联)**:SVG 经 `<img>` 解码时**页面 CSS 不生效**,直接光栅化会丢页面注入的字体/颜色。做法:DOMParser 解析 → clone → 藏匿挂载(off-screen `position:fixed; left:-99999px` + `.mermaid-svg-host` class 复现页面 CSS 上下文,不用 `display:none`——部分引擎会把 resolved 值清空)→ 逐元素把 `getComputedStyle` 的**绘画属性白名单**(fill/stroke/font-*/text-anchor 等 23 项,刻意排除布局属性)写进 style 属性 → 剥掉 live view 的适配样式(max-width/zoom width),钉上显式像素 width/height + xmlns(WKWebView/WebView2 对无显式尺寸的 SVG blob 会解成 0×0)。尺寸取 viewBox 优先(mermaid 的 width="100%" 不可靠),viewBox API 缺失时解析属性字符串兜底,百分比属性拒绝(`parseFloat("100%")=100` 的坑,单测复现)。
2. **rasterizeSvgToPng(2x)**:blob URL → Image 解码 → canvas `ctx.scale(2,2)` 绘制 → `toBlob("image/png")`。绘制前先按主题填背景(dark=#1e1e1e,与 `darkThemeVariables.background` 同源导出 `themeBackground`):深色主题图导出透明底贴到白色目标时浅色文字会隐形。基边钳制 8192px(canvas 引擎上限)。
3. **copyImageWithClipboardFallback(分流)**:有 `ClipboardItem` + `navigator.clipboard.write` → 把 **PNG 的 promise 本体**塞进 ClipboardItem 构造(Safari 要求构造发生在用户手势窗口内,不能 await 后再传;光栅化的同步段已在 onClick 内先行)。write 成功 → `copied`;write 被拒/无该 API(Firefox 无 ClipboardItem、锁死 webview 拒 write)→ **降级下载 PNG**(`downloadBlob`,文件名 `mermaid-YYYYMMDD-HHMMSS.png`)→ `downloaded`;光栅化 promise 失败 → `failed`。永不 throw,tri-state 驱动按钮反馈。

Wails3 runtime 的 Clipboard 只有 `SetText`/`Text`(`node_modules/@wailsio/runtime/dist/clipboard.js` 实证),无图片通道——桌面 webview 只能走 `navigator.clipboard.write`,这正是降级路径存在的原因。

## 改法(UI)

- `MermaidRenderer.tsx`:新增 `useMermaidImageCopy`(busy/copied/downloaded/failed/idle 五态 + 2s 自动复位)与 `CopyImageButton`(ImageDown/Check/Download/X/旋转 RefreshCw 图标切换,md-tip tooltip 随状态换文案)。inline(success 视图,非看源码时)与 fullscreen modal 头部各一枚,独立反馈实例;testid `mermaid-copy-image` / `mermaid-fs-copy-image`。
- `download.ts`:抽 `downloadBlob(blob, filename)`,`downloadText` 改为其薄封装(既有调用点零改动)。
- `mermaidRenderer.ts`:导出 `themeBackground`(dark 与 darkThemeVariables.background 同源,防漂移)。
- i18n:`chat.mermaidCopyImage` / `mermaidImageCopied` / `mermaidImageDownloaded` / `mermaidImageCopyFailed` 中英四键(locales.test 键集合同步不变量覆盖)。

## 改了哪些文件

- `frontend/src/lib/mermaidExport.ts`(新):导出流水线。
- `frontend/src/lib/mermaidExport.test.ts`(新):12 例——svgNaturalSize(viewBox 优先/属性兜底/百分比拒绝)、buildStandaloneSvg(尺寸钉死+xmlns+剥 max-width、样式内联[patch getComputedStyle]、非 SVG/无尺寸 → null)、copyImageWithClipboardFallback 六分支(copied[断言 ClipboardItem 收到 promise 本体]/write 拒→下载/无 ClipboardItem→下载/promise 拒→failed/双拒→failed/裸 Blob 兼容)。
- `frontend/src/lib/download.ts`:`downloadBlob` 抽取。
- `frontend/src/lib/mermaidRenderer.ts`:`themeBackground` 导出。
- `frontend/src/components/MermaidRenderer.tsx`:`useMermaidImageCopy` + `CopyImageButton`,inline/fullscreen 接线。
- `frontend/src/components/MermaidRenderer.mount.test.tsx`:mock `../lib/mermaidExport.ts`(真模块依赖 canvas,hermetic 环境跑不了)+6 例(流式不显示/点击传 SVG 且 tooltip 翻 copied/downloaded/failed/fullscreen 独立实例不串扰)。
- `frontend/src/i18n/locales/{en,zh}.json`:四键。

## 验证

- 定向:`bun test --isolate src/lib/mermaidExport.test.ts src/components/MermaidRenderer.mount.test.tsx` → **38 pass / 0 fail**。
- 全量:`bun run test`(即 `bun test --isolate`)→ **349 pass / 0 fail**(39 文件;worktree 现场跑 `wails3 task bindings` 补齐不入库的 bindings 后全绿)。
- TS/构建:`bun run build` → 零 TS 错误(手动 `wails3 gen bindings` 的 .js 格式与 `wails3 task build` 的 `-ts` 严格格式**双格式**下均验证;踩坑见 2026-08-26 语音 P3 worklog);`wails3 task build` → exit 0(icon.ico 副产物已还原)。
- Go gate:`go build ./...` + `go vet ./...` → clean(无 Go 改动)。
- 三端(§4.7):改动为纯前端组件/纯函数 lib,无传输分支/断点/指针交互变化,三端同一代码路径。**待真机/真实引擎实测**:canvas 光栅化与 ClipboardItem 写入是 happy-dom 覆盖不了的真引擎行为——macOS WebKit(WKWebView 里 `navigator.clipboard.write` 是否被允许,决定桌面端走 copied 还是 downloaded 分支)、远程浏览器(Chromium 大概率直接 copied)、PWA(iOS Safari 手势窗口 promise 形态)。两条分支都有反馈文案,不会静默。

## 踩坑/备忘

- `parseFloat("100%") === 100`:宽度属性兜底若不排除 `%` 会把百分比当像素尺寸(单测先红后修)。
- bun `mock.module` 相对路径按「调用文件的相对形态」解析,测试与被测模块同目录时 `./download.ts`/`../lib/mermaidExport.ts` 可对上,组件 mock 需在 `import` 组件**之前**注册。
- 本地跑全量必须 `bun run test`(`--isolate`):裸 `bun test` 共享 worker 全局态,bindings 缺失的报错会污染无关文件(包括新加的文件)。
- **中断重放**:本任务首次完成后(worktree 内两个 commit),执行环境被重置到基线(`8cd559b`)——commit、新文件、node_modules、bindings 全部消失,靠对话上下文逐文件重放 + 全套验证重跑。断点续跑先 `git status`/`git log` 核对再动手(同 2026-08-26 语音 P3 worklog 的教训,已第二次发生)。

## 下一步

- 真机清单:macOS 桌面 WKWebView 实测「复制为图片」实际落在哪条分支;Chromium/iOS PWA 各验一次。
- 若实测发现 WKWebView 拒绝图片剪贴板成为常态,可评估 Wails3 侧补原生图片剪贴板 binding(Go 侧写 NSPasteboard/剪贴板),当前下载降级已可用。
