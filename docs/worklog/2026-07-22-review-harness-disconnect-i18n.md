# 2026-07-22 Review #21311 harness 断连文案 i18n 端到端验收结论(NEEDS CHANGES)

## 起因

Task #21311(Review):验收 Task #21306/21307「harness 断连文案 i18n(detail→code)」的
commit `610ca7d`(fix(i18n): harness 断连文案改 code 驱动,前端按 code 翻译)。

重点不是「能否编译」,而是「代码是否真的让英文 locale 用户看到英文断连提示」——
拒收「加了 Code 字段 / 改了 setError 但文案仍走旧中文 Detail」的空壳改动,以及
「测试存在却不覆盖新行为」的纸面绿。

## 改动核对(commit `610ca7d`,5 文件)

后端 `internal/chat/chat.go`:
- `StatusPayload` 增 `Code string \`json:"code,omitempty"\``(chat.go:48)。
- 错误码常量 `ErrCodeHarnessDisconnected` / `ErrCodeHarnessEmptyTurn`(chat.go:54-58)。
- 新增 `emitError(sessionID, code)`(chat.go:318-320):推 error 状态 + Code,Detail 留空。
- 3 处断连族提示改走 `emitError`:
  - `SendAndWaitSync` Prompt 失败 → `ErrCodeHarnessDisconnected`(chat.go:1310)。
  - `runPrompt` Prompt 失败 → `ErrCodeHarnessDisconnected`(chat.go:1387)。
  - `runPrompt` 空 turn → `ErrCodeHarnessEmptyTurn`(chat.go:1396)。
- DB 保存失败(chat.go:1180)仍 `emitStatus("error", detail)`,detail 含动态 `err.Error()`
  ——非断连族、带调试信息,按 worklog 明确范围**有意保留**。✓ 范围划分正确。

前端:
- `types.ts:95`:`StatusPayload` 增 `code?: string`。
- `App.tsx:305`:`setError(s.code ? t(\`chat.error.${s.code}\`) : (s.detail || t("app.errorFallback")))`
  ——有 code 经 i18n 翻译,否则 detail,最后兜底。优先级正确。✓
- `zh.json` / `en.json` 各加 `chat.error.{harness_disconnected,harness_empty_turn}`,
  key 与后端常量字面量**逐字一致**(harness_disconnected / harness_empty_turn)。✓

## 端到端贯通核对(不只看 diff 表面)

确认 code 真的从后端流向前端 i18n,且无旁路把旧中文塞回 error-bar:

1. 后端 3 处 `emitError` 填 Code、Detail 空 → JSON 带 `code`、不带 `detail`。✓
2. 前端 `App.tsx:305` 在 status==="error" 分支读 `s.code` 并 `t("chat.error."+code)`。✓
3. locale key 逐字匹配两个常量(grep 确认 zh/en 各 2 条,无拼写漂移)。✓
4. 全仓 grep `连接已重置|未产生响应`:生产代码路径**无残留硬编码中文**
   (仅 docs/worklog、PROCESS.md 历史归档、chat.go:55 注释 —— 均非运行时文案)。✓

**结论:bug 确实被修复**——英文 locale 用户现在看到 `chat.error.*` 的英文文案,
而非后端硬编码中文。非空壳改动,行为真实变更。

## 验证

- `go build ./internal/...` + `go vet ./internal/chat/... ./internal/acp/...`:通过。✓
- `go test ./internal/chat/... ./internal/acp/...`:ok(全绿,仅 linker macOS 版本告警,
  与本改动无关)。✓
- `bun test`:48 pass / 2 fail。2 fail 为 `MermaidRenderer.mount.test.tsx` /
  `ModelSelect.mount.test.tsx`,报 `Cannot find module 'react/jsx-dev-runtime'`
  (环境模块解析问题)——与上一轮 PASS review(`review-readonly-text-ready`)同基线、
  同样 2 fail,属**预先存在、与本 i18n 改动无关**。✓
- 注:`tsc --noEmit` 需先 `wails3 generate bindings` 生成 `bindings/`,本 worktree 未生成,
  跳过(类型变更极小:仅新增可选字段 + 一个三元表达式,风险可控)。

## 阻塞项:缺回归测试(违反 §5.3 硬约束)→ NEEDS CHANGES

本改动**不是**「极简 i18n 文本值变更」(对照上一轮 PASS 的 readonly review 正是靠
「无逻辑分支」豁免测试)。本 commit 引入了**真实逻辑分支**:

- 后端:新增 `Code` 字段 + `emitError` helper + 错误码常量 + 3 处 emit 路由切换。
- 前端:`setError` 新增 `s.code ? t(...) : ...` 三元分支。

现有测试**不覆盖新行为**:
- `internal/chat/empty_turn_test.go:36` `TestEmptyTurnDetectedAsError` 仅断言
  `lastStatus == "error"`,**未断言 `.Code`**。
- worklog 自承:「既有用例只断言 `.Status`,不受 Detail→Code 影响」。

**回归窗口**:有人把 `emitError(sessionID, ErrCodeHarnessEmptyTurn)` 还原成
`emitStatus(sessionID, "error", "agent 未产生响应…中文硬编码")`,**所有现有测试仍全绿**
——即本次修复要防的 i18n 回归完全没被钉住。AGENTS.md §5.3 硬约束:
「每个 bug 修复必须配一个能复现该 bug 的测试,先复现再修。测试比修复更重要。」

### 需要的改动(具体、可执行)

1. **后端(高价值,必做)**:扩展 `empty_turn_test.go` 的 emit 捕获,额外断言
   收到的 `StatusPayload.Code == ErrCodeHarnessEmptyTurn`(而非仅 `.Status`)。
   再为 disconnect 路径(`SendAndWaitSync` / `runPrompt` Prompt 失败)补一条断言
   `Code == ErrCodeHarnessDisconnected` 的用例。这样把「断连族必须走 code、不许回退
   中文 Detail」钉死。
2. **前端(建议)**:补一条「status=error + code=harness_disconnected → error-bar 文本
   = `t("chat.error.harness_disconnected")`」的断言(可仿 ModelSelect.mount.test 的 mount
   模式,或抽出 setError 路由为纯函数单测),锁住 `s.code ? t(...) : ...` 分支。

实现侧逻辑正确、端到端贯通已核实;仅测试覆盖缺口阻塞合入。补上述后端断言即可放行。

## 规约合规(非阻塞,已满足)

- §4.4:不再裸露协议/OS 错;断连文案走 i18n 人话,DB 失败 detail 保留调试信息合理。✓
- §5.3「找不变量」:用稳定 code 做翻译键,而非按 Detail 文本启发式匹配。✓ 设计对路。
- §0.3 / §6.2:被验收方 worklog 已写、commit 原子(单 commit 仅 5 文件 i18n + 一个文档
  commit 分离),message 说清改了什么 + 为什么。✓
- §6.2 不夹带:diff 仅含本次改动相关文件。✓

## 结论

**NEEDS CHANGES**。实现正确、bug 确被修复、端到端贯通、build/test 无新增失败;
但**违反 §5.3 硬约束**:新增的 code 驱动分支无任何回归测试钉住,worklog 自承现有用例
不受 Detail→Code 影响。补后端 `Code` 断言(扩展 empty_turn_test + 加 disconnect 路径用例)
后即可改判 PASS。前端断言为建议项。

## 改了哪些文件

- `docs/worklog/2026-07-22-review-harness-disconnect-i18n.md`(本文件)。
