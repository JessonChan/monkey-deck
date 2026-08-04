# 2026-08-04 mermaid 图回复过程中不断在 streaming/渲染图之间闪烁

## 起因

用户报告:页面有 mermaid 图时,在 agent 回复过程中,mermaid 图会**不断在「streaming(显示源码)」与「渲染好的图」之间切换**。而且**不仅是正在流式中的那条回复**,连**之前已经渲染好的 mermaid 图**也会反复进入 streaming↔渲染 的切换。

## 根因

**App.tsx 给 ChatView 传了内联箭头 `onOpenFile`(`onOpenFile={(path, line) => openFileTab(selectedSessionId, path, line)}`),每次 render 都是新引用。** 这条不稳定引用一路传染,最终导致 react-markdown **反复 remount MermaidRenderer**:

1. ChatView 的 `openFilePreview` 原 `useCallback` 依赖 `[props.onOpenFile]` → 每次 App 重渲染(流式期间每个 chunk 都触发)身份都变。
2. `openFilePreview` 身份变 → **破坏 `ChatRow` 的 `memo`** → 历史消息(包括已渲染好的 mermaid 那条)每个 chunk 都跟着重渲染。
3. ChatRow 重渲染 → `AgentMarkdown` 重渲染 → 其 `components` `useMemo([onOpenFilePreview, streaming])` 重建 → 里面的内联 `pre: (props) => <PreRenderer ... streaming={streaming} />` 是**新函数引用**。
4. React 把「不同函数引用」当作**不同组件类型** → react-markdown **unmount 旧的 `<pre>`/MermaidRenderer,挂载新的**。
5. 新 MermaidRenderer 实例 `phase` 从初始 `idle`(显示源码 = 用户看到的「streaming」态)→ 异步 `renderMermaid` → `success`(显示 SVG)。每个 chunk 来一次 = 不断闪烁。

这就同时解释了「当前流式消息」与「历史已渲染消息」都闪:`components` 重建是**所有 AgentMarkdown 实例**都中招(因为所有 ChatRow 的 memo 都被同一不稳定 `openFilePreview` 击穿)。

> 关键判据:历史 mermaid 显示「streaming(源码)」态 = MermaidRenderer 的 `phase.kind === "idle"`(初始值),这只在**刚 mount** 时出现 → 证明是 remount,不是 re-render。

## 改法

**ChatView 用 ref 持有最新 `onOpenFile`,对外暴露空依赖的稳定 `openFilePreview`:**

```ts
const onOpenFileRef = useRef(props.onOpenFile);
onOpenFileRef.current = props.onOpenFile;
const openFilePreview = useCallback((path, line) => {
  onOpenFileRef.current?.(path, line);
}, []);
```

`openFilePreview` 身份恒定 → `ChatRow` memo 对历史消息成立(不重渲染)→ `AgentMarkdown` 的 `components` 不重建 → react-markdown 不 remount → MermaidRenderer 保持 `success` 不闪。

流式消息本身:streaming 期间 `components` 稳定(`onOpenFilePreview` 稳定 + `streaming=true` 恒定)→ 不 remount → 全程显示源码;streaming 结束 `streaming` 翻 false 时 `components` 重建一次 → remount 一次 → 渲染一次图(符合预期:消息写完才渲染)。

> 这是经典「内联回调破坏 memo / 内联组件类型导致 remount」反模式。ref-backed 稳定回调是标准解法,与项目里 `selectedSessionIdRef`/`openTabsRef` 等「用 ref 读最新值、不进依赖」的既有套路一致。

## 第二个触发点:重新进入 tab(remount,而非 re-render)

用户补充:「只要重新进入 tab 也会触发」。分两种 tab:

- **file/chat tab**(点文件链接切走、再点回 chat tab):ChatView **不卸载**(`.chatview-wrap.is-hidden` = `display:none`,见 App.tsx + index.css)→ 只是 App 重渲染 → **已被上面的稳定回调修复**(ChatRow memo 成立,不 remount)。
- **session tab**(切到别的会话再切回来):`.chat-body` 带 `key={props.sessionId}`,切 session 时 key 变 → React **整体 remount chat-body** → 每个 MermaidRenderer 从零挂载 → `phase` 走 `idle→loading→success`,即使 SVG 已缓存也会闪一下(loading 态可见)。这是 **key-remount**,与上面的 memo-break 是不同机制。

对后者,根治「不让 key 变」会破坏既有的「切 session 重置滚动/窗口」语义,代价大。改用**缓存直渲**:MermaidRenderer 挂载时若 SVG 已缓存,直接以 `success` 起步(lazy `useState` 初始化器同步查缓存),跳过 `idle→loading` 闪烁。

## 改法 2:MermaidRenderer 缓存直渲(消除 remount 闪烁)

- `lib/mermaidRenderer.ts`:新增同步 `getCachedSvg(code)`(与 `renderMermaid` 共用 `cacheKey`,命中返回缓存 SVG);`renderMermaid` 改用同一 `cacheKey`(去重)。
- `components/MermaidRenderer.tsx`:
  - `phase` 用 lazy 初始化器:`!streaming && getCachedSvg(code)` 命中 → 初始即 `success`(挂载首帧就出图,不闪)。
  - effect 加缓存快车:命中 `getCachedSvg` → 直接 `setPhase(success)` 并 `return`,**不走 `loading`、不调 `renderMermaid`**(bindFunctions 缓存不存,可接受,见 svgCache 注释)。
  - 缓存未命中(首次见到的图)仍走原 `loading→renderMermaid→success`。

## 改了哪些文件(汇总)

- `frontend/src/components/ChatView.tsx`:`openFilePreview` 由 `useCallback([props.onOpenFile])` 改为 ref-backed 空依赖稳定回调(含英文注释说明根因)。
- `frontend/src/lib/mermaidRenderer.ts`:新增同步 `getCachedSvg(code)` + 抽出共用 `cacheKey`;`renderMermaid` 复用之。
- `frontend/src/components/MermaidRenderer.tsx`:`phase` 改 lazy 初始化器(缓存命中即 `success` 起步);effect 加缓存快车(命中直接 success,不走 loading、不调 renderMermaid)。
- `frontend/src/components/ChatView.virtual.mount.test.tsx`:加 mermaid 动态 import mock(计 `render()` 次数)+ `__resetMermaidCacheForTest` 导入 + `ChatView mermaid remount stability` 测试(新 `onOpenFile` 身份重渲染 → 不 remount)。
- `frontend/src/components/MermaidRenderer.mount.test.tsx`:`getCachedSvg` 契约测试(渲染前 undefined、渲染后返回 SVG)+ remount 缓存直渲测试(同 code 重挂 → 图仍在、`render()` 不再调用)。

## 验证

- `bunx tsc --noEmit`:通过。
- 新测试**不带修复**:`render()` 被调用 2 次(remount 发生)→ 测试 FAIL,复现 bug。
- 新测试**带修复**:`render()` 仅 1 次(无 remount)→ PASS。
- `bun test src/components/ChatView.virtual.mount.test.tsx`(隔离):**11 pass / 0 fail**(含新测试)。
- 全量 `bun test`:新增测试与既有 10 个 ChatView 虚拟化 mount 测试一样,在**全量套件**里因**预存的 McpChip `mock.module` 跨文件污染**(另一文件的 chatservice mock 泄漏,致 McpChip 抛 `GetSessionMcpServers is not a function`)而 FAIL —— 此污染为**预存问题**(stash 本改动后同样 30 fail),非本次引入,隔离运行均通过。
- `bun test src/components/MermaidRenderer.mount.test.tsx`:**21 pass**(原 19 + `getCachedSvg` 契约测试 + remount 缓存直渲测试),不受 mermaid mock 影响。

## Code review(reviewer agent,APPROVE / confidence 0.9)

两层修复均判定正确、无 patch 引入的回归。两个 P3 非阻塞发现,已处理其一:

- **P3-1(已修)**:`MermaidRenderer` 渲染 effect 的 `cancelledRef`(每次开头重置 + 仅 renderMermaid 分支返回 cleanup)在 code 渲染中途变化时有竞态——旧 code 的 in-flight `renderMermaid` 解析后仍覆盖新 phase。缓存快车分支更甚(不再调度竞争性 render → 旧 SVG 必胜)。已改为 effect 内 **per-invocation 局部 `cancelled`**(仅该次 cleanup 翻 true),旧 in-flight 查到自己的 cancelled→return,不再覆盖。严格更正确。
- **P3-2(保留)**:`currentMermaidTheme()` 在 lazy 初始化器(render 期)走 `getComputedStyle`(`data-theme` 未设、app 固定深色)。读操作、每挂载一次、幂等、无 hydration → 安全;唯一代价是同 commit 挂多个图时 N 次 forced layout。判定可接受(app 固定深色,该路径罕见)。
## 下一步

- 桌面 app 实测:让 agent 产一张 mermaid 图,再连续追问,确认历史 mermaid 图不再闪烁、当前流式消息的 mermaid 只在写完后渲染一次。
- (可选)预存的 mount 测试全量套件 McpChip 污染可单独治理:统一各 mount 测试的 chatservice mock,或给 McpChip 加错误边界。
