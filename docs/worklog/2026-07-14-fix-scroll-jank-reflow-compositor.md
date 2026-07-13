# 2026-07-14 fix:对话滚动掉帧 —— 消除 onScroll 强制 reflow + 合成层提升

## 起因
用户报长会话滚动掉帧(jank)。任务建议排查 DOM 节点过多 vs CSS reflow。

## 诊断:jank 来源是 CSS reflow,不是 DOM 节点数
- **DOM 节点数已被解决**:2026-07-02 已对 `.row / .thought-block / .tool-card / .tool-group` 启用
  `content-visibility: auto` + `contain-intrinsic-size: auto 120px`(浏览器原生虚拟化,见
  `docs/worklog/2026-07-02-content-visibility-render-opt.md`)。该决策是在 react-virtuoso 与
  自实现虚拟化**双双失败**后做出的(动态高度测量 → atBottomStateChange 恒 false / 滚动条跳动)。
  因此**不重新引入 JS 虚拟化**——违反既有决策与 §5.3(KISS / Less is More / 原生方案优先)。
- **真正的 jank 源**:`ChatView` 的 `onScroll` 在**每个滚动事件**里同步读 `el.scrollHeight`。
  `scrollHeight` 依赖完整内容布局,读取会触发**同步强制布局(layout thrashing)**;叠加
  `content-visibility`,滚动时元素进出「relevant to user」区域需解算 containment,`scrollHeight`
  解算更贵。每个滚动帧都做这件事 → 掉帧。
- 次要源:滚动容器 `.chat-body` 与带大面积模糊 `box-shadow` 的 sticky `.scroll-bottom-btn`
  未提升到独立合成层,滚动时阴影在主线程重绘(WebKit 尤甚,呼应 index.css:108 关于 sticky
  + 重绘元素在 WebKit 滚动抖动的既有注释)。

## 改法(对应任务分支 #3:CSS 致 jank → transform/will-change 提升合成层 + 消除 reflow)
仅前端,`frontend/src/components/ChatView.tsx` + `frontend/src/index.css`。

1. **缓存 `scrollHeight`,滚动事件不再同步读**(`scrollHeightRef`):在 `useLayoutEffect`
   (items 变化 / 切 session / prepend)与 `ResizeObserver`(容器 resize)里刷新;
   `onScroll` 用缓存值算「是否贴底」。`scrollTop / clientHeight` 在无 DOM 变更时不强制布局,读取廉价。
   - **自愈兜底**:若 `scrollTop + clientHeight > 缓存 scrollHeight`(不可能成立的条件 → 缓存过时,
     内容增长了),才读真实 `scrollHeight` 修正。纯滚动不触发 → 不付解算代价。覆盖折叠块展开 /
     图片加载等不触发 items/resize 的内容增长场景。
2. **rAF 合批 `onScroll`**:一帧内多个 scroll 事件只处理一次,杜绝布局抖动。卸载时 `cancelAnimationFrame`。
3. **`setShowScrollBtn` 仅在翻转时 setState**:用 `setShowScrollBtn(prev => prev===目标? prev : 目标)`,
   避免每帧无谓 setter 调用。
4. **合成层提升(CSS)**:`.chat-body { will-change: scroll-position }` 把滚动交给合成线程;
   `.scroll-bottom-btn { will-change: transform }` 把 sticky FAB 的模糊阴影隔离到独立层,滚动时整层平移不再重绘。

## 滚动行为保持不变(任务要求 #4)
- **新消息到达滚到底**:`useLayoutEffect` 依赖 `[items, ...]`,items 变化时若 `stickToBottomRef` 为真则
  `scrollTop = scrollHeight`;且每次 items 变化都刷新 `scrollHeightRef` → 流式/新消息**始终用新鲜缓存**。
- **用户上滚不强制跳底**:`onScroll` 把 `stickToBottomRef` 置假后,useLayoutEffect 不再贴底。
- 切 session 恢复记忆位置、prepend(load more)高度差补偿、footer resize 贴底重对齐 —— 逻辑全保留,
  仅把其内的 `prevHeightRef.current = el.scrollHeight` 同时写入 `scrollHeightRef`。

## 改了哪些文件
- `frontend/src/components/ChatView.tsx`:新增 `scrollHeightRef` / `scrollRafRef`;重写 `onScroll`
  (rAF + 缓存 + 自愈 + 仅翻转 setState);`useLayoutEffect` 三处赋值点 + `ResizeObserver` 同步刷新
  `scrollHeightRef`;新增卸载取消 rAF 的 effect。
- `frontend/src/index.css`:`.chat-body` 加 `will-change: scroll-position`;`.scroll-bottom-btn`
  加 `will-change: transform`。

## 验证
- `wails3 generate bindings` → `cd frontend && bun run build`(tsc + vite build)✅,无类型/编译错误。
- `go build ./...` / `go vet ./...` / `go test ./...` 全绿(仅改前端,Go 旁证不受影响)。
- 滚动行为(贴底跟随 / 上滚不打断 / 切 session 恢复 / load more 补偿 / footer resize)逻辑未改路径,仅换了高度数据来源。

## 下一步
- 实机 `wails3 dev` 验证长会话滚动流畅度(尤其 macOS WebKit),并确认 FAB 显隐 / 流式贴底 / 切会话恢复无回归。
