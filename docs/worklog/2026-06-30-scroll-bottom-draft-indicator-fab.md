# 2026-06-30-scroll-bottom-draft-indicator-fab.md

## 起因
用户提出 3 个交互打磨功能:
1. 发消息后对话历史自动滚到底部,让用户看到自己发的消息
2. 空闲 session 在输入框有草稿时,侧栏状态点从灰点变为铅笔图标(✏)提示
3. 用户向上翻时,聊天底部出现浮动圆形「滚到底部」箭头按钮,一键回到最新

## 改法

### 1. ChatView 暴露 `scrollToBottom` 接口 + App 发送后显式调用

`frontend/src/components/ChatView.tsx`:
- `import { forwardRef, useImperativeHandle } from "react"`
- 新增 `export interface ChatViewHandle { scrollToBottom: () => void; }`
- 用 `forwardRef<ChatViewHandle, Props>(..., ref)` 包装原函数
- 新增 `useState(false) showScrollBtn` 跟踪 FAB 可见性
- 新增 `useImperativeHandle(ref, () => ({ scrollToBottom: ... }))` 给父组件调用
- 把 `stickToBottomRef` 与 `setShowScrollBtn` 同步:多处状态切换点一并更新

### 2. 浮动滚到底部 FAB 按钮

`ChatView.tsx` JSX `<div className="chat-body" ... >` 内部(typing-indicator 之后)添加条件渲染:
```jsx
{showScrollBtn && (
  <button className="scroll-bottom-btn" onClick={...} ...>
    <ArrowDown size={16} />
  </button>
)}
```

`index.css`:
- `.chat-body` 加 `position: relative;`(供 absolute 定位 FAB)
- 新增 `.scroll-bottom-btn` 样式:30px 圆形、absolute 右下角、毛玻璃深底、hover 反白、入场 fab-in 动画

### 3. 侧栏铅笔草稿指示

`frontend/src/components/Sidebar.tsx`:
- import 增加 `lucide-react` 的 `Pencil`
- Props 加 `draftBySession?: Record<string, string>`
- session 行的三元链末尾加一项:`draftEl ? draftEl : null`,其中 draftEl 是一段带 `Pencil` 图标的 JSX(截断到 40 字符 + 省略号作 tooltip)
- 修掉了原本有个 `p` 变量未用 warning

`App.tsx`:
- `import ChatView, { type ChatViewHandle } from "./components/ChatView"`
- 新增 `const chatViewRef = useRef<ChatViewHandle>(null)`,传入 `<ChatView ref={chatViewRef} .../>`
- `sendMessage` 入口加 `chatViewRef.current?.scrollToBottom();`(含排队分支)
- `<Sidebar ... draftBySession={draftBySession} .../>` 把草稿映射传下去同步状态

`index.css`:
- 新增 `.draft-indicator` 样式:15×15 圆角方形、accent-2 蓝、背景 `rgba(100,210,255,0.12)`,与现有 perm-dot/unread-dot 尺寸/风格对齐

### 4. 连带清理

- 从 Sidebar 移除了 `onAddProjectByPath`(此 prop 之前由当前变更的上下文新增,但未被真实使用)
- 从 App 移除了 `addProjectByPath`(死代码)
- 从 ChatView 移除了 `ChatService`、`ReactMarkdown`、`remarkGfm`、`Collapsible`、多个 lucide icon 等未使用 import

## 改了哪些文件

```
frontend/src/components/ChatView.tsx
frontend/src/components/Sidebar.tsx
frontend/src/index.css
frontend/src/App.tsx
```

## 验证

- `bunx tsc --noEmit` 0 diagnostics
- `go build .` compile ok (ld warning unrelated, 仅 macOS SDK version mismatch)
- `go test ./internal/chat/ -count=1` ok

## 未做 / 下一步

- 未做浏览器实测滚动/FAB 视觉走查(建议 reviewer 手动 `wails3 dev` 验证)
- 未做 E2E 自动化覆盖这三个交互
