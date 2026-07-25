# 2026-07-25 Mermaid .mermaid-box + 文件预览 .preview-card 加 resize:both

## 起因

Task #23063。两类卡片——对话里的 Mermaid 图表块(`.mermaid-box`)与文件预览
弹层(`.preview-card`,被 `FilePreviewOverlay` / `FilePanel` 共用)——尺寸此前是写死的:

- `.mermaid-box` 没有显式宽高,完全随内容(SVG / 源码 pre)撑开,用户没法手动控制图表
  区域大小(放大图想看更多 / 收小腾地方都做不到)。
- `.preview-card` 有 `max-width: 900px; max-height: 80vh` 的硬上限,看长 / 宽文件时被卡死。

桌面客户端前有人,完全可以让用户自己拖右下角调大小,与 wesight / openwork 同类产品形态一致。

## 改法

CSS 改动(`frontend/src/index.css`),纯样式、零逻辑:

1. **`.mermaid-box`** 加 `resize: both; min-width: 240px; min-height: 140px`。
   - `overflow: hidden` 已满足 resize 要求(`resize` 仅在 `overflow ≠ visible` 生效)。
   - 内层 `.mermaid-svg-host` 自带 `overflow: auto` 处理 SVG 缩放后的滚动,外层拉伸只改外框。
2. **`.preview-card`** 加 `resize: both; min-width: 360px; min-height: 220px`,
   并**去掉 `max-width: 900px; max-height: 80vh`**(任务要求「突破 max-width/height」)。
   - 自然兜底:`.preview-overlay` 是 `position: fixed; inset: 0; padding: 40px`,卡片再大也
     不会冲出视口;`width: 100%` 作初始值铺满 overlay 内容盒,用户拖动后转为显式像素。
   - 内层 `.preview-pre` / `CodeViewer` 各自 `overflow: auto`,外层 resize 触发 CodeViewer 的
     `ResizeObserver` 重算可见行(虚拟化天然适配)。
3. **resize 把手可见化**:`.mermaid-box::-webkit-resizer, .preview-card::-webkit-resizer`
   画两条对角发丝纹(`var(--sep-strong)`)。
   - WebKit(macOS)/ WebView2(Win)默认把手在深色底(`#161617` / `var(--elev)`)上几乎看不见,
     这是 §4.6 跨平台一致性的已知坑——必须显式画。
   - `::-webkit-resizer` 同时覆盖三个 Wails3 webview 目标(macOS WebKit、Win WebView2=Chromium、
     Linux WebKitGTK),无需 Firefox 兼容(桌面不走 Firefox)。

不变量:`resize` 不改 DOM 结构、不改数据流,纯 CSS。两处卡片初次渲染外观不变(初始尺寸等同
改前),只有用户主动拖才会变。

## 改了哪些文件

- `frontend/src/index.css`:
  - `.mermaid-box` 加 `resize: both; min-width: 240px; min-height: 140px`(拆多行 + 注释)。
  - `.preview-card` 去掉 `max-width/max-height`,加 `resize: both; min-width/min-height`
    (拆多行 + 注释)。
  - 新增 `.mermaid-box::-webkit-resizer, .preview-card::-webkit-resizer` 对角纹把手规则。
- `docs/worklog/2026-07-25-mermaid-preview-resize.md`:本条。

## 验证

- `bun install` + `wails3 generate bindings`(bindings 不入库,补齐后 tsc 才能找到模块)。
- `bun run build`(= `tsc && vite build --mode production`):**通过**(仅既有 chunk 体积告警,
  非本次引入)。
- `bun test`:**118 pass / 0 fail**(既有用例,本次纯 CSS 不动测试覆盖面)。
- 视觉抽验待实机:`wails3 dev` 跑起来观察——Mermaid 块右下角拖动缩放、文件预览弹层拖大
  超过原 900px/80vh、两处右下角都能看到对角纹把手(macOS WebKit 优先;Win WebView2 抽检)。

## 下一步

- 实机抽验上述视觉项。
- 若后续想要「记住上次尺寸」(同会话内多张图统一),再考虑把尺寸持久化进 SQLite
  config——当前不预先做(§3.1 / KISS),用户每次开弹层 / 看新图回到默认尺寸是合理基线。
