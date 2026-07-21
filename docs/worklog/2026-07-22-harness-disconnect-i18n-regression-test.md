# 2026-07-22 补 #21306 回归测试:断言 Code 驱动分支(钉住 i18n 不回退中文)

## 起因

Task #21312。Review #21311(验收 commit `610ca7d`「harness 断连文案 i18n(detail→code)」)
判定 **NEEDS CHANGES**:实现正确、端到端贯通已核实,但**违反 AGENTS.md §5.3 硬约束**
——新增的 code 驱动分支(后端 `emitError(code)` + 前端 `s.code ? t(...) : ...`)无任何回归
测试钉住。现有 `TestEmptyTurnDetectedAsError` 只断言 `.Status == "error"`,不查 `.Code`;
worklog 自承「既有用例只断言 `.Status`,不受 Detail→Code 影响」。

回归窗口:有人把 `emitError(sessionID, ErrCodeHarnessEmptyTurn)` 还原成
`emitStatus(sessionID, "error", "agent 未产生响应…中文硬编码")`,**所有现有测试仍全绿**
——本次修复要防的 i18n 回归(英文 locale 仍看到后端中文)完全没被钉住。

## 改法

按 review「需要的改动(具体、可执行)」逐条落地后端断言(review 标注后端为「高价值,必做」;
前端为「建议项」,后端补齐即可放行):

1. **fakeChat 增 `promptErr` 注入**(`queue_test.go`):非空则 `Prompt` 立即返回该错
   (不进入 block/cancel 分支),供 disconnect 路由测试模拟 harness 崩溃/断连。
   同时在进入时仍 `started <- struct{}{}` 发信号,`waitStarted` 照常可用。
2. **扩展 `empty_turn_test.go::TestEmptyTurnDetectedAsError**:emit 捕获从 `lastStatus string`
   升级为 `lastPayload StatusPayload`,新增两断言:
   - `Code == ErrCodeHarnessEmptyTurn`(稳定翻译键,而非空)。
   - `Detail == ""`(不夹带任何硬编码/裸错文案)。
3. **新增 `error_code_test.go`(disconnect 路由,3 用例)**:
   - `TestRunPromptDisconnectEmitsCode`:后台路径(`runPrompt`,SendMessage 驱动)Prompt 返回
     `"peer disconnected before response"` → `Code == ErrCodeHarnessDisconnected` + `Detail == ""` + teardown。
   - `TestRunPromptBrokenPipeEmitsCode`:`"write |1: broken pipe"` 与 peer disconnected 等价
     (§5.4 #2 两类断连信号,`IsPeerDisconnected` 都命中)→ 同样 `Code` 驱动。
   - `TestSendAndWaitSyncDisconnectEmitsCode`:同步驱动路径(`SendAndWaitSync`,chat.go:1310)
     Prompt 失败 → 同样 `Code == ErrCodeHarnessDisconnected` + `Detail == ""`。
   - 抽出 `waitErrorStatus` / `assertDisconnectedCode` 两个 helper 复用。

## 验证

- `go build ./internal/...` + `go vet ./internal/chat/... ./internal/acp/...`:通过。
- `go test ./internal/chat/... ./internal/acp/...`:全绿(chat 2.2s / acp 1.9s,仅 linker macOS
  版本告警,与本改动无关)。
- **复现验证(§5.3「先复现再修」,逐路径把 emitError 还原成中文 emitStatus 确认测试变红)**:
  - `chat.go:1396`(空 turn)`emitError(…EmptyTurn)` → `emitStatus("error","agent 未产生响应…")`
    → `TestEmptyTurnDetectedAsError` 红(`Code="", want "harness_empty_turn"`)。✓
  - `chat.go:1387`(runPrompt 断连)`emitError(…Disconnected)` → `emitStatus("error","agent 连接已重置…")`
    → `TestRunPromptDisconnectEmitsCode` / `TestRunPromptBrokenPipeEmitsCode` 红(`Code=""`)。✓
  - `chat.go:1310`(SendAndWaitSync 断连)同上还原 → `TestSendAndWaitSyncDisconnectEmitsCode` 红。✓
  - 三处还原后均恢复 `emitError`,生产代码回到 commit `610ca7d` 状态(grep 确认无中文残留)。

## 改了哪些文件

- `internal/chat/queue_test.go`(fakeChat 增 `promptErr` 字段 + Prompt 分支)
- `internal/chat/empty_turn_test.go`(扩展 Code/Detail 断言)
- `internal/chat/error_code_test.go`(新增,disconnect 路由 3 用例 + helper)

## 下一步

- 前端 `s.code ? t(\`chat.error.${s.code}\`) : ...` 分支(review「建议项」)未补单测。
  该分支是 App.tsx:305 事件回调内的一行三元,挂载整个 App 成本高(需 mock 大量 Wails3
  binding);若需补,可考虑抽出 setError 路由为纯函数单测。当前后端断言已把
  「断连族必须走 code、不许回退中文 Detail」钉死,review 即可放行。
