# 2026-07-02 timeline-key-merge-refactor

## 起因
前两个 bug(§5.4 #11 message-duplication、#12 工具堆末尾)经全景分析,确认是**同一设计缺陷的两个症状**:用"上一个事件类型"启发式猜分段,而非用协议给的稳定标识(`messageId`/`toolCallId`)归并。经 omp/opencode TUI 层实证(两者都用"稳定标识驱动的对象归并"),决定做一次根除性重构,而非继续打补丁。

## 设计(对标 omp/opencode 的对象归并模型)
核心:把"事件流拼数组"升级成"按稳定主键归并的单一时序队列"。

- **归并主键**(都来自 ACP 协议,非 harness 专有):
  - message:`messageId + role` 复合。同 messageId+role 的 chunk 归并到同一条 entry(thought/text 各一)。
  - tool:`toolCallId`。tool_call 注册新 entry;update 就地 patch,不动位置。
  - messageId 为空(协议 UNSTABLE,harness 可能不发)→ 回退"role 变化/被 tool 打断=新 entry"(降级 fallback)。
- **单一时序队列**:后端 `liveSession.timeline []*turnEntry` + `index map[string]*turnEntry`;前端 `streamMerge.ts` 同构。
- **构造性消灭**:`tool_call_update` 按 toolCallId 只命中 tool entry,物理上碰不到 message → #11 消灭;timeline 单一有序,persistTurn 按序写库 → #12 消灭。

## 协议验证(不改代码先验证走得通)
- opencode(`references/opencode/.../acp/event.ts`):agent/thought/user chunk 全填 `messageId`(=内部 message id);chunk content 发 delta(增量);tool:tool_call 一次 + 后续 tool_call_update。
- omp(`references/oh-my-pi/.../acp-agent.ts` + `acp-event-mapper.ts`):message chunk 填 `messageId`(`#getLiveMessageId` 按 message 生命周期生成 UUID,message_start 换 id);chunk content 发 delta;async task 后台 onUpdate 在 execute() 返回后仍发 tool_call_update(#10/#11 根源)。
- 结论:两 harness 都完整实现 messageId,设计纯基于 ACP 协议,无 harness 专有依赖。

## 改了哪些文件
**后端(`internal/`):**
- `acp/handler.go`:`SessionEvent` 加 `MessageID` 字段;`flattenUpdate` 透传 messageId(agent/thought/user chunk)。
- `chat/chat.go`:删除旧三套表示(`segments`/`items`/`tools`/`agentBuf`/`thought`/`lastChunkKind`/`flushCurrentSegment`/`finalizeTurnItems`/`segEntry`/`turnItem`);引入 `turnEntry`(`id`/`kind`/`role`/`text`/`tool`/`final`);`liveSession` 改 `timeline []*turnEntry` + `index map[string]*turnEntry`;`handleEvent` 按主键归并(`messageKey` messageId 优先 + role 回退,`nextSyntheticID` 兜底);`resetBuffers`/`finalizeTurn`/`appendEntry`/`segmentEntries`/`toolByID`(测试用);`persistTurn` 按 timeline 序写库;`runPrompt`/`SendAndWaitSync` 收尾改 `finalizeTurn()`。
- 测试:`segment_test.go`(改用 segmentEntries + 新增无 messageId 回退用例)、`monotonic_status_test.go`(改用 toolByID)、`turn_order_test.go`(改用 timeline + 新增 TestMessageIdMergeSurvivesToolUpdateInterleave)。

**前端(`frontend/src/`):**
- `types.ts`:`SessionEvent` 加 `messageId?`;`ChatItem` 的 user/agent/thought 加 `messageId?`。
- `lib/streamMerge.ts`:重写为主键归并(messageId+role 优先,无则 role 回退),保留 tool_call/tool_call_update 分离(update 不打断流式)。
- `lib/streamMerge.test.ts`:10 个用例(同 messageId 归并、messageId 变化新消息、thought+agent 同 messageId 共存、update 穿插不拆分、无 messageId 回退、乱序忽略、tool_call 段边界、tool 字段更新)。

**文档:** `AGENTS.md` §5.4 #11/#12 重写为最终架构描述。

## 验证
- `go test . ./internal/...` → 9 packages ok, 2 no tests(全绿)。
- 后端新测试 verbose:TestSegmentBoundaryReset / TestSegmentBoundaryNoMessageId / TestTimelineInterleaveToolsInOrder / TestToolCallUpdateDoesNotMovePosition / TestPersistTurnWritesItemsInOrder / TestMessageIdMergeSurvivesToolUpdateInterleave / TestToolStatusMonotonicNoRegression 全 PASS。
- `bun test` → 10/10 pass;`tsc --noEmit` → 0 错;`bun run build:dev` → 成功。
- 未改 DB schema(messages 表零改动,只是写入顺序由 timeline 决定);未改前端渲染层(DB 历史 item 用 DB id,无 messageId,与实时流式不冲突)。

## 下一步
- 真机回归:用 omp 跑含 async task 的 turn,确认不再出现累积前缀重复气泡;关掉重开确认工具交错顺序正确。
- 渲染层分组(可选):同 messageId 的 thought+agent 气泡间不画 turn 分隔线(视觉归属),属 UI 打磨,不挡正确性。
