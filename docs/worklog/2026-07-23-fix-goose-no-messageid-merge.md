# 2026-07-23 修复 goose 无 messageId 流式合并碎片化

## 起因

用户用 goose 跑了一个 session(`180b74f4…`,harness=goose,任务"检查未提交代码"),前端异常:**只剩 chunk 文字**。查 DB 发现有 **853 条 `agent_message_chunk`** 各存一行(每条 1-3 字的增量碎片),而 omp/opencode 同类回复只存 1 行。

## 根因(协议调研 + 实证)

`messageKey`(`internal/chat/chat.go`)无 messageId 时调 `nextSyntheticID` **每条 chunk 生成唯一 key** → `ls.index[id]` 永远 miss → 每条 chunk 新建 entry → 碎片化。

**关键定性:goose 没有违反 ACP 协议。** SDK 里 `messageId` 标注 `**UNSTABLE**`(尚未进 spec)+ `*string`+`omitempty`(可选)。omp/opencode 选择发 messageId(用这个 UNSTABLE 扩展),goose 不发(只用稳定子集)——两者都合规。bug 是我们的:把 UNSTABLE/可选的 messageId 当成了稳定不变量(§5.3「外部事实先验证再动手」反例)。

实证:该 session 的 853 条 agent chunk **0 条含 messageId**。

## 改法

正确不变量(无 messageId 时):连续同 role chunk = 同一条消息;tool_call / turn 结束 = 断段。边界信号从 messageId 换成 tool。

1. `liveSession` 加 `syntheticGen int` 字段。
2. `resetBuffers` 重置 `syntheticGen = 0`(每轮清)。
3. `handleEvent` 的 `tool_call` 分支 `ls.syntheticGen++`(新工具 = 段边界)。
4. `messageKey` empty 分支:从 `"msg:_"+role+":"+nextSyntheticID(ls)`(每条唯一)改为 `"msg:_"+role+":"+strconv.Itoa(ls.syntheticGen)`(稳定:连续同 role 归并,tool 后落新段)。
5. 删 deadcode `nextSyntheticID`(修后无调用者)。

**对 omp/opencode 零影响**:它们发 messageId,走 `messageKey` 的 `if messageId != ""` 分支(未改)。即便偶尔命中 empty 分支,新逻辑(合并连续同 role)也比旧的"每条碎片"更对。

## 改了哪些文件

- `internal/chat/chat.go`(liveSession 字段 + resetBuffers + handleEvent tool_call + messageKey + 删 nextSyntheticID)
- `internal/chat/segment_test.go`(更新无 messageId 测试的过时注释 + 新增 `TestSegmentMergeNoMessageIdConsecutive` 回归:连续同 role 合并 + tool 边界断段)

## 数据修复

858 行 → 9 行。DB 备份:`monkey-deck.db.bak-before-chunkfix-20260723-194238`。
按 tool 边界合并连续 `agent_message_chunk` 增量碎片:4 段(agent 段 ↔ tool_call 交错),重建出连贯中文(如"我来看看当前未提交的代码改动。"、最后一段 1857 字是 goose 对这批未提交代码的完整分析)。逻辑与新代码一致。

## 验证

- `go build . ./internal/...` ✅;`gofmt -l` 干净;`nextSyntheticID` 无残留引用。
- `go test ./internal/chat/` ✅,含新增 `TestSegmentMergeNoMessageIdConsecutive`(复现 goose bug:旧逻辑会碎成 5 段,新逻辑正确合并成 2 段)。
- 既有 `TestSegmentBoundaryReset`(omp/opencode messageId 路径)、`TestSegmentBoundaryNoMessageId`(role 变化边界)均仍 PASS。
- 数据修复后该 session 9 行结构正确(user + 4 agent 段 + 4 tool_call,时序交错)。

## 下一步

- 实机 `wails3 dev` 重开该 goose session 确认渲染正常(4 个 agent 气泡 + 工具卡片)。
- 确认无误后可删 DB 备份。
- 前端 `streamMerge.ts` 的 empty-messageId 回退已正确(找最后一个同类型 streaming item 归并 + tool finalize),本次纯后端修复即同时修好实时流式与重开历史。
