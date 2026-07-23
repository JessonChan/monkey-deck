# 2026-07-23 fix:enqueueMessage 只停车不 auto-start —— 移除 idle 时立即 drainSession(Task #22140)

## 起因
Task #22140:纠正 `enqueueMessage`(主动入队列入口,Composer 入队列按钮 / ⌘⇧↩)的语义偏离。

`enqueueMessage` 原实现:无论 idle/prompting 都把消息压入该 session 的前端队列,**但**:
- idle(非 prompting)时入队后**立即** `void drainSession(selectedSessionId)` ——
  相当于「点入队列」=「点发送」,与「入队列 = 显式停车、留待后续」的语义冲突。
- prompting 时入队则调 `armScheduleTimer`(虽因 `scheduledAt=Date.now()` 恒为过去时刻,
  实际是 no-op,但仍是 auto-start 机制的一部分)。

续发时机本应统一交给 `chat:status` handler 里 turn 结束(idle/error)事件按 sessionId
触发的 `drainSession`(§5.3 尊重数据源:status 事件是「哪个 session 该续发」的权威信号)。
enqueue 自己再 auto-start 是重复 + 语义混淆。

## 改法
`frontend/src/App.tsx` `enqueueMessage`:
- 删除尾部 `if (statusRef.current !== "prompting") { void drainSession(...) } else { armScheduleTimer(...) }`
  整段条件分支。
- `enqueueMessage` 现在**只做三件事**:压入 session 队列(setState + ref)、去重写
  `historyBySession`、清掉该 session 的停意图(`userStoppedBySessionRef.current.delete`,
  与 `interruptQueue` 一致,否则被 Stop 标记抑制、到点续发时被跳过)。
- 依赖列表由 `[selectedSessionId, drainSession, armScheduleTimer]` 收敛为 `[selectedSessionId]`。
- 注释改写:明确「永远只停车、不 auto-start」,续发时机交给 chat:status handler。
- 同步更新 line ~99 的 `scheduledTimersRef` 注释:重 arm 触发点列表去掉 `enqueueMessage`。

`drainSession` / `armScheduleTimer` 本身未动,仍被 chat:status handler、`scheduleQueueItem`、
`reorderQueue`、`interruptQueue` 等正常使用。

## 改了哪些文件
- `frontend/src/App.tsx`:`enqueueMessage` 去 auto-start 分支 + 注释;`scheduledTimersRef` 注释。

## 验证
- `wails3 generate bindings`:补齐本 worktree 缺失的 `frontend/bindings`(gitignore,不入库)。
- `bun run build`(= `tsc && vite build`):**clean**(无 TS / 编译错误)。
- `bun test`:**107 pass / 0 fail**(Composer enqueue 两条 `#22131` 仍过 —— 它们测 Composer 调
  `onEnqueue` 回调,不测 App 的 drain 行为,不受影响)。
- 纯前端改动,无 Go 改动;`go build ./...` / `go vet ./...` 不受影响。

## 下一步
- 桌面 app 实测三种续发路径都正常:
  1. prompting 时入队 → 本轮结束 idle 事件续发(主路径,不受本次改动影响)。
  2. idle 时入队 → 不再立即发;等下一次自然 turn 结束 idle、或下一次直发触发的 turn 结束后续发。
  3. 主动入队后用户点 Stop → 停意图生效,下个 idle 被跳过(队列保留)。
- 观察:是否有场景需要 idle 入队后「显式启动队列」的入口(目前依赖下一次 turn 结束);
  若产品上要求 idle 入队也能主动触发,再单独加显式动作(本次任务范围明确:只去 auto-start)。
