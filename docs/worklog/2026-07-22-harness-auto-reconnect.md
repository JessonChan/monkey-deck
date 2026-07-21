# 2026-07-22 harness 断连自动重连(主动 spawn + 指数退避 + 重试上限 + busy/idle 分支 + userStopped 抑制)

## 起因

Task #21317。§3.3 原来的断连兜底是**被动的**:harness 死 → `runPrompt` teardown +
`emitError(ErrCodeHarnessDisconnected)` → session 从 active 移除,**直到用户发下一条消息**
才经 `ensureLive` 重新 spawn。空闲自杀(§5.4 #9,opencode idle)同理 —— 用户不点就不重连。

这把「harness 恢复」的延迟全压在用户侧:断连 → 看到错误 → 手动发消息 → 等 spawn → 才能继续。
桌面应用有人在场但不一定在看,主动 spawn 新 harness 可使 session 自愈、用户下条消息零延迟。

## 设计(§3.3 自动重连)

五条不变量(任务名直述):

1. **主动 spawn 重连**:disconnect 后后台 goroutine 调 `ensureLiveNoReset` spawn 新 harness
   (LoadSession resume),不等用户。成功 → session 回到 active,前端看到 `started`。
2. **指数退避**:每次 spawn 失败 backoff 翻倍(初始 1s,上限 30s),防紧密循环打爆系统。
3. **重试上限**:超 `reconnMaxAttempt`(默认 5)次 → `reconnectGiveUp` + 推
   `ErrCodeHarnessReconnectFailed`,停摆直到用户主动操作(防崩溃循环无限重试)。
4. **busy/idle 分支恢复**:
   - **busy**:`runPrompt` 收到 peer-disconnected / 空 turn → teardown + emitError + `startReconnect`。
   - **idle**:health watcher 周期(`healthInterval`,默认 3s)扫描 active session,`!IsAlive()`
     且非 busy → teardown + `startReconnect`。busy 的跳过(由 runPrompt 处理)。
5. **userStopped 抑制**:
   - StopSession 干净 cancel:`runPrompt` 的 `cancelled=true` 分支 **不 teardown**(harness 仍存活)→
     天然不触发重连。这是「userStopped」的核心语义。
   - CloseSession/DeleteSession/RemoveProject:`stopReconnect`(停止在跑 goroutine)+
     `reconnectGiveUp=true`(防在途 / 后续 health watcher 触发把刚关的 session 又拉起来)。

### 防崩溃循环(§5.4 #6,关键)

「spawn 成功」的判定必须有**稳定观察期**(`reconnStability`,默认 5s):`ensureLiveNoReset` 返回
nil 后不立刻宣告成功,而是等 `reconnStability` 期内 `IsAlive()` 持续为真。期内死掉算失败、继续下一次
尝试。**只判 ensureLive 返回 nil 就算成功**会导致「spawn OK 但立刻崩溃」的 harness 被判成功 →
reconnect goroutine 退出 → health watcher 又检测到死 → 再触发重连 → 无上限紧密循环。
稳定观察期 + 重试上限 + giveUp 三道一起把循环收敛到有限次。

### giveUp 的清理(重新给预算)

`reconnectGiveUp` 在重连耗尽时置 true,后续 `startReconnect` / health watcher 不再自动重连。
用户主动操作(发消息 / 继续 / 切配置)经 `ensureLive`(用户路径)清 giveUp → 重新给一个重连预算。
重连循环内部走 `ensureLiveNoReset`(不清 giveUp,否则耗尽 set 的会被自身 attempt 清掉)。

### 为什么用 health watcher 而非 per-session Done 回调

idle 断连检测两种方案:(a) health watcher 周期轮询 `IsAlive()`;(b) `harnessProcess.watch()`
经回调/channel 通知。选 (a):**零接口变更**(不需给 `chatConn` / `ChatSession` / `harnessProcess`
加 Done/WasShutdown 方法与穿透)、无 per-session goroutine 泄漏(预期退出时 watcher goroutine
无 channel 可触发,需额外清理)、与既有 idle reaper 同构(都是周期扫描 active map)。代价是检测
延迟(最多 `healthInterval`,默认 3s),对空闲断连可接受(用户不在等)。

## 改法

### `internal/chat/chat.go`
- 新增 `statusReconnecting = "reconnecting"`(重连进行中,前端据此显示提示)。
- 新增 `ErrCodeHarnessReconnectFailed = "harness_reconnect_failed"`(耗尽后推,前端 i18n 翻译)。
- 新增 `reconnectCtl{stop, done chan struct{}}`(goroutine 生命周期)。
- `ChatService` 增字段:`reconnects` map、`reconnectGiveUp` map、`reconnectEnabled` bool、
  `healthStop/Done`、`healthInterval`、`reconnMaxAttempt/InitBackoff/MaxBackoff/Stability`。
  `NewChatService` 初始化默认值(5 次 / 1s / 30s / 5s / 3s)。
- `ServiceStartup`:`startHealthWatcher()` + `reconnectEnabled=true`(单测默认 false,不触发)。
- `ServiceShutdown`:停 health watcher + `stopAllReconnects()`。
- `ensureLive` → 拆为 `ensureLive`(用户路径,清 giveUp)+ `ensureLiveNoReset`(重连循环用)。
- `startHealthWatcher` / `healthWatcher` / `checkSessionHealth`:周期扫描,死 + 非_busy →
  teardown + startReconnect(idle 分支)。
- `startReconnect`(幂等:giveUp / 已在跑则 no-op)+ `stopReconnect`(close stop + 等 done)+
  `stopAllReconnects`。
- `reconnectLoop`:backoff + 重试上限 + `awaitStability`(稳定观察期,期内死算失败)→
  成功 return / 耗尽 giveUp + emitError。
- `runPrompt`:peer-disconnected 与空 turn 两条 teardown 路径后都加 `startReconnect`。
  cancelled(用户 Stop)分支不加(天然抑制)。
- `CloseSession` / `DeleteSession` / `RemoveProject`:加 `stopReconnect` + `reconnectGiveUp=true`。

### `internal/chat/queue_test.go`
- `fakeChat` 增 `alive atomic.Bool`(默认 true)+ `kill()` 方法,`IsAlive()` 改读它
  (供重连 / health watcher 测试模拟 harness 死)。其余既有用例不依赖 IsAlive 返回值,向后兼容。

### `internal/chat/reconnect_test.go`(新)
- `statusRecorder`(线程安全,emit 来自多 goroutine,避免 data race)。
- 7 个用例:busy 断连重连成功 / spawn 全失败耗尽 giveUp / 稳定期内死算失败 / StopSession 不触发 /
  CloseSession 停重连 / health watcher idle 断连 / giveUp 用户操作清零 / 重连去重。

### `frontend/src/i18n/locales/{zh,en}.json`
- `chat.error.harness_reconnect_failed` 新条目;`harness_disconnected` / `harness_empty_turn`
  文案改为「正在自动重连」(原为「下条消息将自动重连」,已不准确)。

### `AGENTS.md`
- §3.3 标题 + 新增「断连自动重连」段(两条分支 / 退避 / 上限 / 稳定期 / userStopped 抑制)。
- §5.4 #6 新增「自动重连的崩溃循环防护」(稳定观察期 + 重试上限 + giveUp 三道)。

## 验证

- `go build ./internal/...` ✅;`go vet ./internal/...` ✅。
- `go test ./internal/chat/... ./internal/acp/...` ✅(全绿,既有用例不受影响)。
- `go test -race -run 'TestReconnect|TestStopSession|TestCloseSessionStops|TestHealthWatcher|TestGiveUp' ./internal/chat/` ✅(8 个新用例 + userStopped 抑制,-race 干净)。
- `go test ./...`:全绿(根包 `setup failed` 是预先存在的 frontend/dist embed 缺失,与本次无关)。
- 前端 i18n JSON 合法(`bun -e JSON.parse` 验证);前端 `tsc` 报缺 bindings(预先存在,与本次无关)。
- 既有 disconnect 单测(`TestEmptyTurnDetectedAsError` / `TestRunPromptDisconnectEmitsCode` 等)
  不受影响:reconnectEnabled 默认 false(这些单测不经 ServiceStartup),startReconnect no-op。

## 设计要点(为什么这么选)

- **reconnectEnabled flag(单测默认 false)**:既有 disconnect 单测不经 ServiceStartup,
  默认不触发重连 → 断言「最后 status=error」不被「reconnecting」覆盖。生产 ServiceStartup 置 true。
- **ensureLive 拆 ensureLiveNoReset**:用户路径清 giveUp(重新给预算),重连路径不清
  (防耗尽 set 的被自身 attempt 清掉)。二者共享 spawn 段(spawnMu 串行化),不双 spawn。
- **health watcher 而非 per-session Done 回调**:零接口变更、无 goroutine 泄漏、同构 idle reaper。
  代价是检测延迟(3s),空闲断连可接受。
- **稳定观察期在 reconnectLoop 内而非 health watcher**:reconnectLoop 是「主动恢复」路径,
  需要判断 spawn 是否真的成功(而非立刻崩);health watcher 是「被动检测」路径,只管发现死 session。
  两者职责分离。
- **giveUp 不用时间戳/计数器**:用 bool + 用户操作清零 —— KISS,状态空间小,无定时器泄漏。

## 改了哪些文件

- `internal/chat/chat.go`(reconnect 全部逻辑 + ensureLive 拆分 + CloseSession/DeleteSession/RemoveProject 抑制)。
- `internal/chat/queue_test.go`(fakeChat 增 alive + kill)。
- `internal/chat/reconnect_test.go`(新,8 用例)。
- `frontend/src/i18n/locales/zh.json` / `en.json`(reconnect_failed + 文案调整)。
- `AGENTS.md` §3.3(自动重连段)+ §5.4 #6(崩溃循环防护)。
- 本 worklog。

## 下一步 / 关联

- 未做实机验证:需 `wails3 dev` 跑一轮 session,人为 kill harness(崩溃 / 空闲自杀)查日志落
  `reconnect succeeded` / `reconnect exhausted`。机制已单测 + -race 覆盖,实机为锦上添花。
- 前端未做「reconnecting」状态专门渲染(状态被 statusBySession 跟踪,但不影响输入/自动续发逻辑)。
  如需「重连中」spinner / 禁用输入,可后续在 App.tsx 加 status === "reconnecting" 分支。
- health watcher 间隔 3s 是默认值;若实机发现空闲断连检测太慢/太频繁,可调 `healthInterval`。
