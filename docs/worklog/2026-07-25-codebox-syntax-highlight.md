# 2026-07-25 CodeBox 接入 highlightToLines 语法高亮(copy 保持纯文本 + 流式可用)

## 起因

Task #23061。对话内 markdown 代码块(``` 围栏)由 `CodeBox` 渲染,但此前只把 `raw`
当纯文本塞进 `<pre><code>`,没有语法高亮。而项目里已经有现成的高亮基础设施:

- `lib/highlight.ts` 的 `highlightToLines`(Task #15088,highlight.js + github-dark),
  被 `CodeViewer`(文件预览)逐行渲染。
- `hljs-theme.css` 引入 `highlight.js/styles/github-dark.css` 并收口块级外观。

CodeBox 与 CodeViewer 的高亮需求同源(都是「把源码按语言着色」),理应复用同一能力,
而不是各自维护一套或让对话代码块继续裸奔。

## 改法

`CodeBox`(ChatView.tsx)接入 `highlightToLines`,与 CodeViewer 同源:

- `useMemo(() => highlightToLines(raw, { language }), [raw, language])` —— 显式 fence language
  优先,未命中走 `highlightAuto`(由 lib/highlight 内部处理)。
- 渲染:`<code className="code-box-code hljs" dangerouslySetInnerHTML={{ __html: lines.join("\n") }} />`。
  `lines` 是「按行切分、每行 span 平衡」的高亮片段;`join("\n")` 在 `<pre>` 的
  `white-space: pre` 下还原为多行,跨行 token(块注释/模板串)颜色在每行正确延续
  (不变量来自 lib/highlight 的 `splitHtmlByLine`)。
- 头部语言标签:`{detected || language}` —— 有 fence 语言时 `detected === language`;
  无 fence 时显示 auto-detect 命中语言(改进:原来无 fence 一律显示 "code")。
- **copy 保持纯文本**:`navigator.clipboard.writeText(raw)` 不变 —— 永远写原始源码,
  不取高亮后的 HTML(用户复制的是可运行代码,不是带 span 的片段)。
- **流式可用**:`highlightToLines` 对不完整代码安全(不抛错、降级转义),`useMemo` 随
  `raw` 每次变化重算 → 边到边高亮,无需等 turn 结束。highlight.js 同步快,典型代码块
  开销可忽略;与 CodeViewer 同一特性(CV 也是每次 content 变全量重算)。

CSS(`hljs-theme.css`):新增 `.code-box-code.hljs` 去块化覆盖(透明背景 + 零内边距),
镜像已有的 `.cv-code.hljs`。github-dark 默认给 `.hljs` 加 `background/padding`(为独立
`<pre><code>` 设计),不清掉会与 `.code-box` 的 `#161617` 底色产生接缝、并多出一层 padding。
token 配色(`.hljs-keyword` 等)沿用主题,跨平台 webview 一致(§4.6)。

ChatView 显式 `import "../hljs-theme.css"`:虽然 CodeViewer 已在 bundle 图里把它带入全局
CSS(Vite 去重),但显式导入让 CodeBox 自洽 —— 日后 CodeViewer 若被拆 / 懒加载,CodeBox
不会丢主题。

`dangerouslySetInnerHTML` 安全性:注入的是 highlight.js 产出的受限 HTML(仅 `<span class>`
+ 文本),非任意来源;与 CodeViewer 同一既有口径(§5.3 尊重数据源)。

## 改了哪些文件

- `frontend/src/components/ChatView.tsx`:
  - 新增 `import { highlightToLines } from "../lib/highlight"` 与 `import "../hljs-theme.css"`。
  - `CodeBox`:用 `highlightToLines` 算高亮行 + `dangerouslySetInnerHTML` 渲染;头部标签改显
    `detected || language`;copy 保持 `raw`。
- `frontend/src/hljs-theme.css`:新增 `.code-box-code.hljs` 去块化覆盖。
- `docs/worklog/2026-07-25-codebox-syntax-highlight.md`:本条。

## 验证

- `bun install` + `wails3 generate bindings`(bindings 不入库,补齐后才能跑 tsc)。
- `bun run build`(= `tsc && vite build --mode production`):**通过**(tsc 无错;仅既有
  chunk 体积告警,非本次引入)。
- `bun test`:**118 pass / 0 fail**(含既有 QueuePanel.reorder 等挂载测)。
- 视觉抽验待实机:`wails3 dev` 观察对话里 go/ts/json 等代码块着色、跨行注释颜色延续、
  无 fence 块头部显示检测到的语言、copy 按钮贴出的是纯文本、流式过程中代码块边到边着色
  不闪烁/不报错。

## 下一步

- 实机抽验上述视觉项(macOS WebKit)。
- 若后续发现大代码块流式高亮有可感卡顿,再考虑「流式期间降级为纯文本、turn 结束再高亮」
  的优化(当前不预先做,§3.1 / KISS)。
