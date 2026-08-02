# 2026-08-02 · Reasonix 流式 chunk 无 messageId → 重新引入 fallback 合并

## 起因
接入 Reasonix(DeepSeek-Reasonix,ACP server)后发现:它的思考和回复在 monkey-deck 里**碎成一堆单 token 气泡**,而非流式拼成一条消息。OMP/opencode 正常。

## 根因(双向代码 + 真实 wire 实测)

### Reasonix 侧:流式 chunk 完全裸,零边界信号
- `internal/acp/protocol.go` 的 `messageChunk` 结构体只有 `{sessionUpdate, content}`,**没有 `messageId` 字段**;全仓 `grep messageId internal/acp/` = 0 处。
- 真实 ACP 调用(探针 `io.TeeReader` 抓原始 wire):"Say hello in one short sentence" 一轮,**12 个 `agent_thought_chunk` + 13 个 `agent_message_chunk`,逐 token,无一含 `messageId`**(也没有 `_meta`/`metadata`/任何替代字段)。
- Reasonix 自己的 TUI(`internal/cli/chat_tui.go` 的 `streamReasoning`/`commitReasoningBeforeAnswer`)和 Desktop(`desktop/`,Wails,进程内直连 agent 走 `event.Sink`)**不走 ACP**——它们消费 agent 的 `event.Event` 流,里面有显式边界事件 `event.Message`(流结束发一次,标记消息完成)。**ACP adapter(`internal/acp/dispatch.go`)的 `Emit` 没有 `event.Message` 的 case,把这个边界信号丢了**,只转发逐 token 的裸 chunk。所以 Reasonix 内部边界信息本就有,只是没经 ACP 暴露。

### monkey-deck 侧:`messageId` 缺失时每 chunk 新开
- `messageKey`(原 `internal/chat/chat.go:2247`)在 `messageId==""` 时走 `nextSyntheticID`——每次调用 `ls.seq++` 返回新唯一 id → `handleEvent` 每次 `ls.index[id]` miss → **每个 chunk 建一个新 entry** → 一个 token 一个气泡 + DB 一行一碎片。
- 对照 OMP:同一 prompt 的 7 个 message chunk 共享同一 `messageId` → 合并成 1 条;DB 里 OMP session 的 agent 行都是完整连贯文本(132/113 字符)。
- **这段 fallback 逻辑以前是有的**:git `22fd697^`(2026-07-02 前)的 `handleEvent` 用 `agentBuf`/`thought` buffer + `lastChunkKind` + `flushCurrentSegment()`——"连续同 role append,role 变化 / tool 打断 = 新 entry"。`22fd697 refactor(chat): timeline 主键归并,根除流式分段启发式(§5.4 #11/#12)` 因它当主路径时炸了两个 bug 把它整体移除,主路径换成 messageId 归并,但 no-messageId 兜底也一并没了,换成更碎的 `nextSyntheticID`。移除主路径启发式是对的,但兜底被误伤。

## 改法
重新引入 fallback,**仅当 `messageId==""` 时启用**,主路径(messageId 归并)不动:

- `liveSession` 加 `fallbackRole string` + `fallbackSeq int64`(均 `ls.mu` 保护)。
- `messageKey`:`messageId != ""` → `msg:<mid>:<role>`(主路径不变);`messageId == ""` → 连续同 role 复用同一 fallback key(role 变化时 `fallbackSeq++` 轮换)→ `handleEvent` 的 `ls.index[id]` 命中既有 entry → `entry.text.WriteString` 累积。
- `tool_call` 分支:`ls.fallbackRole = ""`(硬边界,下个 chunk 开新 entry)。
- `resetBuffers`(turn 开始):清 `fallbackRole`/`fallbackSeq`。
- 删掉只被旧 messageKey 用的 `nextSyntheticID`(死代码)。

这是 §5.3「把启发式降级成 fallback,主干仍是主键归并」的落地,不是违规:发 `messageId` 的 harness 走主键路径完全不受影响。属 best-effort(多段无工具间隔的独立消息会被误并,编码型 agent 单轮罕见);原则正解仍是 harness 侧补 `messageId`。

## 改了哪些文件
- `internal/chat/chat.go`:`messageKey` 重写、`liveSession` 加两字段、`resetBuffers`/`tool_call` 分支补重置、删 `nextSyntheticID`、触及的中文注释转英文(§3.6)。
- `internal/chat/segment_test.go`:更新 `TestSegmentBoundaryNoMessageId`(注释),新增 `TestSegmentFallbackMergeNoMessageId`(Reasonix 场景:3 thought + 2 message 合并;tool 打断不并)、`TestSegmentFallbackIsolatedFromMessageId`(id 路径与 fallback 路径隔离)。
- `AGENTS.md`:§5.4 加 #10(messageId-less harness 坑 + fallback 说明)。

## 验证
- `go build ./...` 通过。
- `go test ./internal/...` 全通过(含新增 3 个测试:reasoning→answer 合并、tool 打断、id 隔离)。
- 逻辑验证:Reasonix wire(12 thought + 13 message,无 id)→ fallback 产 1 条 thought + 1 条 agent;OMP wire(7 message 同 id)→ 主路径产 1 条,行为不变。

## 下一步(OPEN)
- 真机验证:用 monkey-deck 实跑 Reasonix 一个 turn,确认 UI 流式拼成一条(单测已覆盖逻辑,真机是最终确认)。
- 理想方案是给 Reasonix 提 PR:在 `dispatch.go` 给 chunk 加 `messageId`(rotate on Reasoning→Text / `event.Message` / tool 打断)+ 补 `usage_update`(它整轮也没发 usage,prompt 响应也无 usage → monkey-deck 用量面板会是 0)。本 fallback 是 monkey-deck 侧的兜底,不替代 Reasonix 修 ACP。
- Reasonix 的 `reasonix-setup` 终端认证 method,monkey-deck 目前没处理(靠 `~/.reasonix/.env` 预配 key 绕过);若要正式支持需补 auth 流程。
