# 2026-08-26 Review:#126A 队列上移 server 端(1b9262a / a622a87 / d6f6ad3)

复审对象:main 上 `1b9262a`(store)+ `a622a87`(chat)+ `d6f6ad3`(frontend)
(实现 worklog 见 `2026-08-26-server-side-queue.md`)。Backend reviewer 视角,
聚焦任务指定的三点:InterruptAndSend 衔接 / userStopped 后端化 / 乐观更新竞态,
另覆盖 ACP 合规、锁纪律、SQL/迁移、测试质量。

## 结论:PASS(3 处 minor 竞态/活性缺口已由本次 review 修复)

## 逐项核验(按任务重点)

1. **InterruptAndSend 衔接——成立**:
   - 入口 `clearUserStopped`(chat.go);busy 路径置 `suppressIdle` 后,旧 turn 的
     runPrompt 尾部在 `if suppressed` 早退,**先于**全部 6 处 `go drainQueue` 调用点
     ——打断窗口内不会误续发、不会双发。sendMu 舞步(释放→cancel→<-done→重拿)
     与既有死锁论证一致;上一 turn 尾部 spawn 的 drain goroutine 阻塞在 sendMu 上
     天然串行。
   - 残余微窗口(记录不修):前端 Revoke 与 InterruptAndSend 之间 turn 恰好结束,
     drain 可能已把**下一条**排队项发出并成为「当前 turn」,随后的 interrupt 会把
     该 turn 一刀切断且该项不 requeue(用户消息已落库、回复被截断)。语义上等同
     「打断当前 turn」作用在 drain 发出的 turn 上;窗口在毫秒级 store 往返内,
     修法(识别 drain 起源 turn 并 requeue)复杂度远超收益。
2. **userStopped 后端化——主路径成立,一处竞态窗口已修(见 F1)**:
   - 无 turn 分支不置标记(防残留误抑制)、三个用户驱动入口(SendMessage /
     InterruptAndSend / Enqueue)清意图、drain 一次性消费——语义闭环,
     `TestQueueDrainSuppressedAfterUserStop` 覆盖含手动发送恢复。
3. **乐观更新竞态——已由设计消解**:
   - 5 个 CRUD 全部 queueMu 下 read-modify-write 整表替换:多客户端(桌面/远程/
     PWA/popout)并发变更串行化,无 lost update。前端退化为纯事件消费者,
     revoke 仅在 binding 成功后回填 composer(unknown id 报错,有测试锚定)。
   - **锁纪律核验**:逐函数确认 queueMu 是叶子锁——任何持 queueMu 的临界区都不
     获取 s.mu/sendMu/ls.mu(drainQueue 的 SendMessage 严格在 dequeueDue 释放
     queueMu 之后调用),注释声明成立,F1 的嵌套修复因此安全。
   - dequeue-before-send + requeueAt(dueIdx) 跨重启 exactly-once;busy 竞态
     requeue 有测试;idx 钳制(len 边界)正确。
4. **store 层**:0018 迁移 embed 自动收录;文件库 DSN 带 `foreign_keys(1)`,
   FK 级联有 temp-file 库测试(§5.2);整替事务原子;attachments 以不透明 JSON
   落库、编解码留在 chat 边界(无 store→acp import,§2.1);空附件 round-trip
   为 `""`(NOT NULL 满足)。`:memory:` 库 FK 不生效——仅测试用,doc comment
   已如实标注。
5. **类型补丁反模式检查——无**:全链路逐点确认字段被真实消费——attachments
   enqueue 编码→落库→drain 解码→进 Prompt(fakeChat 增 per-prompt 录制,
   `promptAttachmentsAt(1)[0].Path=="a.go"` 锚定);ID/Text/ScheduledAt 均有
   具体输出端消费;`EventQueue` 进 remote 闭集(remote_attach_desktop.go)。
   测试断言全部锚定值(顺序/文本/条数),无「存在即过」。

## 发现与处置

- **[fixed] F1(竞态,低)StopSession 标记窗口**:`0cc3c73`。原实现在释放 ls.mu
  后才 setUserStopped——turn 恰在读 tc 与置标记间自然结束时:尾部 drain 查无
  标记照发排队消息(违背 Stop=停),迟到的标记残留又误抑制下一次无关续发。
  改为读取 turnCancel 的同一 ls.mu 临界区内置标记(queueMu 叶子锁,嵌套安全),
  窗口结构性消除。竞态窗口本身无法脱离人为钩子确定性复现,主路径回归由既有
  抑制测试守卫;残余微窗口(turn 尾部清 turnCancel 之后、drain send 之前按
  Stop)在 persist 毫秒级内且无残留标记,记录不修。
- **[fixed] F2(活性,低中)drain 发送失败后静默停滞**:`a38e7de`。断连期 drain
  的 SendMessage 失败(ensureLive 撞上失败 spawn)→ requeue 后条目 due-now、
  定时器只为未来项 arm、无在跑 turn——reconnectLoop 成功返回后无人再唤醒队列,
  自动续发静默死亡。重连成功路径补 `go drainQueue`。
  `TestQueueDrainsAfterReconnectSuccess` 复现(spawn #1 peer 断 / #2 失败
  requeue / #3 重连成功 → 断言排队消息送达)。
- **[fixed] F3(竞态,很低)定时器回调无身份门控 drain**:`246b49d`。回调在
  身份校验失败(Stop 竞速输给 stopAllQueueTimers/cleanupQueueState/重 arm)时
  仍无条件 drainQueue——关停期正是 stopAllQueueTimers 要防的「drain 与 store
  关闭竞速」(drain 还可能经 ensureLive 在 teardown 中途 spawn harness)。改为
  仍是注册定时器才 drain。`TestQueueTimerFiredSkipsWhenStale` 锚定(陈旧不发、
  注册发)。
- **[fixed] review 过程中引入又被 -race 抓住的真问题**:F3 首版把回调体抽成
  `queueTimerFired(sid, t)` 后,闭包把 `t` 作**调用参数**求值——读取发生在任何
  锁之前,失去原内联版「queueMu release→acquire」的 happens-before 边,
  `-race` 实测报竞争(AfterFunc 自引用经典坑)。修法:闭包先在 queueMu 下读
  `self := t` 再传入。教训入 commit message。
- **[note] SendAndWaitSync 错误路径不 drain 不重连**(成功路径 2149 已补):仅
  driver/测试面,与 runPrompt 不对称但无用户可见面,记录。
- **[note] 重启后 due 项不自动发**:OpenSession 只推快照;Enqueue 只停车(前端
  语义对齐,worklog 已声明)。用户可见队列面板,手动 schedule/reorder/send 均
  可触发,可接受。

## 验证

- `go build ./internal/...` / `go vet ./internal/...` 干净(仅存量 macOS 链接器
  warning);`go test ./internal/...` 全绿。
- `-race`:`-run 'Queue|Reconnect|Interrupt|Stop'` 全绿(含新增 2 测试 ×
  多 count)。全量 `-race ./internal/chat/` 4 失败(empty_turn ×2 /
  error_code ×2,emitHook 计数器无锁)——**stash 后在干净基线 d71b4fe 复现
  同样失败,确证预存**(与 #125 review 记录的同一批),非 #126A 引入、非本次
  修复引入,OPEN 维持。
- 前端(d6f6ad3)不属本次 review 面;三端行为面零改动(修复全在后端 Go),
  后端能力统一验一次(§5.6),三端各自通道不受影响。

## 下一步

- 无阻塞项。可选:修预存 `-race` 4 失败(测试 recorder 加 mutex,多项 worklog
  已 OPEN);实现 worklog 的「桌面真机冒烟」仍待用户侧。
