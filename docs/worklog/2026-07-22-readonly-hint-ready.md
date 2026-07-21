# 2026-07-22 补改 chat.readonlyHint 为就绪/Ready(zh.json+en.json 一个 key)

## 起因

Task #21304:上一轮 Review(`2026-07-22-review-readonly-text-ready.md`)把
`chat.status.readonly` 状态徽标改成「就绪 / Ready」后,在「次要观察」里点名
**`chat.readonlyHint`(zh/en line 98)未改**,仍为「只读 — 发消息以继续」/
「Read-only — send a message to continue」。本任务就是把这一个 key 也统一成
「就绪 / Ready」,与状态徽标语义对齐。

## 改法

只改 i18n 文本值,一个 key(zh + en 各 1 行):

- `frontend/src/i18n/locales/zh.json:98`:`"readonlyHint": "只读 — 发消息以继续"` → `"就绪"`。
- `frontend/src/i18n/locales/en.json:98`:`"readonlyHint": "Read-only — send a message to continue"` → `"Ready"`。

## 端到端贯通核对(非空壳)

`chat.readonlyHint` 真正渲染、且渲染处用这个 key:

1. `ChatView.tsx:424`:`{props.status === "readonly" && (...)}` —— 只读状态才出横幅。
2. `ChatView.tsx:428`:`{t("chat.readonlyHint")}` —— 横幅文案走该 key,
   即改后为「就绪 / Ready」。✓

文案值变更真正传导到 readonly-banner 渲染,非空壳。

## 规约合规

- §4.4:横幅文案一直走 i18n,不涉及新增裸露结构化格式。✓
- §0.3 / §6.2:本 worklog 已写;commit 原子(代码与文档分两个 commit),
  message 说清改了什么 + 为什么(与 `chat.status.readonly` 状态徽标语义统一)。✓
- §6.2 不夹带:代码 commit diff 仅含 en.json/zh.json 两文件各 1 行。✓

## 验证

- 环境 `node_modules` 未安装(与上一轮 Review 同状态),`npm run build` 因
  `tsc: command not found` 跑不动;改动为纯 JSON 字符串值,无类型/逻辑分支。
- `node -e 'JSON.parse(...)'` 双文件均合法 JSON。✓
- 无 Go 改动,无需 `go build`。

## 改了哪些文件

- `frontend/src/i18n/locales/zh.json`(readonlyHint 值)。
- `frontend/src/i18n/locales/en.json`(readonlyHint 值)。
- `docs/worklog/2026-07-22-readonly-hint-ready.md`(本文件)。

## 下一步

无。本任务为上轮 Review 次要观察的收尾,语义已统一。
