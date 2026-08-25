# 2026-08-26 #126A 队列上移 server 端(per-session 队列 + store 持久化 + 5 CRUD bindings + drain 后端化 + chat:queue 同步 + 前端退化事件消费者)

Task #24287 / issue #126A。3 个原子 commit:`1b9262a`(store)/ `a622a87`(chat)/ `d6f6ad3`(frontend)。

## 起因

队列原本是**前端内存**(App.tsx `queueBySession` + `drainSession` + setTimeout 定时器 + userStopped ref):

1. **窗口关/应用重启即蒸发**——排队中的消息(尤其定时消息)随 webview 消失,没有任何持久化。
2. **每个客户端一份真相**——桌面 GUI、远程浏览器、PWA、popout 各自持有队列副本与 drain 循环,同一 session 被多个窗口打开时副本发散;远程端断线重连后队列状态无从对账(WS 不回放,§1.8)。
3. drain 在前端意味着**后台 session 的续发依赖某个窗口活着**——关掉窗口,排队消息就停在队列里不动。

## 改法(单一 owner = 桌面进程,§2.2;真相 = SQLite,§1.5)

### 1. store 层(`0018_queue_items.sql` + `internal/store/queue.go`)

- `queue_items` 表:`id/session_id(FK 级联)/text/attachments(JSON 字符串)/scheduled_at/position/created_at`。
- 只暴露 `ListQueueItems`/`ReplaceQueueItems`(事务内整表替换,position=切片序)——队列极小(用户节奏),整替是单一代码路径,不搞整数间隙体操(§5.3 KISS)。
- **store 不 import internal/acp**:`acp → mcp → store` 会成环(import cycle,实测踩到);附件 JSON 编解码留在 chat 层边界,顺便符合「store 不该知道 ACP 形状」(§2.1)。

### 2. chat 层(新文件 `internal/chat/queue.go` + chat.go 接线)

- **5 CRUD bindings**:`EnqueueMessage`/`RevokeQueueItem`/`EditQueueItem`/`ScheduleQueueItem`/`ReorderQueueItem`。每次变更:queueMu 下读-改-写 store → 推 `chat:queue` 全量快照(空快照=权威清空)→(schedule/reorder)按需 arm 定时器 + idle&到点时 `go drainQueue`。Enqueue **只停车不 auto-start**(原前端语义对齐:主动入队永不抢跑)。
- **drain 后端化**:`runPrompt` 六个终态路径(cancelled-idle / peer-断 error / elicit-declined idle / 空 turn notice / turn-incomplete / 正常 idle)尾部 `go s.drainQueue(sid)`(goroutine 会阻塞在 sendMu 上直到收尾释放,天然串行);`SendAndWaitSync` 同步。语义逐条对齐原 `drainSession`:
  - **dequeue 先于 send**(重启不重发);send 失败(busy 竞态/spawn 失败)**按原位 requeue**——比原前端「失败即丢」更稳;
  - 未来 `scheduledAt` 跳过、不阻塞后续已到点项;全队未到点 → per-session 一次性 `time.Timer` 按最早到点触发(防静死;delay 上限 24.8d 防 int64 ns 溢出);
  - **一次性 stop intent**:`StopSession` 在 cancel 前记录,紧跟其后的 drain 消费并跳过(队列保留)——Stop=「停」不是「跳过一条继续发」;无 turn 时不记录(防残留标记误抑制无关续发);`SendMessage`/`InterruptAndSend`/`EnqueueMessage` 清意图(用户发送=想继续)。
- **chat:queue 同步**:全量快照事件,挂进 remote 事件闭集(`remote_attach_desktop.go`,§1.8)。**OpenSession 无条件先推快照**(active 早退也在推)——桌面 boot / popout / 重开 tab(evict 后)/ 远端 resync(重开选中 session)都拿到初始态。
- 生命周期清理:`DeleteSession`/`RemoveProject`(全部 session)/`ServiceShutdown` 清定时器与运行态;行本身 FK 级联。
- **锁纪律**:队列运行态(userStopped/queueDraining/queueTimers)全在 `queueMu`,从不与 `s.mu`/`sendMu` 嵌套——`SendMessage`(ensureLive spawn 可能秒级阻塞)永远在队列锁外调用。

### 3. 前端退化事件消费者(App.tsx + types.ts)

- `queueBySession` 只被 `chat:queue` 事件全量覆盖;订阅挂在 boot effect(与 chat:status 同处)。
- 6 个回调全部改走 binding;`interruptQueue` = `RevokeQueueItem` + `InterruptAndSend`(attachments 复用快照里原样保存的数组,不再重组);`revokeQueue` 后端成功才回填 composer(失败时条目仍在队,防同文双份)。
- **删掉**:`drainSession`/`armScheduleTimer`/`drainSessionRef`/`userStoppedBySessionRef`/`drainingBySessionRef`/`scheduledTimersRef` 及 chat:status 里的 drain 触发(净 -34 行)。
- `queueBySessionRef` 保留但只读(interrupt/revoke 查条目要最新值,又不进 callback 依赖——与 sessionsByProjectRef 同模式)。
- popout 快照**不再打包队列**(主窗口镜像可能陈旧;popout 自己的 OpenSession 会拿到权威快照)。
- `types.ts`:`QueueItem.attachments?: Attachment[]`(取代 mentions/images/audios 三件套)+ 新增 `QueuePayload`/`Attachment`(后端 acp.Attachment 的镜像)。**QueuePanel props 零变化**,#126B 移动端适配不受波及(mount 测试全绿佐证)。

## 验证

- **后端**:`go build ./...` / `go vet ./...` clean(仅存量 macOS 链接器 warning);`go test ./...` 全绿。新增:
  - `internal/store/queue_test.go`:整替/顺序/附件/清空 roundtrip + FK 级联(临时文件库使 FK pragma 生效,§5.2)。
  - `internal/chat/queue_server_test.go`(7 个,全 fakeChat,§5.1 不启真 harness):drain 链发(FIFO+队列清空)/附件透传进 Prompt(fakeChat 增 per-prompt 附件录制)/Stop 抑制+手动发送后恢复/定时项到点前不发-到点即发(60ms 定时器)/busy 竞态 requeue+turn 结束重发/5 CRUD 落库+事件快照+未知 id 报错/OpenSession 快照(含空快照)。
- **前端**:`wails3 generate bindings -ts` 重新生成(5 个方法全数出现);`bun run build`(tsc+vite)通过;`bun test` 253 pass / 6 fail——6 个全在 `NewSessionModal.mount.test.tsx`,**stash 后干净 HEAD 同样 fail,预存在**(与 #126B worklog 记录一致);QueuePanel 20/20。
- **三端矩阵(§4.7/§5.6)**:
  - 后端/binding 能力统一验一次(server 模式,隔离 XDG 数据目录):5 个 binding 经 `POST /wails/runtime` wire 往返全部 OK;`chat:queue` 经 `/wails/events` WS 桥送达远端(bun WS 客户端实测收到 `{sessionId, items:[{id,text,scheduledAt}]}`);`queue_items` 行/定时/重排/级联在隔离库里核对;reorder 触发 drain 的 idle-续发行为在 smoke 中顺带实证(移出队首 due 项并发送)。⚠ smoke 中发现 server 二进制用 XDG 隔离成功、未碰真实 DB;但当时用户桌面 app 正在跑——**测试用 server 已即时杀掉,无残留 harness**(pgids 空)。
  - 桌面 GUI:同一份代码,事件通道=webview binding/event,由单测+类型检查覆盖;真机冒烟(入队→turn 结束自动续发→QueuePanel 实时消失)待用户侧。
  - 远程浏览器:WS 事件已实证(上);断线重连后队列经 resync→openSession→OpenSession 快照对账(与 #134/#127 同机制)。
  - PWA:与浏览器同一通道;≤768px 未触及(QueuePanel props/CSS 零改动)。

## 下一步

- 桌面真机冒烟:prompting 时入队 → Stop(队列保留不再误续发)→ 定时 5 分钟 → 到点自动发;重启 app 队列还在。
- 可选(未做,KISS):`SessionStatuses` 式的队列 pull API 不需要——OpenSession 快照已覆盖已知窗口;若真机发现 resync 盲区再补。
- issue #126 若有 B/C 分段(126B 已做窄屏适配),以本 task 为 A 段收口。
