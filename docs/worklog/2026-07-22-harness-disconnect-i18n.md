# 2026-07-22 harness 断连文案 i18n(后端 detail→code + 前端按 code 翻译)

## 起因
Task #21307。harness 断连/空响应的用户提示原本是**后端硬编码中文字符串**塞进
`StatusPayload.Detail`(`"agent 连接已重置,下条消息将自动重连"` 等),前端原样
塞进 error-bar。切到英文 locale 时这些文案仍是中文 —— i18n 漏网。

## 设计
- §4.4:技术/协议格式不裸露给用户。把「人话文案」从前端拿,后端只给**稳定机器码**。
- 不动既有 `Detail` 语义:`Detail` 仍承载内部逻辑标记(`stopReason=`、`cancelled`)与
  动态错误(DB 保存失败的 `err.Error()`)。新增独立 `Code` 字段专给 error 状态用。
- §5.3「找不变量」:用稳定 code 做翻译键,而非按 `Detail` 文本启发式匹配。

## 改法
- **后端** `internal/chat/chat.go`:
  - `StatusPayload` 增 `Code string \`json:"code,omitempty"\``(仅 error 状态填)。
  - 新增错误码常量 `ErrCodeHarnessDisconnected`(`"harness_disconnected"`)、
    `ErrCodeHarnessEmptyTurn`(`"harness_empty_turn"`)。
  - 新增 `emitError(sessionID, code)` 辅助:推 error 状态 + code,Detail 留空
    (不把协议/OS 裸错误抛给用户,§4.4)。
  - 3 处断连族提示改走 `emitError`:
    - `SendAndWaitSync` 失败(peer 断 / 其它)→ `ErrCodeHarnessDisconnected`
    - `runPrompt` 失败(peer 断 / 超时 / 其它)→ `ErrCodeHarnessDisconnected`
    - `runPrompt` 空响应(resume 后 session 状态损坏)→ `ErrCodeHarnessEmptyTurn`
  - DB 保存失败的 `Detail`(含动态 `err.Error()`)保持不变 —— 非断连族、带调试信息。
- **前端** `frontend/src/types.ts`:`StatusPayload` 增 `code?: string`。
- **前端** `frontend/src/App.tsx`:status=error 时 `setError(s.code ? t(\`chat.error.${s.code}\`) : (s.detail || t("app.errorFallback")))`。
  沿用既有 `setError` 在调用点 pre-localize 的约定(如 mergeFailed/refreshConfigFailed)。
- **locale** zh/en 各在 `chat` 下加 `error.{harness_disconnected,harness_empty_turn}`。

## 改了哪些文件
- `internal/chat/chat.go`
- `frontend/src/types.ts`
- `frontend/src/App.tsx`
- `frontend/src/i18n/locales/zh.json`
- `frontend/src/i18n/locales/en.json`

## 验证
- `go build ./...` / `go vet ./internal/...` 通过(根 build 需先 build 前端产 dist 满足 embed,与本次改动无关)。
- `go test ./internal/chat/... ./internal/acp/...` 全绿(既有用例只断言 `.Status`,不受 Detail→Code 影响)。
- `tsc --noEmit` 0 错误(需先 `wails3 generate bindings` 生成 bindings/)。
- `vite build` 通过;`bun test` 60 pass / 0 fail。

## 下一步
- 其余 error-bar 来源(各类 `setError(String(e))` 裸异常串、DB 保存失败 Detail)仍未 i18n,
  属于另一范畴(动态错误信息),如需统一可另起任务:后端对可枚举错误也发 code、
  前端对纯异常串走通用「操作失败」兜底。
- error-bar 当前是快照字符串,语言切换时不会重翻译(既有设计,所有 error 情况一致);
  如需语言切换即时生效,可改为存 code 在渲染边界翻译。
