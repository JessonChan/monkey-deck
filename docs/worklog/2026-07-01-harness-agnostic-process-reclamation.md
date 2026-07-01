# 2026-07-01 进程回收通用化:KillAllOpencode → KillAllHarnesses(治本 omp 孤儿泄漏)

## 起因

排查会话 `76d67133…`(用户反馈「对话失败停了」)时,发现该轮「继续」turn 死于 `wails3 dev`
热重载:重启时 `chat service started` + `KillAllOpencode` 把正在跑的 opencode 当孤儿杀了
(`peer disconnected before response`,见 `monkey-deck.log` 10:32:25)。进一步追问
「为什么会有 KillAllOpencode」时,用户指出:**它是 opencode 专属的,其它 harness 呢?**

## 根因(实证)

进程回收层**脑裂**——tracking 通用、discovery/kill 专属:

- `registerHarness/unregisterHarness/isActiveHarness/pgidFile` 按 pgid,**通用**(omp/opencode spawn 时都登记)。
- `listOpencodeProcs/KillAllOpencode/reapStrayOpencode` 却 `strings.Contains(line, "opencode acp")` 写死,**专属**。

实测当前系统活进程:

| PID | 命令 | 父进程 | 归属 |
|---|---|---|---|
| 2938 | `bun /Users/jessonchan/.bun/bin/omp acp` | monkey-deck | 本应用 **omp**(默认/主力) |
| 5251 | `opencode acp` | `rak-daemon` | RAK 的,不是我们 |

`opencode-pgids.json = [368, 2938]` → 2938(omp)**被登记了**,但 omp 命令行是
`bun …/omp acp`,**不含 "opencode acp"** → `listOpencodeProcs` 永远收不到它。
日志里 omp spawn 166 次、opencode 34 次 —— **漏掉的恰好是主力 harness**。

后果:monkey-deck 一旦崩溃/热重载(`ServiceShutdown` 没跑 → pgid 没 unregister),

- opencode 孤儿:pgidFile 有、grep 也认 → 启动时杀掉 ✅
- **omp 孤儿**:pgidFile 有、grep 认不到 → **永久泄漏**(reparent 到 launchd,50-150MB/个,永不回收),且重开 resume 同 session 可能与残留 omp 撞存储 ❌

## 改法(方案 A:以 pgidFile 为唯一真相,按组杀)

不再 `ps`+字符串「发现」该杀谁;**该杀谁 = pgidFile 里登记的 pgid**。`ps` 只保留一道
**安全过滤**:确认该 pgid 当前进程仍是受支持 harness(防 pgid 被 OS 复用后误杀无关进程,
如 Chrome)。这个过滤覆盖**所有** `harness.Supported` 命令,不再写死 opencode。

- `KillAllHarnesses`:遍历 tracked pgid → 若 `listHarnessProcs` 确认其仍形似 harness →
  **`kill -PGID` 整组回收**(顺带对齐 §3.2「整组回收」;旧 `KillAllOpencode` 按 PID 单杀其实也违规)→ 清空 pgidFile。
- `listHarnessProcs`/`isHarnessCmdline`:按受支持命令子串匹配(omp 的 `bun …/omp acp`
  仍含子串 "omp acp",故子串匹配覆盖裸命令与 wrapper 两形态)。`harnessCmds` 为空 → 返回 nil(安全降级)。
- 受支持命令经 `harness.Commands()` → `acp.SetHarnessCommands` 注入(ServiceStartup 调一次),
  **acp 包不反向依赖 harness**(走 setter,同 `SetPgidFile` 模式)。

边界(讲清,不 over-claim):
- **绝不杀不是我们派生的**:判定依据 = pgid 在不在 pgidFile(rak 的 opencode 5251 的 pgid 不在 → 跳过)。
- **脱组逃逸的孙进程**(harness 自己 setpgid 出去的 bash 等)是 §5.4 #5 已知硬伤,本改**不解决**
  (现状也没解决);本次只把「harness 进程组 + stray harness」做到 harness 无关。
- `reapStrayHarnesses`(运行时,仅无活跃 session 时调)沿用既有「杀非活跃 harness 命令行」语义,
  理论上会命中其它应用(如 RAK)派生的同命令 harness——既有行为,主孤儿回收(限定本应用 pgid)在 `KillAllHarnesses`。

## 改了哪些文件

- `internal/acp/proc.go`:重命名 `opencodeProc→harnessProc`、`listOpencodeProcs→listHarnessProcs`
  (新提取 `isHarnessCmdline`)、`reapStrayOpencode→reapStrayHarnesses`、
  `ReapStrayOpencode→ReapStrayHarnesses`、`KillAllOpencode→KillAllHarnesses`;
  新增 `harnessCmds` 变量 + `SetHarnessCommands`;`KillAllHarnesses` 改按 tracked pgid `kill -PGID`;
  顶部注释/var 注释/日志文案去 opencode 化。
- `internal/harness/harness.go`:新增 `Commands() []string`(返回所有受支持 harness 命令)。
- `internal/chat/chat.go`:`SetPgidFile` 文件名 `opencode-pgids.json→harness-pgids.json`;
  新增 `acp.SetHarnessCommands(harness.Commands())`;`KillAllOpencode()→KillAllHarnesses()`;
  `reapIfIdle` 内 `ReapStrayOpencode()→ReapStrayHarnesses()` + 注释。
- `internal/acp/proc_pgidfile_test.go`:注释更新 + 新增 `TestIsHarnessCmdline`(回归:omp 的
  `bun …/omp acp` 命令行被识别;含 5 例含负例)+ `TestListHarnessProcsEmptyConfig`(空配置安全降级)。
- `AGENTS.md` §5.4 新增 #9「进程回收必须 harness 无关」。
- 本 worklog。

> 旧文件名 `opencode-pgids.json`:旧文件会在下次启动后自然被 `harness-pgids.json` 取代;
> 用户可手动删 `~/Library/Application Support/monkey-deck/opencode-pgids.json`(可选)。

## 验证

- `go build ./internal/... .` ✅;`go vet ./internal/acp/ ./internal/harness/ ./internal/chat/` ✅。
- `go test -race ./internal/...` ✅(9 packages ok,1 no tests)。
- 新增 2 例全绿(含 `-race`):`TestIsHarnessCmdline`(omp/opencode 命令行均识别、无关进程不命中)、
  `TestListHarnessProcsEmptyConfig`(空配置→nil,不杀)。
- 未做实机验证:需 `wails3 dev` 跑一轮 omp session,崩溃/热重载后查日志落
  `startup: killed leftover harness processes (this app only)` 且 omp 孤儿被杀(此前只会杀 opencode)。

## 下一步 / 关联

- **原「对话停了」的真因仍在**:热重载杀掉跑 `Prompt()` 的 Go 进程 → turn 死,与本次回收逻辑无关。
  两个真问题(本次未做):① 长 turn 无中间持久化(seq 498-502 同毫秒批量落盘,harness 一死丢在途 tool);
  ② 被打断的 turn resume 后不自动续跑。建议先做 ①。
- 若要彻底根治「热重载误杀在跑 turn」,需保证 `ServiceShutdown` 在 dev 热重载也跑(优雅关 session → 清 pgid),
  使 `KillAllHarnesses` 退化为纯崩溃兜底(平时 no-op)。本次未动 `ServiceShutdown`。

## 关联清理:移除死字段 `config.Config.HarnessCmd`

排查中确认 `config.Config.HarnessCmd string` 是**死字段**:spawn 早已改走
`harness.Command(se.Harness)`(chat.go:819),不读 `cfg.HarnessCmd`;全仓唯一读者是
`GetConfig()`(chat.go:1460)而该方法**无任何调用者**(前端不读 `harnessCmd` key)。
PROCESS.md:131 当年写的「退化为 fallback」从未接线。一并清掉:

- `internal/config/config.go`:删 `HarnessCmd` 字段 + `Default()` 里的赋值。
- `internal/chat/chat.go`:`GetConfig` 删 `harnessCmd` key(保留 defaultModel/dataDir)+ 注释。
- `internal/chat/{idle_reaper,integration,queue,scm,study}_test.go`:删 5 处 `HarnessCmd: "opencode acp"` 填值。
- 注:`acp.Runner.HarnessCmd []string`(runner.go:45,spawn 时 `exec.Command` 用)**是活的,保留**,与本次删除的同名字段无关。

验证:`gofmt -w` + `go build ./internal/... .` ✅;`go vet ./internal/config/ ./internal/chat/` ✅;`go test -race ./internal/...` ✅(9 packages)。`git grep HarnessCmd` 仅剩 `Runner.HarnessCmd`(活)与 `isHarnessCmdline`/`harnessCmds`(本次新增)。
