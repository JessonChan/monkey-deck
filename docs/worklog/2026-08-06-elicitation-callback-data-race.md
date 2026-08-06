# 2026-08-06  elicitation / permission 回调字段 data race 修复

## 起因

`go test -race ./internal/acp/` 抓到 `DATA RACE`,指向 `elicitation.go` 的 `dispatchElicitation` /
`notifyElicitationResolved` 路径。用户判定为真 bug,要求修复并用 `kimi -p` review。

## 根因

两类 race,同一根源:**回调函数字段在「ACP reader goroutine 读」与「service goroutine 写」之间无同步。**

1. **生产 race(真 bug)**:`Handler` 的 `OnElicitationResolved`、`OnGlobalRule` 不是构造期赋值,
   而是在 `chat.go` `startLive` 里(`chat.Handler.OnElicitationResolved = ...` / `OnGlobalRule = ...`,
   原 1474-1475)赋值。问题是 `runner.NewChatSession`(1460 行)**已经启动了 ACP reader goroutine**,
   到这两行赋值时 reader 已经在跑 —— handler 里 `notifyElicitationResolved`(读 `OnElicitationResolved`)
   与 `emitGlobalRule`(读 `OnGlobalRule`)的裸读跟这两行写构成 data race。reader 在第一轮 Prompt
   之前通常不会真触发 elicitation,所以「时序上」难得命中,但按 Go 内存模型这是真 race,`-race` 会抓,
   长期是雷。

2. **测试 race(`-race` 直接命中的那个)**:`TestUnstableCreateElicitationFormDispatchAndRespond`
   把 dispatch 结果写进一个跨 goroutine 共享的局部变量 `var got ElicitationPrompt`,然后主 goroutine
   用 `for time.Now().Before(deadline) && got.ID == "" { time.Sleep(...) }` busy-wait 轮询它 ——
   典型无同步跨 goroutine 共享写。同类权限测试(`handler_global_test.go`)早就用 channel 传 prompt id
   并注明「避免数据竞争」,elicitation 这个测试是漏网的异类。

   `OnEvent`/`OnPermission`/`OnElicitation` 是 `NewHandler` 构造期赋值,reader goroutine 之后才启动
   (`runner.go` spawnAndInit → `NewClientSideConnection`),go 语句自带 happens-before,**安全**,不动。

## 改法

遵循 §5.3「找不变量」:不变量是「回调指针的读写要同步」。统一用 `h.mu`(Handler 既有的锁,已保护
`pending`/`pendingElicit`/`permSeq`/`elicitSeq`)做「读侧快照 + 锁外调用 + 写侧加锁赋值」,不在持锁期间
调外部回调(否则回调重入 handler 任何 `h.mu` 方法会自死锁,如 `persistGlobalPermissionRule`
→ `applyPermissionRulesToAll` → `SetPermissionRules`)。

- `notifyElicitationResolved`:`h.mu` 下拷贝 `OnElicitationResolved` 到局部 `cb`,释放锁,nil 检查,
  锁外 `cb(id)`(原 panic recover 保留)。
- `emitGlobalRule`:同款快照模式。
- 新增 `SetElicitationResolved(cb)` / `SetGlobalRule(cb)` 两个 setter(`h.mu` 下赋值);`chat.go`
  `startLive` 改用 setter,不再裸写字段。
- **测试**:`TestUnstableCreateElicitationFormDispatchAndRespond` 的 `OnElicitation` 回调改成往
  `promptCh chan ElicitationPrompt`(容量 1)投递,主 goroutine `select` 收(500ms 超时兜底),
  彻底消除 busy-wait race。
- **顺带(kimi review 发现)**:`emitGlobalRule` 补 panic recover + `slog.Error`,与
  `dispatchPrompt`/`dispatchElicitation`/`notifyElicitationResolved` 三个分发点保持一致 ——
  `persistGlobalPermissionRule` 走 DB + 刷新全部 session,panic 冒泡到 reader goroutine 会 tear down
  整个 ACP 连接(正是 `dispatchPrompt` 加 recover 要防的事)。

触及的中文注释顺手转英文(§3.7)。

## 改了哪些文件

- `internal/acp/elicitation.go`:`notifyElicitationResolved` 快照化 + 新增 `SetElicitationResolved`。
- `internal/acp/handler.go`:`emitGlobalRule` 快照化 + 补 recover;新增 `SetGlobalRule`。
- `internal/chat/chat.go`:`startLive` 用 `SetGlobalRule`/`SetElicitationResolved` 替代裸赋值。
- `internal/acp/elicitation_test.go`:`TestUnstableCreateElicitationFormDispatchAndRespond` busy-wait → channel。

## 验证

- `go test -race ./internal/acp/` —— **PASS**(3.5s,修复前必 FAIL 报 DATA RACE)。
- `go test ./internal/chat/` —— PASS(无 -race;注:见下方 OPEN,chat 包 -race 另有 pre-existing 测试 race,与本次无关)。
- `go build . ./internal/...` —— 通过(仅 macOS SDK 版本 ld warning,与本次无关)。
- `kimi -p` review 结论 **Approve**,逐条确认:锁用法正确(同把 `h.mu`、锁外调用、无死锁);
  happens-before 经互斥锁双向成立(不依赖 reader 启动时序);测试 channel 方案充分(容量 1、超时、
  respond 闭环 + 二次 respond 返回 false)。kimi 另指出两条(见下),其中 `emitGlobalRule` 缺 recover
  已在本提交一并修掉。

## 下一步 / OPEN

- **`SetPermissionRecovery` 同类隐患(未修,留 OPEN)**:它裸写 `permRetries`/`permTimeoutPolicy`,
  而 `RequestPermission`(handler.go:422/475)在 reader goroutine 上裸读。**目前无生产 caller**
  (grep 确认只有 `handler_global_test.go`/`handler_recovery_test.go` 调,且都在 `go` 之前),所以不是活 race;
  但其注释写「仅在 session 启动 / 配置变更时调用」——正是本次修掉的模式。等它接 DB/设置 UI
  (见 `2026-07-14-permission-callback-recovery.md` 下一步)时,必须同款用 `h.mu` 或 atomic 保护,
  否则 race 原样回归。本次不动它(非 elicitation 范围、非活 race,避免夹带)。
- kimi 另提一个非阻塞观察:elicitation 的 ctx 取消分支返回 `ctx.Err()`(elicitation.go:98),
  而 permission 路径特意返回 nil(handler.go:462-467:SDK 会把 ctx.Err 变 -32800 丢弃 cancelled outcome)。
  既有行为,不在本次范围,后续确认 elicitation 是否有同样坑。
- **`internal/chat/empty_turn_test.go` 同款测试 race(pre-existing,未修,留 OPEN)**:跑全仓
  `go test -race ./internal/...` 时 chat 包 FAIL,`TestEmptyTurnDetectedAsNotice` /
  `TestEmptyTurnAfterElicitDeclineIsSilentIdle` 报 DATA RACE。根因与本次修的 elicitation 测试
  **完全同款**:`svc.emitHook` 回调在 prompt goroutine 上写局部变量 `lastPayload`(empty_turn_test.go:28/80,
  经 chat.go:417 `s.emitHook`),测试主 goroutine 用 busy-wait 轮询读 `lastPayload.Status`(:40/:92)。
  **已用 git stash 证明是 pre-existing**(stash 掉本次改动后原码照样 FAIL),非本次引入、非 elicitation 范围。
  修法同款:emitHook 改往 buffered channel 投递 StatusPayload,测试 `select` 收到首个非 "prompting" 终态为止。
  本次不动(超出用户指定的 elicitation 范围),单独起一个 commit / worklog 处理。
