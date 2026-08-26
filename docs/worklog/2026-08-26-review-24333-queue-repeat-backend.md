# 2026-08-26 Review #24333 队列循环发送后端:migration 0019 / rescheduleRepeat 公式 / SetQueueItemRepeat 校验 / 唤醒链闭合

## 起因

Task #24334:backend review #24333(#111 队列循环发送后端,commits `f7accbe`/`2bde4ac`;`63b02d4` 前端归前端 reviewer)。
审四件事:migration 正确性、rescheduleRepeat 公式与唤醒链(循环项会不会静默停摆)、SetQueueItemRepeat 校验面、
测试锚定质量。附带反模式检查:类型补丁(字段加了没人消费)、测试断言锚定值。

## 核查结论(逐项)

### 1. migration 0019 —— PASS

- `ADD COLUMN ... INTEGER NOT NULL DEFAULT 0` × 3:SQLite 合法(常量默认值满足 NOT NULL 约束)。
- 多语句单文件是既有模式(0001 起),runner `s.db.Exec(string(b))` + modernc sqlite 全量执行,无新风险;
  embed `ReadDir` 按文件名排序,0019 必在 0018(建表)之后跑,新库/升级库两条路径都成立。
- 列不设 CHECK 约束、边界交给 chat 层——注释说明了理由(边界可演进免迁移),合理。

### 2. rescheduleRepeat 公式与唤醒链(本次审查的核心问题)—— PASS

**公式**:`nextAt = max(now, prevScheduledAt + interval)`、`sentCount` 仅成功递增(失败 requeue 不加)、
`maxSends` 到量即不回插(出队已消费 = 自然清循环)。逐行核对 `internal/chat/queue.go:455-488` 无误;
`requeueAt` 不检查 MaxSends——正确,失败发送不消耗预算。

**唤醒链闭合性**(循环项是否可能 due-now 却无人唤醒而停摆)——关键事实:**SendMessage 是异步的**
(chat.go:1976 → startTurn:2035 `go s.runPrompt` 后即返回),故 rescheduleRepeat 在 turn 进行中执行:

- 正常路径(turn < interval):nextAt 在未来 → `armQueueTimerLocked` 起 timer → 到点 drain。
- timer 到点但上一 turn 仍在跑:SendMessage 返 busy → `requeueAt` 原位回插(due-now,不 arm timer)
  → 当前 turn 结束的尾 drain(`go s.drainQueue`,chat.go:2221-2282 六终态)重试。闭合。
- 停机/spawn 失败路径:reconnect 成功后显式 re-drain(chat.go:1912,注释恰好写的就是这条路径)。闭合。
- 重锚 now 的项(turn ≥ interval):due 立即、无 timer,由本轮 turn 尾 drain 接走 → 背靠背续发。
  这与 commit/worklog 声明的「重锚 now」语义一致(cron-like:单轮长于周期时无间隙续发),行为确认非缺陷。

**锁纪律**:新调用点(SetQueueItemRepeat/rescheduleRepeat)全部 queueMu 内改状态、SendMessage 在锁外,
`armQueueTimerLocked` caller-holds-lock 契约无违反;AfterFunc 自引用经 queueMu 边界读(既有 gotcha 注释仍在)。

### 3. SetQueueItemRepeat 校验面 —— PASS

- interval 硬门槛 [1min, 24h] **含边界**,0(清循环)恒合法;`errQueueRepeatInterval` 哨兵 `%w` 包装,
  `errors.Is` 可判 + 消息带 `queue_repeat_interval_invalid:` 稳定前缀(两种判法都有测试钉住)。
- `maxSends < 0` 拒绝;未知 itemID 拒绝;不动 scheduledAt(与 #97 定时语义的正交性有注释、有测试侧证)。
- `wireQueueItems` 透出 repeatEveryMs/sentCount(快照断言钉住),`emitQueue` 空归一 `[]` 既有行为未动。

### 4. 反模式检查 —— PASS

- **类型补丁**:无承重性未消费字段。repeatEveryMs/sentCount 全链路消费(store 列 → List → wire →
  `chat:queue` 事件,`queueEventCapture` 断言快照携带);`MaxSends` 由 rescheduleRepeat 上限逻辑真实消费
  (行为测试:恰好 2 发后队列清空且无第 3 发)。`frontend/bindings/` 为 gitignore 中间产物(`wails3 gen
  bindings` 再生成),不入库是既有约定。
- **断言锚定值**:TestQueueRepeatRearmFormula 断言 `ΔScheduledAt ∈ [iv-10, iv+40]` / `[2iv-10, 2iv+60]`
  (钉住 prev-anchored cadence 而非「值变了」);`countPrompts(fc, "tick")` 数真实 Prompt 调用次数(2/1/2
  精确值);skip-catch-up 断言重锚落点 ≥ 发送时刻(排除 catch-up 回填);maxSends 断言队列空 + 无第 3 发;
  校验测试断言精确字段值(5*60_000/3/0)。正是锚定式断言。
- 测试纪律:全 fakeChat(§5.1 不启真 harness)、store 测试临时文件库(§5.2)、新注释全英文(§3.7)。

### 5. P3 观察(不阻塞,记录备查)

1. **wire 面缺 MaxSends**:binding 收 maxSends、后端消费它,但 `chat.QueueItem`(wire 形状)不带它——
   设了上限的客户端无法从快照读回当前上限。前端今日恒传 0,潜伏不对称;若未来 UI 加「发 N 次」档需补透出。
2. **odometer 语义**:对 sentCount 已 ≥ maxSends 的项再设 maxSends,仍会多发一次才清(检查在发送后);
   清循环再重设,sentCount 里程不清零。migration 注释即按「总里程计」描述,语义自洽,仅提醒未来接线时知晓。
3. **rescheduleRepeat 的 store 失败丢行**:出队已消费、List/Replace 失败仅 slog.Warn → 循环项永久丢失。
   与既有 requeueAt 同失败形状(本地 SQLite 罕见),status quo 一致,不算本次回归。

## 验证

- `go build ./internal/...` + `go vet ./internal/...`:干净(根包 embed 失败为 worktree 缺 `frontend/dist`
  的预存在环境问题,与 #24308 review 记录一致,非本次回归)。
- `go test ./internal/store`(1.0s)+ `./internal/chat`(16.8s):全绿。
- `go test -race -count=5 -run 'TestQueueRepeat|TestQueueUserStopSkipsRepeatItem|TestQueueRevokeDeletesRepeatItem|TestSetQueueItemRepeatValidation' ./internal/chat/`:稳定通过(时序容差 60ms 档在本机无抖动)。
- 三端矩阵(§4.7/§5.6):本次 review 范围零前端改动;后端能力(列/循环/校验)由 mock 单测 + store roundtrip
  覆盖,等价后端统一验证;`chat:queue` 快照携新字段已由 emitHook 捕获断言(wire 形状),浏览器/PWA 端走同一
  WS 事件面,无端特定分支。

## 结论

**APPROVE**——四项门槛(migration / 公式+唤醒链 / 校验面 / 测试锚定)全部核实通过,无阻塞项;
3 条 P3 观察记录在案(均在「未来 UI 加 maxSends 档」成为现实时才需要回头处理)。

## 下一步

- 若 #111 后续加「发 N 次后停」UI 档:补 wire 透出 MaxSends + 重设时里程清零语义决策(P3-1/P3-2 一并处理)。
- 桌面真机冒烟(随 #111/#126A 既有待办):1min 档循环消息跨 app 重启后继续按时发。
