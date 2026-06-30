# 2026-06-30 fix:对话历史随按键向上滚动 —— footer 撑高压低 chat-body

## 起因
用户报「有时候对话历史会随着按键自动向上滚动」。

## 根因
`.chat-body` 是 `flex:1; overflow-y:auto`(`index.css:251`),可视高度由 flex 兄弟 `.chat-footer`(含 Composer)决定。Composer 的 textarea 每次按键(`value` 变)跑 `autoGrow`,从 `min-height:52px` 撑到最高 `220px`(`Composer.tsx:85-89`、`index.css:526-531`;`resize:none` 无内部滚动 → 撑高外层)→ footer 抬高、压低 chat-body 的 `clientHeight`。贴底状态下底部最新消息被抬高的输入框遮挡 → 视觉表现为「历史随按键向上滚」。

`stickToBottomRef` 只在 `onScroll`(`scrollTop` 变化)更新(`ChatView.tsx:76-83`),而 footer 撑高改的是 `clientHeight`,**不触发 onScroll** → 没有任何机制在 footer 高度变化时把视口重新贴底。全部 `scrollTop` 赋值点(`ChatView.tsx:94/97/107/114`)无一在按键路径 → 确认是布局挤压,非 JS 显式滚动。

- **为何「有时候」**:只在 textarea 高度真变化(换行、多行、粘贴)时;单行短词不变高不触发。
- **为何方向「向上」**:底部最新被遮挡,视野剩更早内容,主观即「向上滚」。

## 改法
`ChatView.tsx` 加 `useEffect` + `ResizeObserver` 监听 chat-body:高度变化时若处于贴底(`stickToBottomRef.current === true`)则 `scrollTop = scrollHeight` 重新对齐。顺带覆盖 usage-bar 出现、queue 面板出现等所有 footer 变高场景;非贴底(用户翻历史)不动,不打扰。`deps:[props.sessionId]` 保证切会话重挂载 chat-body 后重新 observe。

## 改了哪些文件
- `frontend/src/components/ChatView.tsx`(import 加 `useEffect`;useLayoutEffect 后新增 ResizeObserver useEffect)。

## 验证
`bun run build:dev`(tsc + vite build)✅(332 modules,144ms)。**未做实机验证**(待 `wails3 dev`):多行/粘贴输入观察最新消息是否仍被遮挡。

## 下一步
实机验证 `wails3 dev` 下多行输入、粘贴长文本、usage-bar/queue 面板出现时,贴底最新消息是否始终可见、不再「向上跑」。
