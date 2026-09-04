# 2026-09-03 Review #28974:#184 repeat drain 窗口竞态(复现 + 修复)后端审查

日期:2026-09-03
状态:**APPROVE**(后端范围;两条非阻塞备注 + 一条裁决性说明)
任务:Task #28975,审 Task #28974 产物——已合入 main 的三 commit:`bdd692c`(修复)/ `d11dd9e`(测试脚手架线程安全化)/ `659083f`(worklog)。
方法:反相追踪,不信 commit 叙事。逐行读 `internal/chat/queue.go` 全量 + 复现套件全文 + 三 diff;独立跑红/绿/-race 三态实证。

## ① 复现套件质量 —— PASS

- **交错门是真门,不是时序赌运气**:测试先持 `ls.sendMu`(chat.go:2315 `SendMessage` 的第一把锁)再 `go drainQueue`;`waitQueueTexts([future,normal])` 经 **store 直读**(`svc.st.ListQueueItems`,非事件)轮询,且 fixture 文本为 `[future,tick,normal]`,目标态 `[future,normal]` **唯一标识 dequeue 已落库**。落库后 drain 的下一动作就是阻塞在 sendMu,重插只可能发生在解锁后——窗口严格张开。窗口内经**真实 binding 方法**(`RevokeQueueItem`/`ReorderQueueItem`/`EnqueueMessage`/`ScheduleQueueItem`)注入。
- **矩阵 = 14 reschedule + 1 requeue**,与 worklog 一致;抽查 5 个期望序(revoke earlier / enqueue tail / reorder successor over earlier / enqueue-then-reorder-onto-new-tail / requeue 窗口)手工推演「mutation 作用于 dequeue 后列表 [A,B] + tick 插回 B 前」全部自洽。
- **RED 实证独立复跑**:换入 `bdd692c^` 的 queue.go → **恰好 11/15 红**,且 pass/fail 集合与 worklog 表**逐项一致**(3 个对照组 + revoke both neighbours 绿,其余 10 reschedule + requeue 窗口红)。修后 15/15 绿。
- **断言全部锚定值**(非字段存在性):顺序全等、`RepeatEveryMs/SentCount/MaxSends` 精确值、#176 重锚窗口 `[rPrev+iv-1s, rPrev+iv+5s]` 且严格未来、requeue 路径 `ScheduledAt==rPrev` 逐字 + `SentCount==0` + `fc.count()==0`(busy 拒绝不许起 prompt)。
- **确定性旁证**:窗口内 binding 触发的逃生 drain(`go drainQueue`)被在持的 drain guard 折叠;即便发生「guard 释放后才被调度」的病态时序,enqueued C 会 busy 拒绝 → requeue 逐字回尾,终态不变量仍成立。全 non-dequeue 行 future 化的设计把触发面钉死。

## ② 修法 —— PASS

- `dequeueDue` 的锚取自**与 splice 同一把 queueMu 内的同一快照**(`rows[dueIdx+1].ID`);idx 不再出锁。
- `insertAtSuccessor` 在插入时对**当前 List** 按 ID 定位;锚 ID 是不可变身份,选取→插入之间**无新窗**——中间任意 mutation 都在插入时重解析;锚被 revoke → 尾部降级,由 `revoke successor anchor` 对照组钉死。
- 调用面核查:四个改动符号全仓仅 queue.go + 测试引用(`queue_mixed_repro_176_test.go` 仅注释提及,实际走 `drainQueue`),无漏迁 caller;均为 unexported,wails bindings 零变化,无需 `wails3 gen bindings`。
- 语义备注(非缺陷,已文档化):「dequeue 时本无后继 + 窗口内 enqueue」→ 重插行走尾部,后来者 C 反而排在 repeat 前,轻微 FIFO 倒挂。锚语义下不可避免的保守降级,对 repeat 行(按 schedule 重发)影响极小,worklog 已声明。
- 逐行核对审计表 10 行与源码一致(Schedule/Reorder 手动 Unlock 后才 `go drainQueue`;isBusy 在锁外取 s.mu,无锁序倒挂);`syncQueueSnapshot` 确只 List+arm+emit。**无同窗残留**。

## ③ 红线零触碰 —— PASS

diff 域核对:#176 公式块(`nextAt = prev+interval`,过期 clamp `now+interval`)未动(测试窗口断言继续钉);`ScheduleQueueItem`(Send Now 承接分支)未在改动 hunk;前端零文件;#192 冻结面(schedule placeholder)零接触。#176 worklog(2026-08-31)曾把「裸 idx 插回」记为已知限制并点名「按相邻 itemID 锚定插入」为后续方向——本次修复正是该既录方向的落地,血缘干净。

## ④ 核心裁决(必答):successor-ID 修复与「整行消失」症状的关系

**结论:本修复不覆盖、也不需要覆盖「整行消失」——消失的机制在别处,本修复的对象是位置违约。论证如下:**

1. **clamp 排除丢失的论证严密(就竞态窗口而言)**:旧码 `idx=dueIdx ∈ [0, origLen-1]` 恒非负;插入时 clamp `idx > len(rows) → len` 保证 `rows[:idx]` 永不越界 panic;两条重插路径每次 dequeue 恰好执行其一 → **行数守恒,结构性不可能丢行**。RED 实测 11 失败**全部是顺序断言红、零计数断言红**,与论证吻合。新码 `insertAtSuccessor` 两分支都恰好插入一行,同样守恒。
2. **「整行消失」的真实机制已被 252c3dd 处置**:#184 原始症状 = repeat 项点「立即发送」时前端 `interruptQueue` **先 Revoke(删行)再 InterruptAndSend** → 行被删、循环静默终止 + 潜在双发。这就是消失本体,252c3dd(ScheduleQueueItem(now) 替代 revoke)已修,不在本次 reopen 范围。
3. **残余丢失旁路均 pre-existing 且非竞态,本次不修属如实**:① **进程在发送窗口内崩溃/退出**——dequeue-before-send 已删行、重插未落库 → 行永久丢失。这是 #111 worklog 明文接受的 at-most-once 设计代价(换重启 exactly-once),非缺陷;② `requeueAt`/`rescheduleRepeat` 内 `List/Replace` store 失败仅 warn → 丢行(#24333 review 已录 status quo);③ maxSends 到量不回插 = 设计语义。若 252c3dd 后用户仍见消失,嫌疑清单是这三条,**不是** stale-idx 竞态。
4. worklog 对「drain guard 折叠丢唤醒」的单列备注基本准确,一处略乐观:spawn 失败 requeue 路径无 turn tail 可补位(requeue 行 due-now 也不挂定时器),折叠的 now-due mutation 要等用户动作自愈——pre-existing、有界、自愈,不阻塞。

**故:APPROVE 不含糊——reopen 修复对其声明的问题(位置违约)完整覆盖并实证;对消失症状本修复从未声称覆盖,消失归 252c3dd(已修)+ 上述三条既有旁路。**

## ⑤ -race 脚手架改造 —— PASS

- 4 处转换(空 turn ×2、runPrompt 断连 ×2)纯搬运:裸 `lastPayload` 闭包写 → 包内既有 `statusRecorder`/`captureStatuses`/`lastPayloadOf`;轮询语义(2s 上限、跳过 prompting)与终态断言(`assertDisconnectedCode` 的 Code+空 Detail;notice + `ErrCodeHarnessEmptyTurn` + 空 Detail + 连接保留)**逐字保留,零弱化**。
- `TestSendAndWaitSyncDisconnectEmitsCode` 保留裸变量是**正确**决策:同步路径 emit happens-before 返回,本就不在 racing 集(commit 所列 4 测试与实测一致)。
- worklog 声称 -race 在干净树上即红(6 警告/4 测试)——与改动无关的既有债,最小转换 + 独立 commit,处置得当。

## 验证(本审独立实跑)

- `go test ./internal/chat/ -run TestQueueRepeatRace184`:修后 **15/15 绿**;换入 `bdd692c^` queue.go → **11/15 红**(集合与 worklog 逐项一致),已还原,`git status` 净。
- `go test ./internal/chat/ -race -count=1`:**ok**(42s,仅 macOS linker 版本警告,无关)。
- `go vet ./internal/chat/` 过;`internal/chat` 包编译经测试运行实证。`go build ./...` 在本 worktree 因 `frontend/dist` 未构建(embed 缺目录)不可用,非代码问题;改动面无 binding 签名变化。

## 非阻塞备注

1. 矩阵子测试不 `fc.release()`,泄漏的 runPrompt goroutine 在下一用例 store 关闭后打 `sql: database is closed` warn(各用例独立 svc/store,无交叉污染,-race 绿)——建议 `t.Cleanup(fc.release)` 静默化,顺手即可。
2. ④-3 的三条丢失旁路若要收敛,属独立工作(crash 窗口 = 设计取舍不动;store 失败丢行可考虑失败时原地回插重试或显式 error 事件),本期不做。

## 下一步

- 后端范围 **APPROVE**,无遗留修改请求;#184 关闭交 orchestrator 处置(本审不关 issue、不 push、不派卡)。
