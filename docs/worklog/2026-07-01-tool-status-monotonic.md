# tool 状态被异步 update 回退到 in_progress

## 起因

用户反馈 session `da0e640f` 对话已结束，但 tool "Launching audit scouts" 仍显示「执行中」。该 tool 有完整的 rawOutput（甚至内容里带 `state:completed`），但 status 卡在 `in_progress`。

## 根因（omp 源码实证）

从 `references/oh-my-pi` 源码追到完整事件时序 bug：

1. **`acp-event-mapper.ts:180-198`**：`tool_execution_update` 事件被**硬编码** `status: "in_progress"`。
2. **`acp-event-mapper.ts:200-213`**：`tool_execution_end` 事件发 `status: completed`。
3. **`task/index.ts:556-758`**：async task（`async.enabled`）的 `execute()` 注册后台 job 后**立即返回**（不等子 agent 完成）。

事件时序：
```
① tool_execution_start        → tool_call         status=pending
② onUpdate("Spawned...")      → tool_call_update  status=in_progress  (mapper 硬编码)
③ execute() 返回              → tool_execution_end → tool_call_update  status=completed   ✅
④ 后台 job 完成 → onUpdate()   → tool_execution_update → tool_call_update  status=in_progress ❌ 回退！
```

第④步是后台 job 异步调的 `onUpdate`，发生在 `execute()` 返回（第③步）之后。它经过 acp-event-mapper 被硬编码成 `status: "in_progress"`，**覆盖了已发的 `completed`**。

DB 里 rawOutput 带 `state:completed`（来自第④步的 partialResult），但 tool status 是 `in_progress`（来自 mapper 硬编码）——完美吻合。

## 改法

**单调状态保护**：tool 一旦到终态（completed/failed），后续 `tool_call_update` 只更新 rawOutput 等非状态字段，**不接受 status 回退到 in_progress/pending**。

两处实现：
- `internal/chat/chat.go` `handleEvent`：`tool_call_update` 分支加 `isTerminalToolStatus(t.Status)` 守卫。DB 持久化由此正确。
- `internal/acp/runner.go` `activityTracker.observe`：同样的守卫，防止 inProgress 计数被迟到的 in_progress 错误增加。

## 改了哪些文件

- `AGENTS.md` §5.4 新增坑 #10（tool 状态单调推进）
- `internal/chat/chat.go`：`handleEvent` tool_call_update 分支加单调守卫 + `isTerminalToolStatus` 辅助函数
- `internal/acp/runner.go`：`activityTracker.observe` 加单调守卫 + `isTerminalToolStatus` 辅助函数
- `internal/chat/monotonic_status_test.go`：新增 `TestToolStatusMonotonicNoRegression` 回归测试

## 验证

- `go build . ./internal/...` 通过
- `go test ./internal/chat/ ./internal/acp/` 全部通过（含新测试）
- 回归测试覆盖：completed 后收到 in_progress update → status 不回退、rawOutput 仍更新

## 下一步

这是 omp 侧的 bug（acp-event-mapper 对 tool_execution_update 硬编码 status=in_progress，不该对异步 task 的 onUpdate 生效）。我们做了客户端侧的单调保护，治本应是 omp 侧修 mapper。在 omp 修复前，我们的保护是正确的兜底。
