# 2026-08-29 · Review #152 后端面终审(#27988)——NEEDS CHANGES,1×P2(commands 回调注册竞态)

## 起因

终审 #152 五提交(daad23c/06f869d/ddbe4e6/995c6c7/e49d550,基线 rak main=e49d550)的 internal/ 面:0022 迁移 + store 读写 + handler 直落 + chat 装配。前端面归后续 fe-review 卡,本卡未审。

## 结论

**NEEDS CHANGES**:1×P2(功能自身写点的注册竞态,修法机械)+ 2×P3 留档。0022 迁移、store 三态、handler 范式、单写点反向验证全部复核通过;测试锚定值扎实。

## 复核矩阵(任务书四点全过)

1. **0022 迁移** ✓:sqlite3 CLI 独立实证(非 Go 测试路径)——0001→0022 顺序应用后 pragma 显示 `commands_cache TEXT NOT NULL DEFAULT ''`;无列名 legacy INSERT 读回 `''`;显式 NULL 插入被 NOT NULL 拒绝(exit 19)。与 0011 先例同形,无 NULL 哨兵。
2. **store 读写** ✓:`sessionColumns` 26 列 ↔ `scanSession` 26 dest,顺序逐一对齐;`UpdateSessionCommandsCache` raw 透传写、不动 `updated_at`(对齐 tags 0021,与 0011 touch updated_at 的偏离已在注释写明理据);解析留 chat 层(store 不 import internal/acp,分层正确)。JSON 三态 + 损坏矩阵(`not json`/`{"a":1}`/`[1,2]`/`null`)测试锚定值复核通过。
3. **handler 直落** ✓:`emitCommandsCache`/`SetCommandsCache` 严格照 `emitGlobalRule` 范式(mu 快照指针、锁外调用、recover);`flattenUpdate` 的 `make([]SlashCommand,0,len)` 保证空表非 nil → marshal 出 `[]` 非 `null`;`SessionUpdate` 在 `Kind=="available_commands"` 时先落库再 `OnEvent`;nil 回调 no-op;panic recovered 测试在位。
4. **反向验证(单写点)** ✓:全仓 grep——`UpdateSessionCommandsCache` 唯一生产调用方是 `persistCommandsCache`(chat.go:2491);后者唯一装配点是 `startLive` 闭包(闭包钉死 DB session id,ACP id 会 UPDATE 零行——实现期已自抓);`handleEvent` 不写 commands(无双写);binding `GetSessionCachedCommands` 只读,App.tsx 仅读不写。前端不参与写路径成立。

## P2 —— OnCommandsCache 注册竞态:startLive 装配晚于 reader 分发,首个 available_commands_update 可静默丢库

**问题**:`OnCommandsCache` 是 handler 里**唯一**经 setter 后置注册、且触发源可能在 setup 期间到达的事件回调。时序:`spawnAndInit` 内 `NewClientSideConnection` 起 reader goroutine → `conn.NewSession`/`session/resume` RPC 期间/刚返回时,通知已可被 reader 分发进 `h.SessionUpdate` → `emitCommandsCache` 快照到 nil → 静默丢弃;而 `SetCommandsCache` 要等 startLive 走完 `slog.Info` + `registerHarness` + 4 个 setter 才执行。

**证据**(非推测):
- 本仓调研 worklog `2026-08-01-acp-available-commands-investigation.md`:**omp 源码** `#emitAvailableCommandsUpdate` 经 `setTimeout(0)` 排队发射,注释明说「直接发会与 NewSession 响应竞态,Zed 会丢首条」——同一竞态族的前科;**opencode** `sendAvailableCommands` 在 NewSession/LoadSession/replay 路径**无**延迟保护,通知紧跟响应帧,reader 分发与 caller 走完 startLive 尾部(goroutine 唤醒 + 日志 I/O + 5 次锁)是同一量级的赛跑,丢首条概率不可忽略。
- 结构证据:`onEvent`/`onPermission`/`onElicitation` 全部经 `NewHandler` 构造期注册(先于连接),`SetGlobalRule`/`SetElicitationResolved` 后置但触发源(权限/elicitation)只在 turn 中到达;commands 广告是唯一「setup 即到」的 setter 事件。

**后果**:丢首条 → 该次 live 的命令表不落库。live UI 不受影响(OnEvent 路径照常推前端),但缓存停在 `''`(新 session)或旧表(resume);懒 spawn 只读态 slash 菜单——本功能的核心交付——对该 session 显示空/陈旧,直到某次 live 重新竞赢或 harness 因元数据变更重发。自愈是概率性的,不是确定性的。

**修法(机械,建议采纳)**:把回调升为构造参数——`NewChatSession`/`ResumeChatSession` 增参 `onCommandsCache func(sessionID string, cmds []SlashCommand)`,`NewHandler` 直注,注册先于 `spawnAndInit`,窗口归零。生产调用方仅 `startLive` 一处,测试调用方 2 处(`integration_test.go`/`resume_test.go`,补一个 `nil`)。备选:handler 缓存最近一次 flat commands + `SetCommandsCache` 注册后 startLive 回灌一次(代码更多,不如升参)。

## P3 留档(不阻塞本卡)

1. **pre-existing 测试数据竞态**(基线 c2788c6 已复现,与 #152 无关):`go test -race ./internal/chat/` 下 `TestEmptyTurnDetectedAsNotice`/`TestEmptyTurnAfterElicitDeclineIsSilentIdle`/`TestRunPromptDisconnectEmitsCode`/`TestRunPromptBrokenPipeEmitsCode` 报 DATA RACE——`empty_turn_test.go` 等的 emitHook 闭包(turn goroutine 写 `lastPayload`)与测试 goroutine 轮询读无同步。仓库门是无 -race 的 `go test ./...`,所以从未暴露。建议另开小卡:emitHook 回调内 channel/atomic 化。
2. **环境噪声**:本机 go1.26.0 `gofmt` 会对注释内 ASCII `''` 提议改写为弯引号(会破坏语义,勿 `gofmt -w`),且基线 8 个旧文件同样不过该 gofmt;仓库无 gofmt 门,不属本卡。`go build ./...` 因 `frontend/dist`(gitignored)未生成而 embed 失败,属 worktree 环境态,非提交缺陷。

## 验证记录

- sqlite3 独立迁移实证:pragma 形/legacy 默认/NULL 拒绝,全中(见上)。
- `go build ./internal/...` ✓、`go vet ./internal/...` ✓。
- `go test ./internal/...`(仓库门)✓ exit 0(ld macOS SDK warning 为环境噪声)。
- `go test -race ./internal/store/... ./internal/acp/...` ✓ 全 ok——**#152 新增测试全部在 -race 下通过**;chat 包 -race 的 4 失败均为 P3-1 基线竞态(临时 worktree @c2788c6 复现同败后已清理)。
- 消费链反向追踪:写点唯一性 grep 全仓复核;空表覆盖端到端链(handler 非 nil 空 slice → persist nil 归一 `[]` → store 原文 → getter 空非 nil)三层测试闭环。

## 改了哪些文件

仅本 worklog 条目。未改被审代码(review 角色);issue #152 保持 open 待人工复核。

## 下一步

1. P2 修法落地(建议独立小卡,改动面:runner.go 两签名 + NewHandler + startLive + 2 个 integration 测试调用点 + 1 个「注册先于分发」回归测试:用注入 onCommandsCache 的 handler 在 `conn.NewSession` 返回前发 notification 断言不丢)。
2. P3-1 测试竞态另开卡;P3-2 无动作。
3. 前端面(seed 通路/`:336` 事件分支/`:478` 消费)交 fe-review 卡,本卡未审。
