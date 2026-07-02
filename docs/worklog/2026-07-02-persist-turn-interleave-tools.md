# 2026-07-02 persist-turn-interleave-tools

## 起因(用户报告)
实时对话中思考/回复/工具**交错**出现,行为正确;但**重开会话**后,思考和回复顺序正常,工具却**全聚到该 turn 的末尾**。用户判断:聚合策略应是「相邻聚合」,而非「跳过所有回复/思考把工具堆到末尾」。

## 还原现场
1. **DB 落库顺序错乱**(`internal/chat/chat.go` 旧 `persistTurn`):
   ```go
   for _, seg := range segments { AppendMessage(...) }   // 先写完所有 segment
   for _, t := range tools    { AppendMessage(...) }     // 再写所有 tool
   ```
   一轮内若事件流为 `thought → tool1 → agent → tool2 → agent`,DB `messages.seq` 顺序变成 `[thought, agent, agent, tool1, tool2]` —— 真实时序丢失。
2. **重开加载**:`LoadMessagesPage` 按 `seq` 升序返回 → `messagesToItems` 顺序还原 → 工具卡片全堆 turn 末尾。实时流式时前端 `applyEventToItems`(`streamMerge.ts`)是按事件到达顺序逐条 push,故实时正确;只有重开(走 DB)错乱。
3. **根因确认**:`liveSession` 用 `segments []segEntry` + `tools map[string]*toolAccum` **两条独立时间线**追踪,天然无法表达交错;`handleEvent` 的 `flushCurrentSegment` 只往 `segments` 追加,`tool_call` 只往 map 注册,二者无公共时序。

## 改法(统一时序队列)
1. 引入 `turnItem`:`{kind:"segment"|"tool", seg, tool}`,一轮的**单一时序队列**。
2. `liveSession.segments` → `liveSession.items []turnItem`;`tools` map 保留(快速查找 update),其指针与 items 里 tool 项**共享**。
3. `flushCurrentSegment`:追加 segment 项。
4. `handleEvent.tool_call`:flushCurrentSegment(可能产 segment 项)→ 建工具指针 → **按当前位置入队**;重复 tool_call(异常)就地更新不动位置。
5. `handleEvent.tool_call_update`:已存在 → 就地改 `*toolAccum` 字段(指针共享,items 直接生效),**不动队列位置**(与 §5.4 #10 单调状态、#11 不打断流式 协同);孤儿 update(无对应 tool_call)兜底建条入队。
6. 抽 `finalizeTurnItems()`(flush 残留 thought/agent buffer 进 items,返回完整队列),`runPrompt` 与 `SendAndWaitSync` 收尾**共用** —— 消除两处重复的 finalization 代码。
7. `persistTurn(sessionID, items []turnItem)`:按 items 序逐条写库,segment/tool 交错。

## 改了哪些文件
- `internal/chat/chat.go`:turnItem 类型;liveSession 字段 segments→items;resetBuffers/flushCurrentSegment 改用 items;新增 finalizeTurnItems/segmentEntries 辅助;handleEvent tool_call/tool_call_update 入队;runPrompt + SendAndWaitSync finalization 复用 finalizeTurnItems;persistTurn 重写为按 items 序写库。
- `internal/chat/segment_test.go`:断言从 `ls.segments` 改为 `ls.segmentEntries()`(段边界回归不变)。
- `internal/chat/turn_order_test.go`(新增):三个回归测试 —— ① items kind 序列与事件到达顺序一致(交错);② tool_call_update 不动位置、不新建多余项、字段就地更新;③ persistTurn 写库顺序 = 真实时序(thought→tool→agent,旧实现会写 thought→agent→tool → 测试 fail)。
- `AGENTS.md` §5.4:新增坑 #12。

## 验证
- `go test . ./internal/...` → 9 packages ok, 2 no tests(全绿)。
- 新测试 verbose:`TestTurnItemsInterleaveToolsInOrder` / `TestToolCallUpdateDoesNotMovePosition` / `TestPersistTurnWritesItemsInOrder` 全 PASS。
- `git stash` 验证:旧代码无 `finalizeTurnItems`/`items`,新测试直接编译失败 → 确认测试与新 API 强绑定,能守住修复。
- 未改前端;前端 `streamMerge.ts` 实时路径本就正确,只是重开走 DB 时被 DB 顺序带歪 —— 现在后端 DB 顺序对了,重开即正确。

## 下一步
- 真机回归:跑一个 thought→tool→agent→tool→agent 的 turn,关掉重开,确认工具卡片夹在思考/回复之间,不再堆末尾。
- 注意:历史已落库的旧 session(用旧 persistTurn 写的)仍是错序,无法回溯修正(seq 已定);仅新 turn 起按正确顺序写。如需修正旧数据,需写迁移脚本按 tool_call 时间戳重排 —— 当前判定不值得(本地单用户,重跑即可)。
