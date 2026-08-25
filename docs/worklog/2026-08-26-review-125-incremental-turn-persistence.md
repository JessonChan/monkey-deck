# 2026-08-26 Review:#125 增量落库(UpsertTurnMessage + 1s 防抖 flusher + persistTurn reconcile)

复审对象:main 上 `96eb11c` + `4411e1b` + `36560ec`(实现 worklog 见
`2026-08-25-incremental-turn-persistence.md`)。Backend reviewer 视角,聚焦
internal/(store / chat)、并发正确性、迁移、测试质量。

## 结论:PASS(1 处硬约束违规已由本次 review 修复)

## 逐项核验

1. **并发不变量(核心设计)——成立,逐路径推演过**:
   - 陈旧 flush 不可能覆盖终态:runPrompt 在 reconcile 前先清 `currentTurnID`
     (chat.go:2146);`flushTurn` 在 `persistMu` 临界区内经
     `takeDirtyTurnItems` 重验 turnID,不匹配即 no-op。flush 与 reconcile 经
     `persistMu` 串行,「flush 部分内容 → reconcile 终态」的写序恒定。
   - 锁序一致:唯一的嵌套方向是 `persistMu → ls.mu`(flushTurn);persistTurn
     先持 ls.mu 快照再释放、后取 persistMu,无反向嵌套;persistHook 在无锁区
     调用(可阻塞)。无死锁路径。
   - 每个脏登记必有消费:flush 整体消费脏集;`markTurnDirty` 在脏集非空时保证
     至少一个 pending timer。已知一个无害毛刺:`takeDirtyTurnItems` 对陈旧
     return 也无条件 `flushTimer = nil`,可能把新 turn 的 pending timer 引用清
     掉 → 后续事件多排一个 timer → 多一次 no-op flush。幂等,无数据风险,
     不值得加代码(§5.3 Less is More),仅记录。
2. **seq 语义**——首写定位置、重放不重排,与 §5.4 #5 一致;upsert 循环内
   MAX(seq)+1 单调;同 session 的写者经 sendMu/persistMu 串行,无 seq 搏斗。
   理论边角:flush 时空白消息被 skip、reconcile 才首写的 entry 会排到已 flush
   的更晚 entry 之后(时序倒置)——但触发需 messageId 跨 tool 边界复用
   (omp/opencode 每条消息唯一 id;fallback 路径 tool_call 即轮换 key),已知
   harness 均不可达。记录不修。
3. **迁移 0017**——partial unique index(`WHERE entry_key != ''`)使存量空键
   旧行不参与去重;upsert 的 conflict target 与索引定义逐字匹配;embed
   `migrations/*.sql` 自动收录;`TestMessageTurnKeysMigrationOnExistingDB` 覆盖
   旧库重开。`created_at` 随写刷新(36560ec)语义核验:reconcile 必最后写终态
   ⇒ 终态 ts ≈ turn end,与旧「回合结束统一落库」等价,#68 时长不受影响。
4. **测试质量**——断言锚定具体值(「你好,世界」全文、role 序 thought→tool→
   agent、`want 1 row got %d`),无「字段存在即过」的通过假象;并发测试配
   `-race` 过;无类型补丁(但见下)。TurnID/EntryKey 全链路有消费:store
   upsert/getTurnMessage 往返 + plan 行 toolCallID=turnID 钉 turn(前端既有
   消费)。
5. **验证实跑**:`go build/vet ./internal/...` 干净;`go test ./internal/store
   ./internal/chat` 全绿;`-race` 相关子集全绿;全量 `-race ./internal/chat/`
   4 个失败(empty_turn/error_code)——**在基线 8b8368c(#125 之前)建临时
   worktree 实跑复现同样 4 失败**,确证预存、非本次引入,与实现 worklog 的
   stash 实证一致。OPEN(测试 recorder 加 mutex)维持,不夹带。

## 发现与处置

- **[fixed] §3.7 硬约束违规(本次 review 修复)**:三个 commit 新增的注释全部
  为中文(§3.7 自 2026-07-29 dc91eff 起生效,远早于本改动;同日 commit
  4e5c493 即为英文注释范例)。已把 #125 新增的注释全部转英文:
  `turnpersist.go`、`turn_persist_test.go`、`messages.go`、`messages_test.go`、
  `store.go`(字段注释)、`chat.go`(#125 新增的 5 处注释块)、`queue_test.go`
  (1 处行内)。触及范围内的旧中文注释未动(不属本次改动触及面)。纯注释/
  失败消息文案改动,零行为变化。
- **[note] takeDirtyTurnItems 陈旧分支清 flushTimer**:见上 1,幂和无害。
- **[note] 空白消息 skip 的理论时序倒置**:见上 2,已知 harness 不可达。
- **[note] TouchSession 随每次 flush 刷 updated_at**:侧栏主排序键是
  prompted_at(不受影响),updated_at 流式期间前移反而更准确,非回归。

## 三端(§4.7)

本次 review 改动 = 注释翻译(零行为)+ worklog。后端能力(#125 本体)在单测
层验证;#125 对前端仅 ChatView.tsx 注释更新 + ListMessages 形状只增字段
(`omitempty`),零 UI 行为变化(实现 worklog 已声明,本次复核认同),三端
无回归面。

## 下一步

- 无阻塞项。可选小任务:修预存 `-race` 4 失败(测试 recorder 加 mutex,
  实现 worklog OPEN 已记)。
