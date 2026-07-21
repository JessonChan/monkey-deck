# 2026-07-22 Review #21303 补漏 chat.readonlyHint 就绪/Ready 一致性验收结论(PASS)

## 起因

Task #21303(Review):验收 Task #21304「补改 `chat.readonlyHint` 文案为就绪/Ready」
的两个 commit:

- `73bb6c5`(fix(i18n): 补改 chat.readonlyHint 文案为就绪/Ready,纯代码)
- `5b2f37e`(docs(worklog): 补改 chat.readonlyHint 为就绪/Ready,纯文档)

这是上一轮 Review(`2026-07-22-review-readonly-text-ready.md`)「次要观察」点名
「`chat.readonlyHint` 未改、状态徽标与横幅文案不一致」的收尾任务。验收重点同上轮:
拒收「改了 JSON 但 key 没被引用 / 渲染处不走该 key」的空壳改动,并确认本次确实达成
**一致性**(状态徽标与横幅文案对齐)。

## 改动核对(commit `73bb6c5`)

仅 2 行,纯 i18n 文本值变更:

- `frontend/src/i18n/locales/zh.json:98`:`"readonlyHint": "只读 — 发消息以继续"` → `"就绪"`。
- `frontend/src/i18n/locales/en.json:98`:`"readonlyHint": "Read-only — send a message to continue"` → `"Ready"`。
- 无类型 / 逻辑 / import 改动,符合「补漏一个 key」的原子范围。

## 端到端贯通核对(不只看 diff 表面)

确认 key `chat.readonlyHint` 真的被渲染、且渲染处用的是这个 key:

1. **key 路径正确**:`readonlyHint` 嵌在 `"chat"` 命名空间下(zh.json:87 `"chat": {` →
   :98 `readonlyHint`),故 `t("chat.readonlyHint")` 命中本 key。✓
2. `ChatView.tsx:424`:`{props.status === "readonly" && (...)}` —— 只读态才出
   `readonly-banner`。
3. `ChatView.tsx:425-429`:横幅内 `{t("chat.readonlyHint")}` 走该 key,即改后为
   「就绪 / Ready」,并带 `data-testid="readonly-banner"`。✓
4. 全仓 grep `readonlyHint` 确认**唯一渲染点**(ChatView.tsx:428),无其它旁路;
   grep 旧文案 `只读 — 发消息以继续` / `Read-only — send a message to continue`
   **零命中**(残留 `只读` 均为代码注释,非用户可见文案)。✓

结论:文本值变更真正传导到 `readonly-banner` 渲染,非空壳。

## 一致性核对(本任务核心目标)

- `chat.status.readonly`(zh:134 / en:134)= `就绪 / Ready`(上轮 `e418fa9` 已改)。
- `chat.readonlyHint`(zh:98 / en:98)= `就绪 / Ready`(本次 `73bb6c5` 改)。

两处用户可见文案现在同字面,达成任务目标「一致性」。横幅仍保留 Eye 图标 +
`继续会话` 按钮(`ChatView.tsx:427/430-438`),可识别性与可操作性不丢——「就绪」
作状态措辞 + 「继续会话」作行动按钮,语义自洽。

## 规约合规

- §4.4:横幅文案一直走 i18n,新值为人话「就绪」,不涉及新增裸露结构化格式。✓
- §0.3 / §6.2:被验收方 worklog(`2026-07-22-readonly-hint-ready.md`)已写、自包含;
  commit 原子(代码 `73bb6c5` 仅 2 行 i18n,文档 `5b2f37e` 单独 commit),
  message 说清改了什么 + 为什么(与 `chat.status.readonly` 语义统一)。✓
- §6.2 不夹带:代码 commit diff 仅含 en.json/zh.json 两文件各 1 行,无无关改动。✓
- §0.2:未碰 `references/`。✓

## 次要观察(不阻塞)

- **无自动化测试断言横幅文案**:与上轮 Review 同基线——现有测试集不覆盖 ChatView
  横幅。本改动为纯 JSON 字符串值变更(无逻辑分支),以「key 贯通核对 + JSON 合法性
  + build/test 基线」作验收,可接受;若日后 ChatView 横幅抽出为可测单元,建议补
  「status=readonly → 横幅文本=就绪」断言以锁回归。
- **状态徽标与横幅文案现完全同字面**:这是任务目标(统一措辞),非缺陷;产品若后续
  希望横幅再带「点继续会话以交互」之类提示,可再开任务,不影响本次验收。

## 验证

- `node -e JSON.parse(...)` 双文件均合法 JSON。✓
- 环境 `node_modules` 未安装(与上轮 Review 同状态),`tsc` / `bun test` 跑不动;
  但改动为纯 JSON 字符串值,无类型 / 逻辑变更,不可能引入新失败——同上轮基线。
  上轮已确认 2 项预先存在 fail 与 i18n 改动无关。
- 无 Go 改动,无需 `go build` / `go test`。

## 结论

**PASS**。`chat.readonlyHint` 文案 zh/en 各改 1 行(只读—发消息以继续 → 就绪 /
Read-only — send a message to continue → Ready),经 `ChatView.tsx:428`
`{t("chat.readonlyHint")}` 真正渲染到 `readonly-banner`,端到端贯通、非空壳;
与 `chat.status.readonly` 文案达成一致(本任务核心目标);旧文案零残留;
build/test 基线无变化;规约合规。次要观察(缺横幅文案测试)不阻塞,可合入。

## 改了哪些文件

- `docs/worklog/2026-07-22-review-readonly-hint-ready.md`(本文件)。
