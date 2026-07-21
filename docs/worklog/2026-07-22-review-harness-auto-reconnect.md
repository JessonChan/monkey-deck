# 2026-07-22 Review #34-C harness 断连自动重连端到端验收结论(PASS)

## 起因

Task #21320(Review):验收 Task #21317「harness 断连自动重连(主动 spawn + 指数退避 +
重试上限 + busy/idle 分支 + userStopped 抑制)」的三个 commit(`1361a1e` feat /
`48afbb7` test / `cb86a94` docs),含 `f97ea60` rebase 还原。

重点不是「能否编译」,而是「代码是否真的让 disconnect 后主动 spawn 新 harness 自愈、
退避/上限/稳定期是否真的限制循环、busy/idle 两条分支是否真的各触发、userStopped 是否
真的抑制」——拒收「加了 `reconnectLoop` / `reconnectGiveUp` 字段但 runPrompt 从不调
`startReconnect`、或 cancelled 分支也触发重连」的空壳改动,以及「测试存在却不断言核心
行为」的纸面绿。

## 五条不变量逐条核对(diff + 代码读穿,不只看函数签名)

### 1. 主动 spawn 重连(非空壳)
- `reconnectLoop`(chat.go:1331-1358)在 backoff 后真调 `s.ensureLiveNoReset(sessionID)`
  (chat.go:1340)——`ensureLiveNoReset` 即原 spawn 入口(读 active / 缺则 `startLive`
  spawn harness)。**循环体确实发起 spawn,不是只 emit status。** ✓
- spawn 成功 → `awaitStability` 确认存活 → `return`(成功)。失败 → backoff 翻倍继续。

### 2. 指数退避(真翻倍 + 真上限)
- `backoff = min(backoff*2, s.reconnMaxBackoff)`(chat.go:1342 spawn 失败 / 1347 稳定期
  失败两处都翻倍)。初始 1s、上限 30s(NewChatService 默认)。**确实按 2x 增长并封顶。** ✓

### 3. 重试上限(真耗尽 + 真停摆)
- `for attempt := 1; attempt <= s.reconnMaxAttempt; attempt++`(chat.go:1332)。耗尽 →
  `reconnectGiveUp[sessionID]=true`(chat.go:1355)+ `emitError(ErrCodeHarnessReconnectFailed)`。
- `startReconnect` 入口判 `reconnectGiveUp` → no-op(chat.go:1272)。**耗尽后真停摆。** ✓

### 4. busy/idle 两条分支都真触发
- **busy**:`runPrompt` 两条 teardown 路径后都调 `startReconnect`——
  peer-disconnected 分支(chat.go:1656 teardown + 1659 emitError + **1662 startReconnect**)
  与空 turn 分支(1669 teardown + 1671 emitError + **1673 startReconnect**)。✓
- **idle**:`checkSessionHealth`(health watcher)扫描 `!IsAlive() && !busy` →
  `teardownLive` + **`startReconnect(d.id)`**(chat.go:1259-1261)。busy 的跳过(交 runPrompt)。✓
- 两条分支共用同一 `reconnectLoop`,只是触发源不同——设计正确。

### 5. userStopped 抑制(真抑制,非纸面)
- **StopSession 干净 cancel**:`cancelled := err != nil && turnCtx.Err() != nil`(chat.go:1635)
  → `if cancelled { emitStatus idle/cancelled; return }`(chat.go:1646-1649)——**return 在
  `startReconnect`(1662)之前,cancelled 永远到不了 1662**;且不调 teardownLive(harness 仍可用)。
  这是「天然抑制」的真正机制,核对无误。✓
- **CloseSession**(chat.go:1101 `reconnectGiveUp=true` + 1105 `stopReconnect`)、
  **DeleteSession**(561 giveUp + stopReconnect)、**RemoveProject**(464 giveUp 循环 +
  stopReconnect 循环):三条主动关停都 stopReconnect + giveUp,防在途/后续 health watcher
  把刚关的 session 又拉起来。✓

### 配套机制也核对到位
- **稳定观察期**(`awaitStability`,chat.go:1364-1389):spawn 后周期(=stability/5)查
  `IsAlive()`,期内死算失败继续重试。覆盖「spawn OK 但立刻崩」的崩溃循环。✓
- **giveUp 重新给预算**:`ensureLive`(用户路径,chat.go:968-970)清 giveUp,重连循环走
  `ensureLiveNoReset`(不清,972 委托)。二者共享 spawn 段(`spawnMu` 串行,不双 spawn)。✓
- **幂等去重**:`startReconnect` 判 `reconnects[sessionID]` 已存在则 no-op(chat.go:1275)。✓

**结论:bug(被动等用户重连)确实被修复**——disconnect 后后台主动 spawn 自愈;五条不变量
都在函数体里真实生效,非签名/类型层面的空壳。

## 测试是否真覆盖新行为(防「测试存在却无价值」)

8 个用例(`reconnect_test.go`),逐条核对断言强度——**无一是「只断言编译过」的纸面绿**:

1. `TestReconnectBusyDisconnectSuccess`:首 Prompt 注 `peer disconnected` → 断言 spawn==2
   (初始 + 重连)、`isActive(sid)`、`has("error")`。**断言重连真的再 spawn 了一个。** ✓
2. `TestReconnectSpawnAlwaysFailsExhausts`:spawn 永返错 → 断言 spawn==maxAttempt、
   `last()=="error"`、`reconnectGiveUp==true`,且 giveUp 后再 `startReconnect` spawn 计数==0。
   **钉死「耗尽停摆」。** ✓
3. `TestReconnectStabilityFailure`:每次 spawn 后立刻 `chat.kill()` → 断言 spawn==maxAttempt
   (稳定期内死都算失败、继续重试)。**钉死稳定观察期机制。** ✓
4. `TestStopSessionDoesNotReconnect`(userStopped 核心):StopSession → 断言 `last()=="idle"`、
   `!has(statusReconnecting)`、`isActive(sid)`(未 teardown)、spawn==1(无重连 spawn)。
   **核心抑制断言:无 reconnecting + 无 extra spawn + 仍 active。** ✓
5. `TestCloseSessionStopsReconnect`:backoff 等待期 CloseSession → 断言 reconnecting 已移除、
   `reconnectGiveUp==true`。✓
6. `TestHealthWatcherIdleDisconnect`:手塞死 chat 进 active + 起 watcher → 断言 spawn==1、
   `has(statusReconnecting)`、`isActive(sid)`。**idle 分支真触发。** ✓
7. `TestGiveUpClearedOnUserInteraction`:置 giveUp → startReconnect 不 spawn → 用户 SendMessage →
   断言 giveUp 已清、spawn==1。**钉死「用户操作重新给预算」。** ✓
8. `TestReconnectDedup`:三次 startReconnect + 长 backoff → 断言 `len(reconnects)==1`。✓

**并发安全**:`statusRecorder` 用 `sync.Mutex` 保护 append/snapshot/has/last;emit 走
`emitHook`(chat.go:351,同步在调用方 goroutine)。runPrompt / reconnectLoop / healthWatcher
多 goroutine 写同一 recorder 无 data race(已 `-race` 验证)。`fakeChat` 的 `alive` 用
`atomic.Bool`(queue_test.go:37),`kill()` 翻 false 供重连/health 测试模拟死——改动向后兼容,
既有用例不读 IsAlive 返回值。

## 验证(标准 gate)

- `go build ./internal/...`:通过(仅 macOS SDK 版本号 ld warning,非错误)。✓
- `go vet ./internal/...`:干净。✓
- `go test -race -run 'TestReconnect|TestStopSession|TestCloseSessionStops|TestHealthWatcher|TestGiveUp|TestReconnectDedup' ./internal/chat/`:
  ok(3.455s),8 用例全绿,**`-race` 干净**。✓
- `go test ./internal/chat/... ./internal/acp/...`:ok(chat 2.662s / acp 2.787s)。✓
- 前端 i18n:`zh.json`/`en.json` 均 `JSON.parse` 合法;`harness_reconnect_failed` 新条目 +
  `harness_disconnected`/`harness_empty_turn` 文案改「正在自动重连」(与新主动重连语义一致)。✓

无 acceptance_cmd 下发,以上为标准验收命令(build/vet/-race test + 逐条断言核对)。

## 规约合规

- §3.3 自动重连(两条分支 / 退避 / 上限 / 稳定期 / userStopped 抑制):实现与 AGENTS.md
  新增段逐条对应。✓
- §5.4 #6 崩溃循环防护:稳定观察期 + 重试上限 + giveUp 三道齐全(对应 worklog 设计)。✓
- §3.2 进程组回收:未改动回收层;reconnect 复用 `ensureLiveNoReset`(同一 spawn 段),
  无新增裸 kill。✓
- §5.3「找不变量,不堆 if」:以「reconnects map 主键 = sessionID」归并去重(同时只一个重连),
  不靠「上次事件类型」启发式;giveUp 用 bool + 用户路径清零(KISS,无定时器泄漏)。✓
- §5.1:单测注入 mock(fakeChat + spawnFn),**未启真 harness**。✓
- §0.3 / §6.2:被验收方 worklog 已写(`2026-07-22-harness-auto-reconnect.md`)、原子提交
  (feat / test / docs 分离)、message 说清改了什么 + 为什么、diff 不夹带无关文件。✓

## 诚实标注(非阻塞,被验收方已自文档化)

被验收方 worklog「下一步」已诚实记录:
- 未做 `wails3 dev` 实机验证(需人为 kill harness 查 `reconnect succeeded`/`reconnect exhausted`
  日志)。机制已单测 + `-race` 覆盖,实机为锦上添花,不阻塞合入。
- 前端未做「reconnecting」状态专门渲染(status 被跟踪但不影响输入/自动续发);如需 spinner/
  禁用输入可后续在 App.tsx 加 `status === "reconnecting"` 分支。合理推迟。
- `error_code_test.go` 的 `lastPayload` 数据竞争(**预先存在**,rebase 还原 worklog 已在
  `main` 上复现确认非 #21317 引入),需单独修(给 emitHook 读写加同步)——记成 OPEN,不在本验收范围。

## 结论

**PASS**。五条不变量(主动 spawn / 退避 / 上限 / busy-idle 恢复 / userStopped 抑制)均在函数体
真实生效、cancelled 分支 return 确在 startReconnect 之前(抑制非纸面)、配套稳定期/giveUp/
去重齐全、8 个用例断言强度足够(无纸面绿)、`-race` 干净、build/vet 通过、i18n 与新语义一致、
规约合规、commit 原子无夹带。可合入。

## 改了哪些文件

- `docs/worklog/2026-07-22-review-harness-auto-reconnect.md`(本文件)。
