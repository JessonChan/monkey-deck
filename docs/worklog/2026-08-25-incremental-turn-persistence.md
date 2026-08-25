# 2026-08-25 实现:#125 turn 增量落库(UpsertTurnMessage + 1s 防抖 flusher + persistTurn 改 reconcile)

## 起因

流式 turn 的全部产出(thought / agent 消息 / tool 卡片)原先只在**回合结束**由 `persistTurn`
统一写库。回合进行中 app 崩溃 / 被杀 / 强退时,本轮已流出的部分回复整体丢失(DB 里只有 user
消息)——用户重开会话看到「自己问了、agent 没答」,而实际 agent 答了一半。

需求(#125):turn 内容**增量落库**,崩溃最多丢一个防抖窗口的内容,而非整轮。

## 设计

数据模型不变量先行(§5.3):timeline 是唯一真相、只追加不移位(§5.4 #5/#12)。增量落库
就是把「写库时机」从 turn 结束一次,改成「turn 进行中防抖批量 upsert + turn 结束 reconcile
收敛」两层,靠**稳定主键**幂等归并,而不是靠时序启发式。

1. **upsert 主键 = `(session_id, turn_id, entry_key)`**(migration 0017):
   - `turn_id` = 开启该 turn 的 user message id(client 生成,已存在于 startTurn);
   - `entry_key` = timeline entry id(`msg:<messageId>:<role>` / `toolCallId` / fallback 键)。
     fallback 键每个 turn 会重复(`msg:_fb:1:agent`),`turn_id` 消歧。
   - **partial unique index**(`WHERE entry_key != ''`):迁移前的旧行、以及 AppendMessage
     写的 user 消息(entry_key='')落在索引之外——多条共存合法,建索引不会在存量数据上炸;
     upsert 用 `ON CONFLICT(session_id,turn_id,entry_key) WHERE entry_key != ''` 精确指向它
     (modernc.org/sqlite 支持 partial-index conflict target,单测实证)。
   - **seq 只在 INSERT 定**:首写定位置,重放不重排(timeline 不移位 ⇒ seq = 真实时序)。
   - **created_at 随写刷新**:收尾 reconcile 最后写最终全文 ⇒ 终态 created_at ≈ 回合结束,
     与旧「回合结束统一落库」的时间语义一致(前端 #68 回合时长依赖「最后一条消息 ts =
     turn end」,不能让 created_at 停在首 flush 时刻把时长算短)。

2. **1s 防抖 flusher**(`internal/chat/turnpersist.go`):
   - `handleEvent` 里 message chunk / tool_call / tool_call_update 弄脏 entry 后
     `markTurnDirty`(持 ls.mu):登记脏 + 若无排定定时器则 `time.AfterFunc(1s)`。
   - 防抖语义是「**首个**脏事件后 1s」(trailing throttle),不是「最后一个事件后 1s」——
     持续流式的长 turn 不会饿死 flush,写库间隔上界恒为 1s。测试可注入短间隔加速
     (`turnFlushEvery`,newTestService 注入 5ms)。
   - flush 回调:持 `ls.persistMu` → 在临界区内重验 turnID → ls.mu 下快照脏条目(必须持锁:
     strings.Builder / toolAccum 非并发安全)→ 逐条 `UpsertTurnMessage`。
   - **陈旧 flush 不可能覆盖终态**:reconcile 前 runPrompt 必先清 `currentTurnID`;flush 在
     persistMu 临界区内重验 turnID,不匹配即 no-op。persistMu 把 flush 与 reconcile 串行,
     消灭「旧快照后到、盖住最终全文」的写序竞态(§5.4 #9 教训:先想清楚谁是生产者消费者)。

3. **persistTurn 改 reconcile**(签名 `persistTurn(ls, sessionID, turnID, timeline)`):
   停排定定时器 + 清脏 → ls.mu 下快照整条 timeline 终态 → 持 persistMu 逐条 upsert。
   已 flush 的行就地更新为最终全文,未 flush 的插入;重复调用 / 与任意次 flush 交错,结果一致。
   `persistTurnPlan` 同步改走 UpsertTurnMessage(entry_key="plan"),重复收尾不再可能留重复行。

4. **无在跑 turn 不增量**:turn 结束后到达的迟到异步 tool 更新(`currentTurnID=""`)不登记
   脏——与改动前行为一致(迟到的本来就不落库),终态由 reconcile 全权负责。`resetBuffers`
   (turn 边界)显式停掉遗留定时器并清脏,防跨 turn 干扰。

## 改动文件

- `internal/store/migrations/0017_message_turn_keys.sql`(新):turn_id/entry_key 列 + partial
  unique index。
- `internal/store/store.go`:Message 增 TurnID/EntryKey(json: turnId/entryKey,向后兼容)。
- `internal/store/messages.go`:`UpsertTurnMessage` + `getTurnMessage`;ListMessages /
  ListMessagesBefore 的 SELECT/Scan 补新列。
- `internal/chat/turnpersist.go`(新):markTurnDirty / flushTurn / takeDirtyTurnItems /
  upsertTurnItem / persistTurn(reconcile)/ persistTurnPlan / buildTurnItem。
- `internal/chat/chat.go`:liveSession 增 flushDirty/flushTimer/persistMu;resetBuffers 清防抖
  遗留;handleEvent 三处标脏;ChatService 增 turnFlushEvery(默认 1s);旧 persistTurn /
  persistTurnPlan 移除(移至 turnpersist.go);runPrompt/SendAndWaitSync 调用点改新签名。
- `frontend/src/components/ChatView.tsx`:#68 时长注释更新(机制改为增量 + reconcile 收敛)。
- 测试:`internal/store/messages_test.go`(新,5 个)、`internal/chat/turn_persist_test.go`
  (新,7 个)、`turn_order_test.go` 适配新签名、`queue_test.go` newTestService 注入短防抖。

## 验证

- `go build ./...` / `go vet ./...` 干净;`go test ./...` 全绿。
- 新增单测覆盖:增量可见性(不收尾即有部分内容)、upsert 幂等累积(同 entry 恒一行)、
  reconcile 幂等 + 交错时序(thought→tool→agent)、陈旧 flush no-op、resetBuffers 清遗留、
  并发事件流 × flush(`-race` 通过)、plan 幂等;store 层覆盖 seq 稳定 / 跨 turn 消歧 /
  旧行共存 / 迁移重开。
- `go test -race`:与落库相关子集(含 TestInterruptNoRaceWithRunPromptFinalize、新并发测试)全绿;
  全量 `-race` 有 4 个**预存失败**(empty_turn/error_code 的 emitHook 与测试主体无锁并发,
  在本改动之前的基线同样失败,已 stash 实证)——OPEN 见下。
- 前端:`wails3 gen bindings` 重新生成(Message 含 turnId/entryKey)+ `bun run build`(tsc +
  vite)通过;改动仅注释,无三端行为变化(§4.7:零 UI 改动,历史加载路径 ListMessages 形状
  只增字段)。

## OPEN / 下一步

- 预存(非本次引入):`go test -race ./internal/chat/` 4 个测试因测试代码自身 data race 失败
  (empty_turn_test.go / error_code_test.go 的 emitHook 回调与测试断言读共享切片无锁)。建议
  单独小任务修复(给 recorder 加 mutex),不在本次夹带。
- 增量窗口 = 1s(turnFlushEvery),未做配置化——桌面单用户场景暂无调参需求(KISS)。
