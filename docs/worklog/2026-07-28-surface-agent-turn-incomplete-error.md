# 2026-07-28 turn 非 end_turn 结束时给用户可见错误提示

## 起因

排查 junie session 6787244b「切过来发消息没回复」时发现:Prompt 成功返回、timeline 也非空,
但 `stopReason != end_turn`(cancelled/refusal/max_tokens/max_turn_requests)时,runPrompt 直接
走 `emitStatus idle "stopReason=…"` —— **静默当成功**,用户看到「发了消息什么都没发生也没报错」。

junie 的具体触发:session 钉着过时模型 `gemini-3-flash-preview`,resume 后第一发撞模型回退被
`CANCELLED`(同时吐了 ExitEarly 消息 → timeline 非空 → 没走空回合路径),于是静默。

(根因见 `2026-07-28-acp-resume-mcpservers-omitempty-workaround.md` 同期排查:ACP 协议里 model
不是 resume 参数,归 agent 管;session 钉了过时模型是 junie 侧行为。本条只补「别静默」。)

## 改法

- 新增 `ErrCodeAgentTurnIncomplete = "agent_turn_incomplete"`(chat.go)。
- `internal/acp/runner.go` 透传 `StopReasonEndTurn` 常量(同 `type StopReason` 既有模式,业务包不直接 import SDK)。
- `runPrompt` 成功路径(无 err、timeline 非空)在 `emitStatus idle` 之前加判断:
  `stopReason != end_turn` → `emitError(AgentTurnIncomplete)` + return。**不 teardown**——harness 仍活、
  连接是好的(agent 自己取消/拒绝/触上限,不是崩溃),用户可重试或换模型。
- 用户主动 Stop 走 err 路径(turnCtx.Err()),不至此;此处非 end_turn 必是 agent 自身异常结束。
- i18n(zh/en)加 `chat.error.agent_turn_incomplete`:说明「这轮没正常结束(模型可能不可用/被拒/触上限),
  连接正常,可重试或切换模型」——给到 junie 模型漂移场景的可操作提示。

前端既有链路天然承接:`emitError` 发 `status=error+code` → App.tsx `setError(t('chat.error.<code>'))`
→ ChatView `.error-bar` 渲染(无需前端改动)。

## 改了哪些文件

- `internal/chat/chat.go`(新 ErrCode + runPrompt 分支)
- `internal/acp/runner.go`(透传 StopReasonEndTurn)
- `frontend/src/i18n/locales/zh.json`、`en.json`(新 key)

## 验证

- `go build . ./internal/...` 通过;`go test ./internal/chat/ ./internal/acp/` 通过;前端 `tsc` + 147 测试通过。
- **端到端未在 server 模式浏览器复现**:server 模式下 composer 的 send 经 WS 没可靠到后端
  (md-server 日志无 prompt 活动)——这是 §5.5 记的 server 模式限制,非本改动问题。链路完整性已逐段
  确认:后端 emitError(本改动)→ App setError → ChatView `.error-bar`(line 647)。桌面 app(send 能通)
  下,junie session 发消息被 cancel 时应显示该提示。

## 下一步 / OPEN

- 桌面 app 实测确认提示出现(送消息给一条 stopReason 非 end_turn 的 session)。
- 模型漂移根因(junie 老 session 钉过时模型)仍待用户侧在模型选择器里切一次 glm-5.2 解决;本条只保证
  发生时不再静默。
