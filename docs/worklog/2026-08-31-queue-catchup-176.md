# 2026-08-31 queue catch-up 重锚即刻 due(#176)

## 起因

orchestrator 单测复现:混合队列里,逾期 repeat 条目发送后 120ms 内 prompts=[tick tick normal tick tick](RepeatEveryMs=90min 场景)——catch-up 发送后 normal 被插队、tick 被即刻二次发送。

## 根因

`rescheduleRepeat`(internal/chat/queue.go)的 catch-up 钳制:

```go
nextAt := row.ScheduledAt + row.RepeatEveryMs
if now := time.Now().UnixMilli(); nextAt < now {
    nextAt = now   // ← 重锚值恰为 due-now
}
```

逾期(逾期量 ≥ 1 个周期)条目发送后,`prev+interval` 仍在过去 → 钳到 `now` → 重锚行挂成「即刻 due」。drain 触发面(runPrompt turn 尾 / 用户消息尾 / reconnect 重 drain / 队列 mutation)任一到来就二次发送;混合队列中该行还按原位插回,排在 due 的普通消息前面,把后者饿死。

## 改法

钳制改为 `nextAt = now + row.RepeatEveryMs`——重锚语义 = 「自 now 起算下一周期」:

- **skip-catch-up(不 back-fill)语义保持**:停机跨 N 个周期仍只发一次;
- **非逾期路径不变**:`nextAt = prev + interval`(在线连发时 turn 结束在周期内,继续 prev 锚定节拍,`TestQueueRepeatRearmFormula` 钉死);
- **副效应(正确方向)**:重锚行从 due-now(不挂定时器,只能等下一个触发面撞上)变为 future(挂上一发性定时器,下一周期准点自愈)——#111 的定时器自愈机制对 catch-up 行也生效了。

## 改动文件

- `internal/chat/queue.go`:`rescheduleRepeat` 钳制一行 + 方法 doc comment 更新公式描述。
- `internal/chat/queue_repeat_test.go`:`TestQueueRepeatSkipsCatchUp` 注释按新语义改写;断言窗口 `[sentAt, sentAt+150]` 收紧下沿为 `sentAt+iv-10`(iv=60ms 时新值 ≈ sentAt+61,原窗口本就兼容,收紧是为把「不得低于 now+iv」钉死;上沿 150ms 不变,无新增 flake 类)。
- `internal/chat/queue_mixed_repro_176_test.go`(新增):三条回归。

## 兼容性复核

- `TestQueueRepeatSkipsCatchUp`:iv=60ms、逾期 5 周期。新值 = reschedNow+60 ≈ sentAt+61,落原窗口 `[sentAt, sentAt+150]` 内,**原断言本就兼容**;按下沿收紧后仍绿。
- 该测试的「no burst」断言路径变化:旧语义 due-now 不挂定时器;新语义定时器在 +iv 触发,但首轮 turn 仍占用(busy 守卫)→ 发送被拒、行 requeue、sentCount 不动 → 窗口内仍恰好 1 次发送。已按此改写注释。
- 其余 repeat 测试(在线重锚 / maxSends / user-stop / revoke / drain guard)全走 `prev+interval ≥ now` 路径,不受影响,实测全绿。

## 回归测试(queue_mixed_repro_176_test.go)

- **A** `TestQueueMixed176FuturePlusDue`:future@pos0 + due@pos1 → 只发 due、future 行原样保留;release 后 tail drain 不多发。
- **B** `TestQueueMixed176OverdueRepeatVsNormal`(#176 核心,红→绿实证):逾期 repeat(RepeatEveryMs=90min 直写 store,规避短间隔噪声)+ due normal 交错。断言重锚值严格未来(nowMs 之前即红:未修复代码实测重锚值=1788175146856≈now);release 后 normal 必须先于第二次 tick(prompts[1]=="normal");窗口 settle 后 ticks==1、normals==1。未修复代码上该测试红(重锚断言与顺序断言双杀),修复后绿,`-count=3` 稳定。
- **C** `TestQueueMixed176RequeueKeepsFuture`:同步发送失败(busy 守卫)→ requeueAt 保序、future 行 scheduledAt 逐字保留;turn 结束后重试发出。requeue 落库用轮询等(诊断稿固定 sleep 有竞态误报)。
- **C 与诊断稿的偏差说明**:诊断稿用 `fc.promptErr` 模拟发送失败——但 `promptErr` 在 runPrompt 层才失败,**发生在 dequeue 之后**,不触发队列的 requeue 路径(`drainQueue` 的 requeue 只覆盖 `SendMessage` 同步失败:busy 竞态 / spawn 失败)。诊断稿的 C 在修复后的代码上也会红(len(rows)==1)。正式版改用真实路径:先起一轮占用 busy,再 drain → busy 拒绝 → requeue。

## 已知限制(审计记录,本期不改语义)

- `requeueAt` / `rescheduleRepeat` 都按 dequeue 时记录的 `idx` 插回;若插入前队列被并发 mutation(新增 / 撤销 / 拖拽)改变,行会落在「原下标」而非「原相对位置」,列表序可能与用户预期偏移。drain guard + queueMu 把窗口压得很小,但语义上存在。后续若做队列操作日志 / 撤销,可考虑按相邻 itemID 锚定插入。

## 验证

- 未修复代码:`go test ./internal/chat/ -run TestQueueMixed176` → B FAIL(重锚断言命中 due-now),A/C PASS(A/C 钉的是本就正确的无关不变量)。
- 修复后:`go test ./internal/chat/` 全绿(19.2s);`go vet ./internal/chat/...` 干净;`go build ./internal/...` 干净;新增测试 `-count=3` 稳定。
- `go build ./...` 因 `frontend/dist` 未构建(worktree 无前端产物,main.go embed)失败——与本次改动无关的既有环境条件。

## 下一步

- 无阻塞。#176 可关闭(本次不 push、不关 issue,按任务边界)。
