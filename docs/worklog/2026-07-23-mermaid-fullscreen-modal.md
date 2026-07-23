# 2026-07-23 mermaid 全屏 modal(Task #22945)

## 起因
MermaidRenderer success 状态只有 inline 的 zoom(放大/缩小/重置 + Ctrl 滚轮),大图在小卡
片里看不清细节。需要一个「全屏」入口,把图放大到接近视口尺寸查看,并能继续缩放。

## 设计
- success 工具栏加「全屏」按钮(Maximize2 图标),打开 modal overlay。
- **复用 Task #22115 的 zoom 机制,不抄第二份**。把原 inline 里的三段 zoom 逻辑(bindFunctions
  调用 / width 适配 / Ctrl 滚轮)抽成 `useMermaidZoom` hook,三个按钮抽成 `ZoomControls`
  组件;inline 视图与 fullscreen modal 各起一个 hook 实例 → **独立 zoom 状态**(互不影响),
  但效果代码只有一份,避免漂移。
- modal 形态复用既有 `.preview-overlay` 风格(深色遮罩 + 居中卡片 + fadeIn),但用独立 class
  `.mermaid-fs-*`(更大 max-width 1200px / max-height 90vh / SVG 宿主 min-height 60vh)。
- 关闭方式三选一(对齐 §4.2 / FilePreviewOverlay):Esc 键、点遮罩、关闭按钮。卡片内
  `stopPropagation` 防误关。
- **testid 加前缀区分两处 zoom 控件**:inline=`mermaid-zoom-*`,modal=`mermaid-fs-zoom-*`,
  避免同文档重复 testid 让测试选择器误选(§4.2 的精神:用稳定 id 而非文本/位置)。
- i18n:`chat.mermaidFullscreen`(en=Fullscreen / zh=全屏);关闭按钮复用 `common.close`。

## 改了哪些文件
- `frontend/src/components/MermaidRenderer.tsx`:抽 `useMermaidZoom` + `ZoomControls`;主组件
  success 分支加全屏按钮 + 条件渲染 `MermaidFullscreen`(新组件:独立 zoom + Esc + 遮罩关闭)。
  新图渲染时 `resetKey=code` 自动重置 inline zoom。
- `frontend/src/i18n/locales/{en,zh}.json`:加 `chat.mermaidFullscreen`。
- `frontend/src/index.css`:加 `.mermaid-fs-overlay/.mermaid-fs-card/.mermaid-fs-stage` 样式
  (z-index 45,高于 preview-overlay 40、低于 react-tooltip 70)。
- `frontend/src/components/MermaidRenderer.mount.test.tsx`:加 6 个 fullscreen 测试
  (开/关按钮、遮罩点击、Esc、zoom 独立性 + 初始 100%)。

## 验证
- `bun test src/components/MermaidRenderer.mount.test.tsx` → 19 pass(6 新 + 13 旧)。
- `bun test`(全量)→ 118 pass。
- `npm run build`(tsc + vite)→ clean(MermaidRenderer 无类型错误)。
- `go build ./... && go vet ./...` → clean(Go 侧未改,验收闸门仍过)。

## 下一步
- 可选:modal 内加「下载 SVG」入口(当前未要求,推迟)。
- 跨平台实测(§4.6):macOS WebKit 下 backdrop-filter / 大 SVG 滚动表现需在桌面 app 确认
  (server 模式是 Chromium,本次只在 happy-dom + tsc 验证)。
