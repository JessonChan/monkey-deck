# 2026-07-23 drainQueue 仅作用选中 session → 改为按 sessionId 遍历所有 session 队列 + per-session 竞态隔离

## 起因
Task #22105。`drainQueue`(auto-continue:turn 结束后续发该 session 队列下一条)只对**当前选中**的 session 生效:
- `drainQueue` 读 `selectedSessionIdRef.current`,只 drain 选中 session 的队列。
- 触发它的 `useEffect` 依赖 `status`(派生自 `statusBySession[selectedSessionId]`),只有选中 session 的 status 变 idle/error 时才 fire。

结果:用户在 session A 起对话并排队了多条消息,切到 session B —— A 的 turn 结束后队列**不会自动续发**(A 不再选中,其 idle 事件不触发任何 drain)。队列卡死,直到用户切回 A。这是既有限制(见 2026-06-30 工作日志「OPEN」)。

## 根因(设计层面)
触发器与数据源脱钩:
- **数据源(权威信号)**:`chat:status` 事件**本身携带 `sessionId`**,明确指出「是哪个 session 的 turn 结束了」。
- **旧触发器**却去看「选中 session 的派生 status」(§5.3 反模式:重新发明协议已给的东西 —— 用「选中态」去推断「该续发谁」,而协议事件早就给了答案)。

另外 `userStoppedRef` 是**全局** ref:停 A 后切走,若他 session 的 idle 触发 drain,会被这个本属 A 的全局标记错误抑制(或反之,打开 Y 时无条件 `=false` 会把 A 的停意图抹掉)。

## 改法(尊重数据源 + per-session 不变量,§5.3)

1. **触发器改为直接挂在 `chat:status` 事件上,按 `s.sessionId` 调用**:在 status handler 里,turn 结束(`idle`/`error`)时 `void drainSession(s.sessionId)`。这样**所有** session(含后台非选中)的队列都能自动续发。`closed` = idle reaper 回收,session 已关,不续发。
2. **`drainQueue()` → `drainSession(sid)`**:接收 sessionId 参数,drain 指定 session 的队列(不再隐式取选中态)。
3. **per-session 竞态隔离 `drainingBySessionRef`(Set)**:同一 session 的 drain 同时只允许一个在飞。`SendMessage` 是绑定调用、后端 `runPrompt` 在 goroutine 里跑,故绑定几乎立即返回、guard 仅短暂持有;但能挡住 idle/error 抖动或重复事件触发的并发 dequeue(防跳序/重发)。后端 `busy` 守卫是最终兜底。
4. **`userStoppedRef`(全局)→ `userStoppedBySessionRef`(per-session Set)**:Stop 标记钉在具体 session 上,由该 session 下一个 idle/error 的 `drainSession` 一次性消费并跳过(队列保留)。停 A 不再误抑制/误放开 B。
   - `stopSession`:`add(selectedSessionId)`。
   - `interruptQueue`(`立即发送`,主动行为,清除停意图):`delete(sid)`。
   - `openSession`(保留旧「重开会话可续发」语义):`delete(sessionId)`(只清本 session,不再清全局殃及他人)。
   - `removeSession`(删 session):`delete` 两个 per-session Set,防泄漏。
5. **删掉旧的 status-watching `useEffect`**(已被事件直驱取代)。
6. `drainSession` 移到事件订阅 effect **之前**定义并加入其 deps(TypeScript 禁止 use-before-declaration,且事件闭包需引用它)。
7. error 条只对**当前查看**的 session 弹(`sid === selectedSessionIdRef.current`),后台 session 续发失败不打扰用户视图。

### 顺带修掉的旧 bug
全局 `userStoppedRef` + `openSession` 里 `= false`:停 A 后打开 Y 会把 A 的停意图抹掉(全局污染)。per-session 化后打开 Y 只清 Y,A 的停意图保留。

## 改了哪些文件
| 文件 | 改动 |
|---|---|
| `frontend/src/App.tsx` | `userStoppedRef`(全局)→ `userStoppedBySessionRef` + 新增 `drainingBySessionRef`(per-session Set);`drainQueue()`(隐式取选中态)→ `drainSession(sid)`(按参数 drain,加竞态隔离 + error 仅选中态弹);删 status-watching effect;status handler 内 `idle`/`error` 时按 `s.sessionId` 触发 `drainSession`;`stopSession`/`interruptQueue`/`openSession`/`removeSession` 的 userStopped 写点改 per-session。 |

Go 零改动 —— 无需 `wails3 generate bindings`。

## 验证
- `make bindings` 重生成前端 bindings(本工作树原先缺失,与本次改动无关)。
- `npm run build`(frontend:`tsc && vite build`)exit 0(仅 chunk 体积告警,无关)。
- `bun test`(frontend):83/83 pass。
- `go build ./...` + `go vet ./...` 通过(仅 macOS 链接器版本告警,无关)。
- 逻辑审查:
  - 后台 session A 排队 + 切走 → A 的 turn 结束发 idle 事件(带 A 的 sessionId)→ `drainSession(A)` 续发 ✓(修复点)。
  - per-session guard:同一 session 的 idle/error 抖动不会重复 dequeue(SendMessage 立即返回,guard 短暂持有,下一轮 idle 时已释放)✓。
  - Stop A → 标记钉在 A → A 的 idle 消费标记跳过续发、队列保留;B 不受影响 ✓。
  - 后台 session 续发失败只更新其 `statusBySession`,不弹全局 error 条打扰当前视图 ✓。
- 未引入前端 App 级测试:App 依赖 Wails3 运行时事件 + React 状态机,无现成 App 测试基建(见 2026-06-30 工作日志「未引入前端测试」的同理权衡);纯逻辑不变量(竞态隔离、per-session 消费)后续可抽到 lib 单测。

## 权衡 / OPEN
- **行为微调(可接受)**:用户主动 Stop 的 session,其队列保留;重开该 session 会清掉停标记 → 下个 idle 续发(保留旧语义)。若 Stop 后不重开、也不发新消息,队列静置直到用户用队列面板「立即发送」或发新消息触发 —— 这是 per-session 停意图的正确语义,非回归。
- **未做实机验证**:auto-continue 涉及多 session 并发 turn + Wails3 事件流,需 `wails3 dev` 实跑复现(后台 session 排队 → 切走 → 观察其队列自动续发)。
