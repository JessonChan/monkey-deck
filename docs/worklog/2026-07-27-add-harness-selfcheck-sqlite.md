# 2026-07-27 添加 harness 自检门槛 + SQLite 持久化(声明即用流程并入主线)

## 起因

`pre-merge` 分支合并了 `goose-exp` + `rak/main`,但「添加 harness」走的是 Task #23417 的**简化版**:`AddHarness(id,name,command)` 落 `DataDir/harnesses.json`(纯 JSON 文件),**无添加前自检** —— probe 降级成添加后异步 best-effort。

而更早的实验分支 `md/c1b7c453`(声明即用向导)有一套更对的流程:用户填命令 → **ProbeHarness conformance 自检作为添加前硬门槛**(spawn→Initialize→NewSession→Prompt 跑到 end_turn,产出体检单)→ CanAdd 才允许落库,且持久化用 **SQLite `user_harnesses` 表**。

经确认:这套自检/体检单流程是对的,要并进主线;当前三字段 modal UI 保留(不换成多步向导);存储改回 SQLite 表。即「向导的流程 + 当前 UI + SQLite 存储」的混合版。

## 根因 / 调研

- **自检逻辑"消失"不是因为没合并**:`git log pre-merge..goose-exp` 为空,goose-exp 已 100% 并入 pre-merge。ProbeHarness/向导那套提交(`d959bc8`/`ca213f1`/`8d5d6c0` 等)**只活在会话 worktree 分支 `md/c1b7c453` 上**,与 goose-exp 的 merge-base 是很老的 `11f5750`,从未进过任何主干。
- **两套实现架构不兼容**:向导版用 SQLite 表(migration 0012)+ `ProbeNewHarness`/`AddUserHarness` binding + 添加前硬门槛;简化版用 `harnesses.json` + 单 `AddHarness` + 添加后异步 probe。不能直接 cherry-pick,要**移植概念**。
- **acp 包 API 完全兼容**:`NewRunner`/`spawnAndInit`/`NewHandler(workDir,onEvent,onPermission,permTTL)`/`RespondPermission`/`harnessProcess.shutdown`/`SessionEvent{Kind,MessageID}`/`PermissionOption{OptionID,Kind}` 全在 pre-merge;`capability.go`(ProbeCapabilities)已证明 `InitializeResponse.AgentCapabilities` 子字段都能访问 → probe.go 可近乎原样移植。
- **存储选型**:SQLite 表与 session/project/permission 一致走 store 唯一入口(§2.1),享受事务/迁移/并发安全,比再多一份 JSON 文件更符合 §1.5「本地是真相」。
- **harness 包改造幅度**:pre-merge 的 `harness.Command/Commands/Normalize` 都读 `effectiveSupported`/`effectiveRegistry` → 读内存 holder。只要 holder 改由 store 灌入(`SetUserHarnesses`),这些函数零改动继续工作。harness 包保持 **store-free**(md/c1b7c453 同款约束),由 service 层做 store→harness 转换。

## 改法

**后端(移植概念,非套 diff):**
1. 新增迁移 `internal/store/migrations/0012_user_harnesses.sql`(`user_harnesses` 表:id/name/command/icon/created_at)。
2. 新增 `internal/store/user_harnesses.go`:CRUD(Create/List/Get/Delete),`UserHarness` 含 created_at。
3. 新增 `internal/acp/probe.go`:`ProbeHarness(ctx, command) *ConformanceReport` + `ConformanceReport.CanAdd()`(Tier1 四项全过)+ `Summary()`。每步硬超时(诊断场景,与活 turn §3.3 no-timeout 无关);零 per-harness 身份分支。严格门槛要求 end_turn(证当前环境真能跑完一轮)。
4. `internal/harness/user.go`:**删 JSON I/O**(`LoadUserHarnesses`/`SaveUserHarnesses`/`UserHarnessesFile`),保留 `UserHarness` 结构 + `SetUserHarnesses`/`UserHarnesses` + `ValidateUserHarness`(纯函数)+ `effectiveSupported`/`effectiveRegistry`。包保持 store-free。
5. `internal/chat/chat.go`:
   - 新增 `reloadUserHarnesses()`:从 store 读 → 灌 holder + 重注入 reaper 命令集。空 = nil(保持 `UserHarnesses()` 的"空=未设置"约定)。
   - `loadPersistedConfig` 启动加载从 JSON 改为 `s.reloadUserHarnesses()`(顺序仍正确:store@320 → loadPersistedConfig@325 → SetHarnessCommands@328)。
   - 新增 binding `ProbeNewHarness(command) (*acp.ConformanceReport, error)`:3min 上限,返体检单。
   - 重写 `AddHarness(id,name,command)`:结构性校验(复用 `ValidateUserHarness`)→ `store.CreateUserHarness` 落库 → `reloadUserHarnesses` → Discover 刷新 + 异步能力探测。**服务端不重跑 probe**(前端已显式自检过,重跑 90s+ 既慢又费 token)。

**前端(保留当前 UI,接自检流程):**
6. `frontend/src/components/AddHarnessModal.tsx`:保留 ID/Name/Command 三字段;加「自检」按钮(ProbeNewHarness)→ 体检单(verdict + Tier1 四 chip + 能力摘要 + 可选功能预警)→ **CanAdd 才解锁「添加」**。命令改动后体检单失效(`report.command !== cmd`),需重新自检。
7. `wails3 generate bindings`:生成 `ProbeNewHarness` binding + `ConformanceReport`/`CheckResult` model(14 models)。
8. i18n(zh/en 同步):更新 `addDesc`,新增 `addProbe`/`addProbing`/`addVerdictOk`/`addVerdictFail`/`addTier*`/`addCap*`/`addGap*`/`addWarnPrefix`/`addNeedProbe`。
9. `frontend/src/index.css`:`.ah-report`/`.ah-verdict`/`.ah-tiers`/`.ah-tier`(pass/fail 配 `--green`/`--red`)/`.ah-caps`/`.ah-warn`/`.ah-need-probe`;卡片加宽到 392px。

**收尾:**
10. `README.md`:修掉过时描述(原指向 goose-exp 的「声明即用向导 + ProbeHarness」),改成主线现状(自检门槛 + SQLite)。

## 改了哪些文件

- 新增:`internal/store/migrations/0012_user_harnesses.sql`、`internal/store/user_harnesses.go`、`internal/acp/probe.go`、`internal/acp/probe_test.go`
- 改:`internal/harness/user.go`、`internal/harness/user_test.go`、`internal/chat/chat.go`、`internal/chat/user_harness_test.go`、`frontend/src/components/AddHarnessModal.tsx`、`frontend/src/i18n/locales/zh.json`、`frontend/src/i18n/locales/en.json`、`frontend/src/index.css`、`README.md`
- 重新生成(不入库):`frontend/bindings/...`

## 验证

- `go build . ./internal/...` 通过(仅 macOS 链接器版本告警,无关)。
- `go test ./...` 全绿(harness/store/acp/chat 等 12 包 ok);新增 `probe_test.go` 覆盖 `CanAdd` 门槛(Tier1 任一失败即假、Tier2 缺失不阻断)+ `Summary` 渲染(verdict + 预警);`user_harness_test.go` 改为校验 SQLite 落库(`ListUserHarnesses`)而非 JSON 文件。
- 前端 `tsc --noEmit` 通过;`bun test` 147 pass / 0 fail(含 i18n locale 同步)。
- 存储切换:旧的 `harnesses.json` 路径完全删除(grep 无残留 `UserHarnessesFile`/`LoadUserHarnesses`/`SaveUserHarnesses` 引用)。

## 下一步 / OPEN

- **数据迁移**:已用旧版(`harnesses.json`)添加过 harness 的用户,升级后 JSON 文件不再被读取 —— 需手动把命令重新填进新弹窗(经自检)添加。可考虑写一次性迁移(启动时若 `harnesses.json` 存在则导入进 SQLite 再删文件),但当前无已知真实用户数据,KISS 暂不做。
- **删除闭环**:`store.DeleteUserHarness` 已具备,但 modal/UI 未接删除按钮(md/c1b7c453 有完整删除 + session 失效守卫,可按需移植)。当前用户加错可手改 DB 兜底。
- **自检的 token 成本**:ProbeHarness 会发一轮真实 Prompt(`Reply with exactly: OK`),消耗少量 token;这是「证当前环境真能跑完一轮」的代价(严格门槛),可接受。
