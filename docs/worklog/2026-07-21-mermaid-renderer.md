# 2026-07-21 实现 Mermaid 渲染(MermaidRenderer + PreRenderer 接入 + 失败回退 + 流式时机 + 动态加载/hash 缓存/主题同步)

## 起因
Task #21289:让对话里 agent / user 写的 ` ```mermaid ` 代码块直接渲染成 SVG 图(而非当作普通代码块只显示源码)。
monkey-deck 的对话主体是 `ReactMarkdown` + 自定义 `PreRenderer`,在 pre 节点拦截 `language-mermaid` 即可路由到 mermaid 渲染。

## 设计(参考 AGENTS.md §4.6 / §5.3)

要点拆开讲,因为每条都对应一个踩坑预防:

1. **成熟库优先**:用 [`mermaid`](https://www.npmjs.com/package/mermaid) 11.x(事实标准),不自研。
2. **动态加载**:`import("mermaid")` 只在首次出现 mermaid 代码块时触发,模块级 Promise 缓存复用。
   mermaid 体积大(打包后约 600KB+,且会拉 dagre / cytoscape / katex 等子模块),不动态加载会严重拖累首屏。
   `bun run build` 验证:mermaid 系列被正确切成 `mermaid.core-*.js`、`sequenceDiagram-*.js` 等独立 chunk,
   `index-*.js` 主包不含 mermaid(只在 `MermaidRenderer` 触发时按需加载)。
3. **hash 缓存**:同源码 → 同 SVG,模块级 `Map<theme:hash, svg>` 缓存,跨组件实例 / 滚动虚拟化复用,
   避免每次切会话/重挂载都重渲(图布局算法不便宜)。
4. **主题进 key + 主题同步**:mermaid 的颜色被烤进 SVG,主题切换时旧 SVG 必须失效,故 key = `${theme}:${hash}`。
   `currentMermaidTheme()` 三级探测:`documentElement.dataset.theme`(预留未来主题开关)
   → 按 body 实际计算背景亮度判定(与 CSS 主题实现解耦)→ 兜底 `dark`(当前应用是深色,见 `index.css :root`)。
5. **streaming 期间不渲染**:agent 消息流式追加时 ` ```mermaid ` 围栏可能不完整,反复尝试渲染 = 浪费 CPU + 闪烁报错。
   `MermaidRenderer` 收到 `streaming=true` 时跳过 `renderMermaid`,直接显示源码(让用户看到图在被写),
   `streaming` 翻 false 才触发渲染。`AgentMarkdown` 透传 `item.streaming`(用户消息不走流式,默认 false)。
6. **失败回退**:`renderMermaid` 内部 catch 所有异常,返回 `{ ok: false, error }`;组件回退到「源码 + 错误提示」展示,
   绝不把异常吞掉或把 `{...}` JSON 直接抛给用户(AGENTS.md §4.4)。
7. **bindFunctions**:mermaid 的交互事件绑定回调(accessibility / 点击),通过 `useEffect` 在 SVG 容器挂载后调用一次。

## 改法

新增 / 改动文件:
- **新增** `frontend/src/lib/mermaidRenderer.ts`:动态加载 + initialize + hash 缓存 + 主题同步 + render 封装。
  导出 `renderMermaid(code) → Promise<{ok, svg} | {ok:false, error}>`、`currentMermaidTheme()`、`__resetMermaidCacheForTest()`。
- **新增** `frontend/src/components/MermaidRenderer.tsx`:React 组件,4 状态机(idle / loading / success / error),
  streaming/idle/error 都展示源码(success 才展示 SVG),可复制源码,完整 `data-testid`(mermaid-diagram / mermaid-fallback / mermaid-loading / mermaid-source / mermaid-error-msg / copy-mermaid)。
- **改** `frontend/src/components/ChatView.tsx`:
  - `import MermaidRenderer`
  - `PreRenderer` 加 `streaming?` prop;`language-mermaid` / `language-mmd` 路由到 `<MermaidRenderer code raw streaming />`,其他走原 `CodeBox`。
  - `AgentMarkdown` 加 `streaming` prop,透传到 `PreRenderer`;`useMemo` deps 加 `streaming`。
  - `ChatRow` agent 分支调 `<AgentMarkdown … streaming={item.streaming} />`。
- **改** `frontend/src/index.css`:`.mermaid-box` / `.mermaid-head*` / `.mermaid-svg-host` / `.mermaid-src-pre` / `.mermaid-error-msg` / `.mermaid-loading` / `@keyframes mermaid-spin`。视觉与 `.code-box` 同源(同底色 #161617、发丝边、头条)。
- **改** `frontend/src/i18n/locales/{zh,en}.json`:`chat.mermaidDiagram` / `chat.mermaidWriting` / `chat.mermaidLoading` / `chat.mermaidRenderFailed`。
- **改** `frontend/package.json` + `bun.lock`:`mermaid@11.16.0` 依赖。

## 验证
- `cd frontend && bun run build` —— 通过(tsc + vite production build 全绿)。
  mermaid 被切成独立 chunk(mermaid.core / dagre / cytoscape / katex / 各 diagram 类型),主包不含 mermaid,验证动态加载生效。
- `bun run test` —— 48 pass / 0 fail(既有测试未受影响)。
- `go build ./... && go vet ./...` —— 全绿(Go 侧无改动,确认未误碰)。
- 桌面 server 模式手动验证留给后续(本任务只动前端,build 通过即可)。

## 下一步 / OPEN
- **server 模式实测**:用一个含 ` ```mermaid ` 的 prompt 让 agent 输出图,确认:流式期间显示源码、turn 结束切到 SVG、reload 后 SVG 正常出、错误语法走 fallback。
- **主题切换联动**:目前应用是固定深色,`data-theme` 探测路径尚未被实际使用;未来若加主题开关,记得给 `document.documentElement.dataset.theme` 赋值即可联动。
- **图过大自适应**:目前 SVG 用 `max-width:100%; height:auto`,超宽图横向滚动;若出现严重溢出再考虑 pan/zoom。
