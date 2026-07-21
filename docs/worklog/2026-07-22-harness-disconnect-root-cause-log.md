# 2026-07-22 harness 断连根因日志(stderr ring buffer + 结构化 exit/存活/断连类型)

## 起因

Task #21309。harness 崩溃(opencode/omp 进程死)时,ACP 连接断 → 用户侧只看到一句
`prompt failed ... reason=peer-disconnected`(§3.3),但**真正的死因**(panic 栈 / OOM /
空闲自杀)印在 harness 自己的 stderr 里,随终端滚走,排障无门。

旧实现 `cmd.Stderr = os.Stderr`(runner.go)把 stderr 直通应用 stderr,既不捕获也不结构化,
`peer disconnected` 之外没有任何「为什么断」的素材。需要一个**根因日志**机制。

## 根因(设计)

1. **stderr 不应直通**:要在内存里留「尾部」(根因总在最后),崩溃时拼进日志。
   但不能无限堆积(harness DEBUG 日志很冗长、桌面长驻)→ 用**定容环形缓冲**(32KiB 尾部),
   同时 tee 到 os.Stderr 保留 dev 模式「实时看 harness 日志」的既有行为(零行为变更)。
2. **exit 要结构化 + 分类**:进程退出时记录 pid/pgid/退出码/信号,并区分:
   - `expected`:我们主动关停(Close/teardown)→ Info,不打扰。
   - `crash`:非零退出码或被信号杀(含 OOM SIGKILL / panic exit 2 / 外部 kill)→ Error + stderr 尾部。
   - `unexpected-clean`:干净 exit 0 但非我们发起(典型 opencode 空闲自杀,§5.4 #9)→ Warn + stderr 尾部。
3. **单主 Wait(硬约束)**:`exec.Cmd.Wait()` 非并发安全,只能一个 goroutine 调。旧 `killProcessGroup`
   自己 `cmd.Process.Wait()` 收尸;若另起 watcher 观测 exit,两者竞态。故重构为:**watcher 独占 Wait**,
   `signalGroupDead` 只发信号 + 等死(不 reap),`Close` 经 `shutdown()` 等 watcher 落定。

## 改法

### `internal/acp/stderr.go`(新)
`stderrRing`:定容环形字节缓冲,实现 `io.Writer`。
- `start`/`size` 跟踪最老字节与已存量;`Write` 在 `(start+size)%cap` 处写入、环绕、溢出时推进 start 丢最老;
  单次写超容只留尾部。
- `Snapshot()` 全量(最老→最新)、`Tail(n)` 最近 n 字节、`Write` 同时镜像 `tee`(os.Stderr)。
- 常量:`stderrRingCap=32KiB`、`stderrTailForLog=4KiB`(根因日志拼入长度)。

### `internal/acp/proc.go`
- 拆 `killProcessGroup` → `signalGroupDead(pgid)`:只发 SIGTERM→3s→SIGKILL + 等死,**不 Wait**
  (reap 交给 watcher)。原 `termGroup/killGroup/groupAlive/isNoProcess` 保留,供 signalGroupDead 与
  KillAllHarnesses 复用。
- 新 `harnessProcess`:封装 cmd,`newHarnessProcess` 起 watcher goroutine 独占 `cmd.Wait()` → 记 exitState
  (atomic) → `logExit` 产结构化根因日志 → `close(done)`。
  - `shutdown()`:标 `shutdownStarted=true` → `signalGroupDead` → `<-done`(确保 reap 落定)。幂等。
  - `IsAlive()`:alive flag 快路径(watcher 确认死后永 false)+ signal 0 实时探活。
  - `exitKind`(纯函数)+ `exitCodeSignal`(`os.ProcessState` → 退出码/信号名):抽出便于单测。
  - 顶部注释补「三层职责」(进程组 / 精确 reap / 结构化 exit 根因日志)。

### `internal/acp/runner.go`
- `spawnAndInit`:建 `stderrRing(os.Stderr)` → `cmd.Stderr = ring` → `newHarnessProcess(cmd, ..., ring)`;
  返回值由 `*exec.Cmd` 改为 `*harnessProcess`;错误路径改 `proc.shutdown()`。
- `ChatSession`:`Cmd *exec.Cmd` → `proc *harnessProcess` + `stderr *stderrRing`。
- `NewChatSession`/`LoadChatSession`:接 proc;`NewSession`/`ResumeSession` 失败改 `proc.shutdown()`;
  `registerHarness(proc.pgid)`(Setpgid 后 pgid==主 PID,与旧 `cmd.Process.Pid` 等价)。
- `RefreshConfig`:`defer proc.shutdown()`(原 `defer killProcessGroup(cmd)`)。
- `Close()`:`proc.shutdown()`(标记 expected);`IsAlive()` 委托 `proc.IsAlive()`(runner.go 不再 import syscall)。

### `internal/acp/stderr_test.go`/`proc_exit_test.go`(新)
- ring:容量内/精确填满/超容留尾/多次环绕/跨末尾大块/顺序/Tail 长度/tee 全量/空写/返回 origLen/默认 32KiB。
- harnessProcess:`exitKind` 三分支表驱动、nil ProcessState 兜底、expected(主动 shutdown 信号死)、
  unexpected-clean(exit 0)、crash(非零退出 + stderr 捕获「boom」)、外部信号死(OOM 模拟)= crash。
  测试用 sleep/sh 通用子进程(非真 harness,§5.1),`startDummy` 复刻生产 `setProcGroup`(否则组信号无效)。

### `AGENTS.md` §5.4 #2
补「根因日志」指针:崩溃真因在 harness stderr,由 `harnessProcess` 统一捕获 + 结构化 exit 日志;
排障搜 `harness exited unexpectedly`。

## 验证

- `go build ./internal/...` ✅;`go vet ./internal/acp/` ✅。
- `go test -race ./internal/acp/` ✅(含 16 个新用例,stderr ring 11 + harnessProcess 5)。
- 结构化日志实测(符合预期):
  - 主动关停:`INFO harness exited (expected) ... exitCode=-1 signal=terminated kind=expected`
  - 空闲自杀:`WARN harness exited unexpectedly (clean exit 0) ... kind=unexpected-clean`
  - 崩溃 + stderr:`ERROR harness exited unexpectedly (crash) ... exitCode=3 kind=crash stderrTail="boom-before-crash\n"`
  - 外部/OOM 信号杀:`ERROR harness exited unexpectedly (crash) ... exitCode=-1 signal=killed kind=crash`
- 主进程 `go build .` 的 `frontend/dist` embed 报错为环境缺前端构建产物(预先存在,与本次无关)。
- `internal/chat` 的 `TestEmptyTurnDetectedAsError` 在 `-race` 下报 data race —— **经 `git stash` 验证为
  base commit 上预先存在**(测试自身回调与断言的捕获变量竞态),与本次 `internal/acp` 改动无关,不在本次范围。

## 设计要点(为什么这么选)

- **单主 Wait**:不引入第二套 reap,把「发信号」与「收尸」职责彻底分离(signalGroupDead vs watcher),
  消灭双 Wait 竞态的根(§5.3 找不变量:Wait 的所有权是唯一不变量,不是「谁先调」的启发式)。
- **watcher 自动产日志 vs 在 chat.go 调用方产**:选 watcher 自动 —— 它覆盖**所有**崩溃场景(含 idle
  空闲自杀、turn 之间的死,这些不一定有 error 即时返回),且不污染 `chatConn` 接口/不动 mock。
  chat.go 既有 `prompt failed ... reason=` 日志保留(「turn 发生了什么」),watcher 补「harness 为什么死」。
- **tee 到 os.Stderr**:零行为变更(dev 模式实时看 harness 日志的既有体验不变),ring 只做「额外捕获」。
- **分类用纯函数 `exitKind`**:日志级别选择逻辑可单测,不必捕获 slog 输出。

## 改了哪些文件

- `internal/acp/stderr.go`(新)、`internal/acp/stderr_test.go`(新)。
- `internal/acp/proc.go`(signalGroupDead + harnessProcess + exitKind/exitCodeSignal + 注释)。
- `internal/acp/runner.go`(spawnAndInit/ChatSession/NewChatSession/LoadChatSession/RefreshConfig/Close/IsAlive)。
- `internal/acp/proc_exit_test.go`(新)。
- `AGENTS.md` §5.4 #2(根因日志指针)。
- 本 worklog。

## 下一步 / 关联

- 未做实机验证:需 `wails3 dev` 跑一轮 omp session,人为 kill harness / 触发崩溃,查日志落
  `harness exited unexpectedly (crash) ... stderrTail=...` 并能据此定位真因。
- chat.go 的 disconnect 日志与 watcher 的 exit 日志目前靠时间/进程相关性关联,未做 sessionID 串联
  (harnessProcess 创建时 sessionID 尚未赋值)。若排障需要更强关联,可后续给 harnessProcess 加
  `SetLabel(sessionID)`(本次未做,KISS)。
