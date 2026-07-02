# 2026-07-02 chat-selection-copy

## 起因
用户澄清「不能选择复制」:前一次只补了一键复制整条消息,但消息正文仍无法用鼠标拖选一段文本后复制。

## 根因
`frontend/src/index.css` 在全局 `*` 上设置了 `user-select: none`,只有输入框/部分预览区域单独恢复了 `user-select: text`。聊天正文(`.bubble-user` / `.bubble-agent` / code block / thought text / tool pre)没有覆盖,所以无法拖选文本。

## 改法
- `frontend/src/index.css`
  - `.bubble-user` 显式 `user-select: text`。
  - `.bubble-agent` 和 `.bubble-agent *` 显式 `user-select: text`,覆盖 markdown 子节点。
  - `.code-box-pre` / `.code-box-pre code` 显式 `user-select: text`。
  - `.thought-text` 显式 `user-select: text`。
  - `.tool-pre` 显式 `user-select: text`。

## 验证
- Vite dev smoke(`http://127.0.0.1:9245`):动态渲染含用户消息与 agent 消息的 `ChatView`。
  - `getComputedStyle(.bubble-user).userSelect` → `text`。
  - `getComputedStyle(.bubble-agent).userSelect` → `text`。
  - 鼠标拖选用户消息 → `window.getSelection()` 为 `用户消息可以拖选复制`。
  - 鼠标拖选 agent 消息 → `window.getSelection()` 返回 agent 文本片段,证明可选中。
  - 对选中的用户消息执行 `document.execCommand('copy')` → clipboard 内容为 `用户消息可以拖选复制`。
- `cd frontend && bun test` → 10 pass / 0 fail。
- `cd frontend && bun run build:dev` → `tsc && vite build --minify false --mode development` 成功。

## 下一步
- 如后续要支持「复制整段 Markdown 原文」和「复制渲染后富文本」两种模式,可再加上下文菜单;当前修复的是原生拖选复制。
