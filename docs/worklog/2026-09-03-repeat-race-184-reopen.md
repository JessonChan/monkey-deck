# #184 reopen:repeat 条目 drain 发送窗口的裸 idx 竞态(复现 + 修复)

日期:2026-09-03
状态:完成(复现套件 + 修复 + 审计,全绿)
任务:Task #28974(基于 main 最新,252c3dd #184 首修与 70500f1 #176 重锚均在位)

## 起因

#184 首修(252c3dd)只改了前端分支,复查发现后端 drain 路径存在同 issue 编号下的既有竞态:
`drainQueue` 采用 dequeue-before-send(exactly-once),取出 due 行时记录 `dueIdx`,然后在
**queueMu 全程不持有**的窗口里跑 `SendMessage`(等 sendMu / spawnMu,期间整个 turn 在跑)。
窗口内任何用户 mutation(Revoke / Reorder / Enqueue / Schedule,各自在 queueMu 下 List→改→Replace
正常工作)都会让 `dueIdx` 陈旧;发送完成后 `rescheduleRepeat`(成功路径)与 `requeueAt`(失败路径)
拿**裸过期 idx** 重插 → repeat 条目插错位。

## 根因

- `dequeueDue` 返回 `(row, dueIdx, bool)`,drain 把 `dueIdx` 携带穿过锁外窗口;
- `rescheduleRepeat` / `requeueAt` 用 `idx`(仅 clamp 上界)做 `rows[:idx] + row + rows[idx:]` 插入;
- 索引是位置快照,不是身份 —— 窗口内前置行被删/被移走后,idx 指向的语义位置已漂移。

## 阶段一:竞态复现(硬前置,先复现后修)

**确定性交错门**:测试先持 `ls.sendMu` 再 `go svc.drainQueue(sid)` —— drain 的
`dequeueDue` 正常落库,随后 `SendMessage` 阻塞在测试持有的 sendMu 上(dequeue 完成由
store 轮询证实,非时序赌运气);窗口内经**真实 binding** 注入 mutation;解锁后发送完成、
重插执行。`fakeChat` 的 block/started/release 通道沿用既有测试基建。

矩阵(`internal/chat/queue_race_repro_184_test.go`,基底 `[A(future), R(due repeat), B(future)]`,
R 的后继锚 = B):四类注入单发 + 组合×前后序,共 14 个 reschedule 场景 + 1 个 requeue 场景。

**修复前(RED)结果**:

| 组合 | 结果 |
|---|---|
| revoke earlier row | ❌ 实际 `[normal, tick]`,want `[tick, normal]` |
| reorder successor over earlier / reorder earlier after successor | ❌ 错位 |
| enqueue tail | ✅ 对照组(插入点恰好不变) |
| schedule other row | ✅ 对照组(不改位置) |
| revoke successor anchor | ✅ 对照组(锚消失→尾,恰与裸 idx 一致) |
| revoke↔enqueue / reorder↔enqueue / revoke↔schedule / schedule↔revoke / reorder↔revoke(全部前后序) | ❌ 错位 |
| enqueue then reorder onto new tail | ❌ 错位 |
| requeue 窗口(busy 拒绝 + 注入) | ❌ 实际 `[normal, tick, C]`,want `[tick, normal, C]` |

**判定**:11/15 确定性复现。危害类别 = **位置违约**(repeat 行落错位);全部组合中
**零丢失、零字段损坏** —— 与结构性论证一致:`idx > len` clamp 排除丢失;窗口内该行不在
列表里,任何 binding 按 ID 寻址都碰不到它的字段。假说「裸过期 idx 重插」成立,进阶段二。

## 阶段二:修法(按 ID 锚定位,拒绝裸 idx)

- `dequeueDue` 增返**后继锚**:原 `dueIdx+1` 行的 ID(无后继记 `""`);idx 不再出锁;
- 新增 `insertAtSuccessor(rows, successorID, row)`:在**当前 List** 按后继 ID 定位插入点,
  后继已消失(或本无后继)→ 尾部;
- `rescheduleRepeat` / `requeueAt` 签名改 `successorID`,弃用裸 idx(同窗同构,一并修);
- `drainQueue` 传递锚,注释说明窗口竞态。

红线核对:`#176` 重锚公式(`nextAt = prev+interval`,过期 clamp 到 `now+interval`)一字未动;
Send Now(#184 首修)的 `ScheduleQueueItem` 分支行为不变(后端该方法零改动,前端零改动);
stop-intent 语义不动;#192 冻结面未触碰(改动仅 `internal/chat/queue.go` 的 drain 重插机制)。

## 阶段三:internal/chat 全量「List→内存改→Replace」审计

| 路径 | queueMu 覆盖 | 位置陈旧性 |
|---|---|---|
| EnqueueMessage | defer Unlock 全覆盖 | 尾部追加,无 idx ✓ |
| RevokeQueueItem | defer Unlock | idx 现场定位即用 ✓ |
| EditQueueItem | defer Unlock | idx 现场,原地改 Text ✓ |
| ScheduleQueueItem | 手动 Lock/Unlock 全覆盖,解锁后才触发 drain | idx 现场,不改位置 ✓ |
| ReorderQueueItem | 同上 | 双 ID 现场;splice+insert 同一快照、同一临界区 ✓ |
| SetQueueItemRepeat | defer Unlock | idx 现场,原地改字段 ✓ |
| dequeueDue | defer Unlock | idx 现场 splice;锚取自同一锁内快照 ✓(本次修复) |
| rescheduleRepeat | defer Unlock | **已修**:insertAtSuccessor ✓ |
| requeueAt | defer Unlock | **已修**:insertAtSuccessor ✓ |
| syncQueueSnapshot | 只 List+arm+emit,无 Replace | 只读,无陈旧写 ✓ |

结论:**无同窗残留**。唯一跨锁携带物是不可变的锚 ID(身份,不会陈旧;后继消失的降级路径
= 尾部,已在矩阵对照组钉死)。备注(单列,不属本窗、不修):drain guard 持有期间到达的
mutation 触发型 `go drainQueue` 会被折叠丢弃,靠下一次 turn tail / 定时器补位 —— 属唤醒语义
的既有 best-effort,非 List→Replace 陈旧性问题。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `internal/chat/queue.go` | dequeueDue 返回后继锚;rescheduleRepeat/requeueAt 弃裸 idx 改 insertAtSuccessor(#184) |
| `internal/chat/queue_race_repro_184_test.go` | 新增:确定性竞态矩阵(reschedule 14 场景 + requeue 窗口),修复前红/修复后绿 |
| `internal/chat/empty_turn_test.go` | 既有 -race 裸变量脚手架改用线程安全 statusRecorder(验收门槛要求,见下) |
| `internal/chat/error_code_test.go` | 同上(waitErrorStatus 改走 recorder) |

## 验证

- 复现套件修复前 RED(11/15 复现)、修复后 GREEN(15/15),两态均实跑;
- `go test ./internal/chat/` 全绿;`go test ./internal/chat/ -race` 全绿(整包一轮);
- `go vet ./internal/chat/` 过;`go build ./...` 过(wails3 generate bindings + frontend build 后);
- **-race 门槛说明**:整包 -race 首轮在**未改动的干净树上**即红(6 处 WARNING,4 个测试:
  TestEmptyTurnDetectedAsNotice / TestEmptyTurnAfterElicitDeclineIsSilentIdle /
  TestRunPromptDisconnectEmitsCode / TestRunPromptBrokenPipeEmitsCode)—— 根因是这 4 个测试用
  裸 `var lastPayload` 闭包接 emit(runPrompt goroutine 写、测试 goroutine 读,无同步),与队列
  改动无关(已 stash 对照实证)。验收要求 -race 全绿,故按包内既有 `statusRecorder`/
  `captureStatuses`/`lastPayloadOf` 线程安全基建(prompt_error_test.go 注释明言「so a bare
  struct is not caught by -race」)最小转换这 4 处脚手架,独立 commit,不与修复混装;
- 前端零改动(#184 Send Now 分支的 mount 测试走 binding spy,不受后端签名影响)。

## 下一步

- 无遗留;#184 reopen 可关闭(由 orchestrator 处置)。矩阵如需扩列(如 SetQueueItemRepeat
  注入、多 repeat 行并发 drain),在 `queue_race_repro_184_test.go` 加表项即可。
