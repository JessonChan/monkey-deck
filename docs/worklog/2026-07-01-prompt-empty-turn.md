# Prompt 空响应（agent 不回答）静默成功

## 起因

用户反馈 session `425ee191` 发了两次消息都没反应。DB 里两条 user 消息都入库了，但无任何 agent/thought/tool 产出。

## 根因（日志实证）

`monkey-deck.log` 时间线：

```
21:49:52  session live  resume=true   ← harness spawn 成功，进程活着
  21:50:02  用户发 seq 78              ← harness 活着
  21:50:09  用户发 seq 79              ← harness 活着
21:55:31  session idle timeout        ← 5 分钟后被 idle reaper 关掉
```

idle reaper 在 5 分钟后才关 session——说明两次 Prompt 都**快速返回了**（不是卡住），且 `busy=false`、`lastActivity` 停在发送时刻。

**根因**：Prompt 成功返回（`err=nil, stopReason=end_turn`），但期间零条 SessionUpdate。harness 进程活着、ACP 连接没断，但 agent 没产出任何内容——最可能是 omp `LoadSession` resume 后内部 session 状态损坏。

`runPrompt` 只检查 `err != nil`，没检查"成功但空输出"，直接 `emitStatus("idle")` → 用户看到发了消息没反应。`ensureLive` 的 `IsAlive()` 只检测进程是否存活，检测不了"进程活着但 session 状态损坏"。

## 改法

`runPrompt` 收尾段（`err == nil` 路径、`suppressed` 检查之后）新增空响应检测：
- 本轮 `segments` 和 `tools` 都为空 → 当 error 处理
- `teardownLive`（拆连接）+ `emitStatus("error", "agent 未产生响应，连接已重置，下条消息将自动重连")`
- 下条消息走 `ensureLive → LoadSession` 重 spawn

前端 `drainQueue` 对 `error` 状态也触发自动续发，所以排队消息也会自动重连后发送。

## 改了哪些文件

- `internal/chat/chat.go`：`runPrompt` 新增空响应检测（+9 行）
- `internal/chat/queue_test.go`：`fakeChat` 加 `emitHook` 字段，`newTestService` 注入默认 agent chunk（避免现有测试误触发空响应检测）
- `internal/chat/empty_turn_test.go`：新增 `TestEmptyTurnDetectedAsError` 回归测试

## 验证

- `go build . ./internal/...` 通过
- `go vet` 通过
- `go test ./internal/chat/ -v` 25/25 通过（含新测试）
- `go test ./internal/...` 全部项目包通过

## 下一步

监控生产日志中 `prompt empty turn` 的出现频率。如果频繁出现，说明 omp resume 机制有系统性问题，需深入排查 omp 侧。
