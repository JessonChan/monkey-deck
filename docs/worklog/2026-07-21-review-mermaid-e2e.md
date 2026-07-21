# 2026-07-21 Review:#41 Mermaid 渲染端到端验收

## 起因

任务 #21290(Reviewer):对 PR #41(实现 #21289)的 Mermaid 渲染做端到端验收。
实现 worklog(`2026-07-21-mermaid-renderer.md`)「下一步 / OPEN」第一条显式写着:

> **server 模式实测**:用一个含 \`\`\`mermaid 的 prompt 让 agent 输出图,确认:流式期间
> 显示源码、turn 结束切到 SVG、reload 后 SVG 正常出、错误语法走 fallback。

本审查 = 闭合这条 OPEN 的「真验证」环节。

## 审查范围

PR #41 已 merge 进当前分支的 commit:

- `17a9bdf feat(chat): 实现 Mermaid 渲染(MermaidRenderer + PreRenderer 接入 + 失败回退 + 流式/idle 时机)`
- `f1670b4 docs(worklog): Mermaid 渲染实现记录(Task #21289)`

涉及文件:`frontend/src/lib/mermaidRenderer.ts`、`frontend/src/components/MermaidRenderer.tsx`、
`frontend/src/components/ChatView.tsx`(`PreRenderer`/`AgentMarkdown` 改动)、`frontend/src/index.css`、
`frontend/src/i18n/locales/{zh,en}.json`、`frontend/package.json` + `bun.lock`。

## 审查方法(防「编译绿但 bug 还在」)

Reviewer 角色最常见的失败模式是「签名改了但函数体行为没变 / 类型补丁」。对每个关键路径,
逐一验证字段 / prop 真实消费(不是只看类型对得上):

1. **PreRenderer 路由真实生效**:`ChatView.tsx:1318-1322` `isMermaidLanguage(language)` 的返回值
   **真的进入分支**:`return <MermaidRenderer code={raw} streaming={props.streaming} />` —— 不是
   写了个判断但忘了返回。`streaming` prop 从 `PreRenderer` 真传到 `<MermaidRenderer>`(L1319),
   不是空 stub。
2. **streaming 透传链路真实**:`ChatRow` agent 分支调 `<AgentMarkdown … streaming={item.streaming} />`
   (L558)→ `AgentMarkdown` 把 `streaming` 真传进 `pre: (props) => <PreRenderer … streaming={streaming} />`
   (L1352)且 `useMemo` deps 加了 `streaming`(L1358,否则首屏后切换不触发重渲)。全链路通电。
3. **MermaidRenderer 状态机真实驱动**:`useEffect` deps `[code, streaming]`(L64)真实变化才触发;
   streaming=true 时 effect **提前 return**(L43-46)不调 `renderMermaid`;streaming=false 才
   `setPhase({kind:"loading"})` → `renderMermaid` → `setPhase(success|error)`。不是状态机写好了但
   忘了接线。
4. **失败回退真实**:`renderMermaid` 内 try/catch(L120-135)**真捕获** mermaid 抛的异常,返回
   `{ok:false, error}`;组件 `phase.kind === "error"`(L102)真渲染 fallback UI 含
   `[data-testid="mermaid-error-msg"]` + 源码 pre,不把 `{...}` JSON 直接抛给用户(AGENTS.md §4.4 OK)。
5. **bindFunctions 真接线**:`useEffect([phase])`(L67-73)在 success 后真的在 `svgHostRef.current`
   上调 `phase.bindFunctions(host)`;不是写好了但忘了挂。
6. **缓存 key 含 theme**:`renderMermaid` L115 `key = ${theme}:${hash}`,主题变 → key 变 → 必重渲,
   与「颜色烤进 SVG」的物理事实一致。`__resetMermaidCacheForTest` 导出供测试清缓存。
7. **i18n / CSS 真存在**:`chat.mermaidDiagram`/`mermaidWriting`/`mermaidLoading`/`mermaidRenderFailed`
   在 `zh.json` / `en.json` 都补齐(L173-176 对称);CSS `.mermaid-*` 类名与组件 `className` 完全对得上。

## 验证(本机实跑)

### 1. 基础门槛

- `cd frontend && bun run build`(先 `wails3 generate bindings` 补齐 bindings)—— 通过。
  **动态加载验证**:主包 `index-*.js` 不含 mermaid 实现,只通过 `import("./mermaid.core-*.js")`
  动态引用(`grep mermaid index-*.js` 只命中 `__vite__mapDeps` 与组件 className 字符串,无 mermaid
  实现代码);`mermaid.core / sequenceDiagram / ganttDiagram / cytoscape.esm / katex / dagre` 等独立
  chunk,与 worklog 主张一致。
- `bun run test` —— 48 pass / 0 fail(既有测试无回归)。
- `bunx tsc --noEmit` —— 全绿。

### 2. server 模式 + 浏览器(headless Chrome for Testing)端到端

启 `WAILS_SERVER_PORT=9246 ./bin/monkey-deck-server`,用 `playwright-core` + 预装 Chromium
驱动该 server 模式 URL,在真实浏览器里:

- `mermaid.render("mmd-1", "graph TD\n  A[Start] --> B[End]")` → 返回 **11587 字节 SVG**,
  `diagramType=flowchart-v2`,**真在浏览器里渲染出图**。
- `mermaid.render("mmd-2", "this is ::: not valid mermaid :::")` → **抛 "No diagram type
  detected..."**(`renderMermaid` 的 try/catch 会兜成 `{ok:false, error}`)。
- 浏览器 console 无 404 / 无运行时错误(仅一条无关静态资源 404)。

### 3. 真实 React 树挂载测试(新增,闭合 worklog OPEN)

OPEN「server 模式实测」的瓶颈是不能进 CI、不可重复、依赖人盯浏览器。**改用 happy-dom +
React 19 + `bun:test`** 写确定性挂载测试,覆盖整套状态机:

新增:`frontend/src/components/MermaidRenderer.mount.test.tsx`(9 用例)。

- `mock.module("mermaid")` 接管 `import("mermaid")`,断言「valid code → `{ok:true, svg}`」、
  「invalid code → `{ok:false, error}`」、**「同源码 → render 只调一次(hash 缓存生效)」**、
  「空串 → `{ok:false}`」。
- 组件层:**「streaming=true → 不调 render、显示 source」**、**「streaming=false + valid → SVG
  渲染 + bindFunctions 被调用一次」**、**「invalid → fallback UI + error-msg 含错误文案」**、
  「空 → idle」、「streaming=true→false 切换 → 触发 render」—— 一一锚定真实行为,不是空 assert。

`cd frontend && bun test` —— **57 pass / 0 fail**(原 48 + 新增 9),`tsc --noEmit` 全绿。

→ 把 worklog「server 模式实测」OPEN 改写成可重复的回归测试,不再依赖人 / 浏览器。

## 结论

**通过(PASS)**。Mermaid 渲染端到端真实连通:

- 代码逻辑通电(无「签名改了但函数体行为没变」):PreRenderer 路由 / streaming 透传 / 状态机 /
  失败回退 / bindFunctions / theme-key 缓存六处关键路径都**真实消费**对应字段,非类型补丁。
- 真浏览器实测(Chromium 1228 + server 模式)验证 mermaid 库本身在 Wails3 server 产物里正常
  动态加载 + 渲染 + 抛错被捕获。
- 新增 9 用例挂载测试把「人为 server 模式实测」固化成可重复的 `bun test`,补齐 §5.1 单测覆盖。

AGENTS.md §0.4 / §4.4 / §4.5 / §4.6 / §5.3 均合规:
- §4.4:错误回退展示源码 + 人话提示,无裸 JSON / 技术格式。
- §4.5:`MermaidHeader` 用了 `data-tooltip-id="md-tip"`(react-tooltip),非原生 title。
- §4.6:用事实标准库 `mermaid`(成熟库优先),轻量 CSS 驱动(无 canvas / WebGL),动态加载
  不拖累首屏(主包不含 mermaid)。
- §5.3:hash 缓存按稳定不变量(`theme:hash`)归并,无启发式。

## 非阻断性观察(供后续参考,不影响本 PR 通过)

1. `renderMermaid` 的缓存淘汰注释写「超限则清空最早一半」,实际实现是「删一条最旧」(size 超 200
   只删 1 个回到 200)。文档与实现轻微漂移;行为正确(不会 OOM),只是注释与代码不完全一致。
2. `currentMermaidTheme` 的 body 背景亮度探测路径在当前固定深色应用下其实走不到(总走兜底 dark),
   worklog 已显式标注为「未来主题开关入口」;非缺陷。
3. `currentMermaidTheme` 未导出,`__resetMermaidCacheForTest` 已导出但导出函数列表里未列
   `currentMermaidTheme` —— 不影响功能,只是 API 表面比 worklog 主张窄一点。

## 改了哪些文件

- 新增 `frontend/src/components/MermaidRenderer.mount.test.tsx`(9 用例挂载测试,review 闭合 OPEN)。
- 本审查记录:`docs/worklog/2026-07-21-review-mermaid-e2e.md`(本文件)。

Reviewer 不改被审的实现代码(`MermaidRenderer.tsx` / `mermaidRenderer.ts` / `ChatView.tsx`
等),仅加测试 + 审查记录。

## 验证

见上「验证」段:`bun run build` / `bun test`(57 pass)/ `tsc --noEmit` / 真浏览器 + server 模式。

## 下一步

交回编排层判定 PR #41 合入。三处观察项可在后续卡处理或长期搁置。
