# 2026-08-31 review #28917 — #176 queue catch-up 重锚修复(后端面)

## 审查对象

- `70500f1` fix(chat): repeat catch-up re-anchors one interval past now (#176)
- `07adab9` docs(worklog): #176 queue catch-up re-anchor fix record

## 结论

**APPROVE**。修法正确、回归测试真实红→绿、无并发/状态机回归。

## 逐项核验

### 修法正确性(internal/chat/queue.go rescheduleRepeat)

- 钳制 `nextAt = now` → `nextAt = now + row.RepeatEveryMs`,与任务规格逐字一致(重锚=自 now 起算下一周期,永不久挂 due-now)。
- **入参保证**:`rescheduleRepeat` 唯一调用点(drainQueue L441)已守 `RepeatEveryMs > 0`,钳制不会产出 `now+0=now`;生产路径 `SetQueueItemRepeat` 硬门 [1min, 24h]。
- **边界**:`prev+iv == now` 恰好相等时走严格 `<` 不钳制 → 按期 due 发送,是合法下一周期发送,非 #176 双发;无误伤。
- **skip-catch-up 语义保持**:跨 N 周期停机仍只发一次、不 back-fill;在线 `prev+interval` 路径原样(`TestQueueRepeatRearmFormula` 继续钉住)。
- **定时器面(新副效应,方向正确)**:`armQueueTimerLocked` 只挂**严格未来**的行(L566 `ScheduledAt > nowMs`)→ 新重锚行(+iv)正式挂上定时器,#111 自愈机制覆盖 catch-up 行;反向确认无热循环——busy 拒绝 → `requeueAt` 后行已过点 → 不挂定时器,每周期至多一次被拒 drain,有界。旧代码 due-now 行不挂定时器、只能等触发面撞上,正是 #176 病灶之一。
- **混合队列不饿死**:`dequeueDue` 取第一条 `ScheduledAt <= now`(L507),future 重锚行被跳过,due normal 正常发送——与 drainQueue 文档语义「future 不阻塞后面 due」一致。

### 回归测试(queue_mixed_repro_176_test.go)

- **B(#176 核心)真实红→绿**:本人将钳制行临时还原(`nextAt = now`)实测 `TestQueueMixed176OverdueRepeatVsNormal` FAIL,报错 `catch-up re-anchor must be strictly future (now+5400000ms), got 1788175705262`≈now——正是 issue 描述的 due-now 病灶;恢复后绿。不是"只钉住现状"的假回归。
- 断言为**锚定值**:重锚值严格未来、`prompts[0]=="tick" && prompts[1]=="normal"` 顺序断言、settle 窗口后 ticks==1/normals==1——值流到具体输出,非字段存在性断言。
- 90min 间隔直写 store(绕开短间隔噪声),与 issue 场景一致。
- **C 用真实 requeue 路径**:先占 busy 再 drain → 同步拒绝 → `requeueAt`;正确避开了诊断稿的 `promptErr` 陷阱(它在 runPrompt 层、dequeue 之后失败,根本不触发队列 requeue)——coder 已在注释与 worklog 里说明并修正,轮询替代固定 sleep 消除竞态。
- **A** 钉住无关不变量(future 不阻塞 due、tail drain 不多发),红/绿两态均过,定位清晰。
- `TestQueueRepeatSkipsCatchUp` 窗口收紧 `[sentAt+iv-10, sentAt+150]`:新值 = reschedNow+60 ≥ sentAt+60,下沿 +50 留 10ms 余量;上沿 150ms 沿用旧值——无新 flake 类。no-burst 注释按新语义改写正确(定时器 +iv 触发时 turn 仍占用,busy 守卫拒绝,requeue 后不挂定时器,sentCount 不动)。

### 验证(本人复跑,非转述)

- `go vet ./internal/chat/...` 干净。
- `go test ./internal/chat/ -run TestQueue` 16/16 PASS;新增 4 用例(3 新 + 1 收紧)全绿。
- `go test ./internal/chat/ -run 'TestQueueMixed176|TestQueueRepeatSkipsCatchUp' -count=3 -race` 绿(3.8s)。
- `go test ./internal/chat/` 全包 PASS(17.8s);`go build ./internal/...` 干净。
- 临时还原实验后 `git status` 干净,工作树未被污染。

## 已知限制(沿用 coder 记录,本期不扩 scope)

- `requeueAt`/`rescheduleRepeat` 按 dequeue 时 `idx` 插回,并发 mutation 下落「原下标」而非「原相对位置」——既有行为,窗口被 drain guard + queueMu 压得极小,coder 已在 worklog 记录且给出后续方向(相邻 itemID 锚定),不构成本次阻塞。

## 流程面

- 纯后端改动,不触及 `frontend/` → 三端矩阵不适用(后端验证一次,§4.7)。
- 注释英文(§3.7)、原子提交(fix 与 docs 分离,§6.2)、worklog 齐备(§0.3)。
- 按任务边界:不 push、不关 issue,APPROVE 后停在 completed-ready。
