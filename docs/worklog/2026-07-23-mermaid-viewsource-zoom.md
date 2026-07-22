# 2026-07-23 feat:MermaidRenderer 加查看源码 toggle + zoom(按钮缩放/重置/ctrl滚轮)(Task #22115)

## 起因
Task #22115:已渲染成功的 mermaid 图,用户想①查看/复制原始源码(此前 success 态只显示 SVG,
拿不到源码);②放大看清细节或缩小纵览大图。原实现 success 态只渲染 SVG、无任何缩放交互,
大图被 `max-width:100%` 压扁,细节看不清;源码也只有 streaming/error 态才可见。

## 改法
两块新增功能,均只在 `success` 态启用(streaming/loading/error 路径完全不变,KISS):

1. **查看源码 toggle**:
   - success 头部新增 `Code2` 图标按钮(`mermaid-src-toggle`),点击在「SVG 图 ↔ 源码 `<pre>`」之间切换。
   - 切到源码态时复用既有 `.mermaid-src-pre`(与 streaming/error 回退同款),复制按钮始终在头部。
   - `MermaidHeader` 加 `children?: ReactNode` 槽位,把交互按钮插在「复制」左侧(包成 `.mermaid-head-actions`)。
   - 新一轮渲染(`code`/`streaming` 变化触发 effect)时重置 `viewSource=false` + `zoom=1`,回到默认图视图。

2. **zoom(按钮 + Ctrl/⌘ 滚轮)**:
   - 缩放模型:按 SVG **自然宽度**(取自 `viewBox.width`,兜底 `width` 属性 / 容器宽度)为基准,
     `zoom=1` = `min(自然宽, 容器宽)`(等价原 `max-width:100%` 适配);`zoom>1` 时 SVG 实际变宽,
     容器 `overflow:auto` 自然出滚动条。
   - 三个按钮:放大(`ZoomIn`)/ 缩小(`ZoomOut`)/ 重置(`RotateCcw`,tooltip 带当前百分比)。
     步长 0.2,clamp 到 `[0.3, 3]`,触界 `disabled`。
   - `Ctrl`/`⌘` + 滚轮:步长 0.1,`addEventListener("wheel", …, {passive:false})` 才能 `preventDefault`
     阻止浏览器页面缩放(原生 React `onWheel` 是 passive,拦不住)。
   - `ResizeObserver` 监听容器宽度变化(侧栏折叠 / 窗口缩放),重算基准保持 `zoom=1` 始终「适配」;
     测试环境无此 API 时降级为仅初始应用(不崩)。
   - 不用 `transform: scale()` —— 那需要额外算滚动尺寸/变换原点,跨平台 webview 行为不一致;
     改 `width` 让浏览器原生 overflow 处理,简单且跨平台一致(AGENTS.md §4.6)。

## 改了哪些文件
- `frontend/src/components/MermaidRenderer.tsx`:
  - 加 `viewSource` / `zoom` state + 两个 effect(zoom 应用 + wheel 监听);
  - success 头部加 toggle / zoom 控件按钮 + 源码视图分支;
  - `MermaidHeader` 加 `children` 槽 + `.mermaid-head-actions` 包裹;
  - 渲染 effect 重置交互态;`ResizeObserver` 有无降级。
- `frontend/src/index.css`:`.mermaid-head-actions`(按钮组排版)+ `.msg-action-btn:disabled*`(禁用态样式)。
- `frontend/src/i18n/locales/{zh,en}.json`:`chat.mermaidViewSource` / `mermaidViewDiagram` /
  `mermaidZoomIn` / `mermaidZoomOut` / `mermaidZoomReset`。
- `frontend/src/components/MermaidRenderer.mount.test.tsx`:新增 5 个 mount 测试(toggle 切换、
  按钮缩放、重置、clamp+disable、ctrl 滚轮),全部通过。

## 验证
- `wails3 generate bindings` 生成 bindings 后 `bun run build`(`tsc && vite build`):**全绿**(无类型错误)。
- `bun test`:**92 pass / 0 fail**(其中 MermaidRenderer 文件 14 pass,含本次新增 5 例)。
  - happy-dom 的 `WheelEvent` 构造器不消费 `init.ctrlKey`(真实浏览器会),测试用
    `Object.defineProperty(ev, "ctrlKey", {value:true})` 显式补上,测的是组件逻辑不是 happy-dom 行为。
  - 测试用 `.mermaid-svg-host` / `.mermaid-src-pre` class 断言而非 `svg` 标签 —— 避免误匹配按钮里的 lucide 图标 SVG。
- `go build ./... && go vet ./...`:全绿(Go 侧无改动;仅有 macOS 链接器版本警告,环境性,与本次无关)。

## 下一步 / OPEN
- 桌面 app 实测(Wails3 server 模式可辅助):① 大图放大后横向滚动是否顺滑;② Ctrl+滚轮在
  WebKit(macOS)/ WebView2(Win)都正常阻止页面缩放;③ 侧栏折叠时 `ResizeObserver` 是否即时回 `适配`。
- 缩放后 SVG 内可点击节点(若 mermaid 有交互图)的事件是否仍正常 —— `bindFunctions` 已在 SVG 挂载时
  绑定,缩放只改 `width` 不重建 DOM,理论上不受影响,留待有交互图时验证。
