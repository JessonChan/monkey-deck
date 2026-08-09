# 2026-08-09 Composer 大段粘贴折叠成 chip(>20 行 chip 化)

## 起因

Task #24240。当用户向 composer 粘贴大段文本(日志 / 报错堆栈 / 大代码块)时,文本全部灌进 textarea,
把输入区撑得很大、抢占焦点,手打上下文变得困难。已有「长文本折叠」(LONG_LINE_THRESHOLD=8 行)只是把
整个 textarea 收成预览块,但文本仍在 textarea value 里,编辑大段依然笨重。

需要一个更轻的形态:大段粘贴本身被「chip 化」——离开 textarea、变成一个像附件那样的 chip,
textarea 只留用户手打的小段上下文;提交时再把完整原文拼回消息发给 agent。类比 Slack/Discord 粘贴大段
文本变成可折叠附件的体验。

## 设计

- **阈值**:`PASTE_FOLD_THRESHOLD = 20` 行。粘贴文本行数 > 20 → chip 化;≤ 20 行走原路径(内联进 textarea,
  超 8 行仍走已有的整体折叠预览)。20 比 8(整体折叠阈值)高,二者互斥:超 20 行根本不进 textarea。
- **数据模型**:`PasteSnippet { id, text, lines, chars }`。`text` 保留完整原文,提交时原样拼回。
- **state 位置**:`pasteSnippets` / `expandedSnippet` 为 Composer **组件本地 state**(task 明确要求 "pasteSnippets state")。
  Composer 不随 session 切换重挂载(ChatView 无 per-session key),本地 state 会跨 session 残留 → 加 `useEffect([sessionId])`
  切 session 时清空,与 attachments 等 per-session 隔离行为对齐。未提升到 App 是因为 task 指明 state、且当前无需跨
  session 持久化(草稿恢复等场景暂不覆盖 snippet)。
- **onPaste 顺序**:图片处理(优先)→ paste-fold 检测(>20 行 preventDefault + 捕获 chip,return)→ 短→长折叠判断(原逻辑)。
- **chip 渲染**:复用 `att-chip` 视觉,加 `ClipboardPaste` 图标 + `composer.pasteSnippet` 文案(「粘贴 · N 行」)。
  chip 体(button.paste-chip-toggle)点击切换展开预览;× 按钮移除该 snippet。
- **展开预览**:复用 `composer-collapse` 的首尾行 + 中间省略视觉(head 4 行 + divider「N 行已折叠」+ tail 2 行)。
  一次只展开一条(`expandedSnippet` 单 id),§4.4 不裸抛原文 JSON,只显可读文本行。
- **提交还原**:`submit` 把 `[手打文本, ...snippets.map(text)].filter(非空).join("\n\n")` 作为最终文本发给 agent。
  空行分隔让 snippet 与上下文清晰断开。提交后清空 pasteSnippets/expandedSnippet,与 attachments 等一并 reset。
- **`empty` 判定**:把 pasteSnippets 计入非空(只有 chip、无手打文本时 send 按钮也可点)。

## 改了哪些文件

- `frontend/src/components/Composer.tsx`
  - 加 `PASTE_FOLD_THRESHOLD` 常量 + `PasteSnippet` interface。
  - 加 `pasteSnippets` / `expandedSnippet` state + sessionId reset effect + addPasteSnippet/removePasteSnippet +
    snippetPreview useMemo(复用 head/tail 折叠逻辑)。
  - `onPaste`:加 > 20 行检测(preventDefault + addPasteSnippet + return),原短→长折叠逻辑不变。
  - `submit`:combined = 手打 + snippets 拼接;提交后清 snippet state。
  - `empty`:纳入 pasteSnippets。
  - 渲染:att-chips 条件加 pasteSnippets;pasteSnippets.map 渲染 paste-chip;att-chips 下方条件渲染
    snippetPreview 折叠块(复用 composer-collapse 结构 + class)。
  - 加 `ClipboardPaste` icon import。
- `frontend/src/components/Composer.mount.test.tsx`:新增 describe「Composer large-paste fold-to-chip (Task #24240)」,
  5 个用例覆盖:>20 行 chip 化(textarea 不变)、≤20 行不 chip、点击展开/再点收起/× 移除、submit 还原全文 +
  清 chip、仅 chip 无手打文本也能发。
- `frontend/src/index.css`:`.paste-chip` / `.paste-chip-toggle` / `.paste-chip-expanded` 样式(复用 att-chip,
  chip 体 button reset,展开态边框高亮)。
- `frontend/src/i18n/locales/{en,zh}.json`:加 `composer.pasteSnippet`、`composer.pasteSnippetTip`、`common.remove`。

## 验证

- `wails3 generate bindings`(bindings 不入库,首次需生成)。
- `cd frontend && bun run build` —— tsc + vite build 通过(无类型/编译错误)。
- `cd frontend && bun test src/components/Composer.mount.test.tsx --isolate` —— **34 pass / 0 fail**
  (含新增 5 例 paste-fold 用例 + 既有 paste-collapse regression / mention / slash / Tab 等全过)。
- `cd frontend && bun test --isolate` —— 193 pass / 5 fail;5 fail 全在 `NewSessionModal.mount.test.tsx`
  (经 `git stash` 验证为**预存在失败**,与本次改动无关 —— worktree/base-ref/existing-dir 选择器,与 Composer 无关)。
- 注释一律英文(§3.7);i18n 文档/文案中文(§3.7 仅限源码注释)。

## 下一步 / OPEN

- **多 snippet 顺序**:当前提交时 snippet 按捕获顺序追加在手打文本之后(空行分隔)。若用户交替「打字→粘→打字→粘」,
  后打的手打文本仍在所有 snippet 之前(snippet 全部在后)。更精细的交错顺序需记录光标位/插入序,当前未做,
  编码型 agent 单轮多 snippet 罕见,先保持简单可预测。
- **草稿恢复未覆盖 snippet**:`value` 支持撤回编辑/草稿回填,但 pasteSnippets 是组件本地 state,session 切换会清空
  (非持久化)。若要支持 snippet 草稿恢复,需提升到 App 并按 session 持久化(类比 attachments)。暂记 OPEN。
- 真机(WebKit / WebView2)下 chip + 折叠块的视觉/点击体验待 §4.6 跨平台验证。
