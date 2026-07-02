# 2026-07-02 chat-message-copy

## 起因
用户反馈:对话消息应支持一键复制,不论是用户自己发的还是 agent 回复的,不能只依赖手动选中文字复制。

## 参考调研
- openwork:用户/助手消息有 hover 显示的 `CopyMessageButton`,直接用 `navigator.clipboard.writeText`,复制后 Copy→Check 状态切换;用户消息还带右键菜单 Copy。
- wesight:用户/助手消息 hover 显示 CopyButton,复制后短暂显示 check;代码块也有独立复制按钮;普通文本复制走 `navigator.clipboard.writeText`。
- real-agent-kanban:无聊天消息复制 UI。
- orca:代码块和上下文菜单有 Copy/Check 模式,复制后短暂反馈。

## 改法
- `frontend/src/components/ChatView.tsx`
  - 复用 `MessageActions` 给用户消息加复制按钮。
  - `MessageActions` 增加 `className`/`testId` 参数,用户消息使用 `copy-user-msg`,agent 消息继续使用 `copy-msg`。
  - 复制仍走浏览器 `navigator.clipboard.writeText(text)`,复制成功后 1.5s 内显示「已复制」和 Check 图标。
  - 新复制按钮使用 `react-tooltip` 的 `data-tooltip-id="md-tip"`,不使用原生 `title`。
- `frontend/src/index.css`
  - 新增 `.bubble-user-wrap`,让用户消息 bubble 和复制按钮右对齐。
  - 用户复制按钮 hover/focus 时显示;agent 原 hover 复制行为保留。

## 验证
- `cd frontend && bun test` → 10 pass / 0 fail。
- `cd frontend && bun run build:dev` → `tsc && vite build --minify false --mode development` 成功。
- Vite dev smoke(`http://127.0.0.1:9245`):动态渲染含一条用户消息和一条 agent 消息的 `ChatView`,通过 CDP 授权 clipboard 后点击:
  - `[data-testid="copy-user-msg"]` → clipboard 内容为 `用户消息可复制`,按钮文本变为 `已复制`。
  - `[data-testid="copy-msg"]` → clipboard 内容为 `助手回复可复制`,按钮文本变为 `已复制`。

## 下一步
- 如后续需要更强发现性,可参考 openwork 给用户消息补右键菜单 Copy;当前先保持轻量 hover/focus 复制按钮。
