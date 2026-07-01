# 移除静默超时和绝对超时，对齐 omp TUI 设计

## 起因

多个 session 出现"agent 做完工具后不回复"。根因（omp 源码实证）：omp 内部有完整的空停止重试（3 次）和 auto-retry（429/503/timeout）机制，但这些重试在 ACP 模式下对 client 不可见（不发 SessionUpdate）。我们的 300s 静默超时会在 omp 内部重试期间打断 Prompt，导致用户看到"做完事就没下文"。

## 根因（omp 源码）

- `agent-session.ts` `#handleEmptyAssistantStop`（L9724）：model 返回空 stop → 丢弃 + 注入 reminder + `#scheduleAgentContinue` → 最多重试 3 次。
- `agent-session.ts` `#autoRetry`（L12329）：model API 错误（429/503/timeout）→ 指数退避重试。
- `acp-event-mapper.ts`：`auto_retry_start/end` 和 `empty_stop` 事件**不在 ACP mapper 处理范围**，TUI 有专门 UI（retry loader），ACP client 完全不可见。
- omp TUI 和 ACP **都没有 turn 级绝对超时**——turn 跑到自然结束，靠用户 Ctrl+C / Stop 停止。

## 改法

对齐 omp TUI 设计：**不设任何 turn 级超时**，靠两条兜底：
1. **崩溃检测**：harness 进程死 → `IsPeerDisconnected` → teardown + 重连。
2. **用户可停**：用户点 Stop → `turnCancel()` 取消 ctx → Prompt 返回。

## 改了哪些文件

- `AGENTS.md` §3.3 重写 + §8 自检清单更新
- `internal/acp/runner.go`：删除 `activityTracker`、`maxTurnAbsolute`、`shouldCancelTurn`、`timedOut`/`timedOutAt`、timeout goroutine；`Prompt` 签名移除 `timeout` 参数，简化为直接调 `cs.Conn.Prompt`
- `internal/chat/chat.go`：`chatConn` 接口移除 timeout 参数；`runPrompt` 和 `SendAndWaitSync` 的 Prompt 调用去掉 `300*time.Second`
- `internal/chat/queue_test.go`：`fakeChat.Prompt` 签名移除 timeout 参数
- `internal/chat/idle_reaper_test.go`：`mockChatConn.Prompt` 签名移除 timeout 参数
- `internal/acp/activity_test.go`：删除（全部测试都是关于已删除的超时逻辑）

## 验证

- `go build . ./internal/...` 通过
- `go test ./internal/chat/ ./internal/acp/` 全部通过

## 下一步

观察生产环境：去超时后 omp 内部重试不再被打断，长静默期间用户靠 Stop 按钮控制。如果用户反馈"agent 卡住不知道怎么办"，可考虑在前端加一个"agent 正在思考中..."的长时间无输出提示（但不自动取消）。
