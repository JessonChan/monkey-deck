# 2026-07-22 Review #21315 harness 断连根因日志端到端验收结论(PASS)

## 起因

Task #21315(Review):验收 Task #21309「harness 断连根因日志(stderr ring buffer +
结构化 exit/存活/断连类型)」的 commit `76da24a`(feat)+ `8903300`(docs)。

重点不是「能否编译」,而是「代码是否真的让 harness 崩溃后能在日志里看到根因」——
拒收「加了 stderrRing 类型 / 改了 ChatSession 字段但 cmd.Stderr 仍直通 os.Stderr、
或 logExit 根本不读 ring」的空壳改动,以及「测试存在却不覆盖 stderr 实际捕获」的纸面绿。

## 改动核对(commit `76da24a`,5 文件)

- `internal/acp/stderr.go`(新,125 行):`stderrRing` 定容环形缓冲,实现 `io.Writer`;
  Write 在溢出时丢最老、单写超容只留尾部;Snapshot/Tail 跨 goroutine 加锁;tee 到 os.Stderr。
- `internal/acp/proc.go`(+166/-):
  - `killProcessGroup(cmd)` 拆为 `signalGroupDead(pgid)`:**只发信号 + 等死,不再 Wait**(删了
    `cmd.Process.Wait()` 那行)。
  - 新 `harnessProcess`:watcher goroutine 独占 `cmd.Wait()` → 存 state → `logExit` → close(done)。
  - `shutdown()`(标记 expected → signalGroupDead → 等 done 落定)、`IsAlive()`(alive flag 快路径
    + signal 0 兜底)、`exitCodeSignal`、`exitKind`(纯函数)。
- `internal/acp/runner.go`:`spawnAndInit` 建 `newStderrRing(os.Stderr)` 并 `cmd.Stderr = ring`
  (替换旧 `cmd.Stderr = os.Stderr`);返回值 `*exec.Cmd`→`*harnessProcess`;`ChatSession.Cmd`→`proc`+`stderr`;
  NewChatSession/LoadChatSession/spawnAndInit/RefreshConfig 失败路径全改 `proc.shutdown()`;
  `Close()`/`IsAlive()` 委托 proc(不再 import syscall)。
- `internal/acp/stderr_test.go`(新,11 例)/`proc_exit_test.go`(新,5 例)。
- `AGENTS.md` §5.4 #2 补根因日志指针(`8903300`)。

## 端到端贯通核对(不只看 diff 表面)

确认「harness stderr → ring → 结构化 exit 日志 stderrTail」真的贯通,无旁路把 stderr 直通漏掉:

1. **stderr 真的被捕获进 ring,而非直通滚走**:`spawnAndInit` 唯一生产 spawn 点
   `cmd.Stderr = stderr`(ring),旧 `cmd.Stderr = os.Stderr` 仅剩 stderr.go 注释引用。
   grep 全 `internal/acp` 确认无生产路径残留直通。✓
2. **logExit 真的读 ring 尾部**:`logExit`(proc.go:177-211)在 crash / unexpected-clean 分支
   调 `h.stderr.Tail(stderrTailForLog)` 并 append 到 slog fields —— 非「加了字段不读」。✓
3. **单主 Wait 真的不被第二处破坏**:grep 确认 `cmd.Wait()` / `Process.Wait()` 全仓仅
   `harnessProcess.watch()` 一处调用;`signalGroupDead` 已删 Wait;line 92-93 注释解释了为什么。
   双 Wait 竞态的根(§5.3 找不变量:Wait 所有权)被真正消除。✓
4. **所有错误路径都回收**:`spawnAndInit`/NewChatSession/LoadChatSession/RefreshConfig 的
   4 处失败分支全改 `proc.shutdown()`(标记 expected + 等 reap 落定),无残留 `killProcessGroup`。✓

**结论:bug 确实被修复**——崩溃真因现在落进 stderr ring,exit 时拼进结构化日志的
`stderrTail` 字段;不再只剩一句 `peer disconnected`。非空壳改动,行为真实变更。

## 验证

- `go build ./internal/...`:通过。✓
- `go vet ./internal/acp/`:通过。✓
- `go test -race ./internal/acp/`:ok(3.157s)。新用例全绿,`-race` 干净。✓
- 结构化日志实测(跑 `go test -race -run 'TestHarnessProcess...' -v`,逐条核对字段,
  与被验收方 worklog §验证 声称逐字一致):
  - 主动关停:`INFO harness exited (expected) ... exitCode=-1 signal=terminated kind=expected`。✓
  - 空闲自杀:`WARN harness exited unexpectedly (clean exit 0) ... kind=unexpected-clean`。✓
  - 崩溃 + stderr:`ERROR harness exited unexpectedly (crash) ... exitCode=3 kind=crash
    stderrTail="boom-before-crash\n"` —— **真实 stderr 内容经 ring 流进日志字段,根因可见**。✓
  - OOM/外部信号杀:`ERROR harness exited unexpectedly (crash) ... signal=killed kind=crash`。✓

无 acceptance_cmd 下发,以上为标准验收命令(build/vet/-race test)+ 日志字段逐条核对。

## 测试是否真覆盖新行为(防「测试存在却无价值」)

stderr ring(11 例):容量内/精确填满/超容留尾/多次环绕/环绕顺序/Tail 长度边界/
tee 全量镜像/空写/Write 返回 origLen/跨末尾大块/默认 32KiB —— 覆盖 ring 所有边界。✓

harnessProcess(5 例):`exitKind` 三分支表驱动 + nil ProcessState 兜底 +
`TestHarnessProcessExpectedShutdown`(主动关停=expected + IsAlive 翻转 + done 关闭)+
`TestHarnessProcessUnexpectedCleanExit`(exit 0=unexpected-clean)+
`TestHarnessProcessCrashWithStderr`(exit 3=crash **且 `stderr.Snapshot()` 断言含
"boom-before-crash"** —— 这是本次修复的核心断言:验证真实 stderr 经 ring 被捕获)+
`TestHarnessProcessSignalDeathClassifiedAsCrash`(外部 SIGKILL=crash)。

关键点:`TestHarnessProcessCrashWithStderr` **不是**「只断言 exitCode」,而是真正跑了真实
子进程(sh -c 'echo boom 1>&2; exit 3'),stderr 经 `cmd.Stderr = ring` 接到生产用 `newStderrRing`,
再断言 ring 内容含崩溃输出 —— 这条链复刻了生产捕获路径。若有人把 `cmd.Stderr` 还原回
`os.Stderr` 直通,本用例会因 ring 空而失败。**回归窗口已钉死。** ✓

测试策略说明(非阻塞):logExit 的 slog 输出本身未被捕获断言 message 字符串,但策略合理——
`exitKind` 是纯函数已单测覆盖三分支、stderr 捕获经真实 ring 已断言、logExit 只是把二者
拼进 slog fields 的 trivial glue;且 `-v` 测试输出里可见消息逐字正确。

## 规约合规

- §3.3 崩溃检测:不设静默超时,根因日志是排障兜底,与「无静默超时」并行不悖。✓
- §3.2 进程组回收:signalGroupDead 仍以 pgid 为准(无 harness 命令字符串 grep 硬编码);
  reap 仍只在 harness unregister 后做(无周期 reap)。重构未破坏回收语义。✓
- §5.3「找不变量,不堆 if」:用「Wait 所有权唯一」不变量重构(单一 watcher reap),
  而非「谁先调 Wait」启发式;stderr 分类用纯函数 `exitKind` 可单测。✓ 设计对路。
- §5.1:单测用 sleep/sh 通用子进程,未启真 harness(opencode)。✓
- §0.3 / §6.2:被验收方 worklog 已写(`2026-07-22-harness-disconnect-root-cause-log.md`)、
  原子提交(feat 一个 commit + docs 一个 commit 分离)、message 说清改了什么 + 为什么、
  diff 不夹带无关文件。✓

## 诚实标注(非阻塞,被验收方已自文档化)

被验收方 worklog「下一步」已诚实记录:
- 未做 `wails3 dev` 实机验证(需人为 kill harness 触发崩溃查日志)。机制已单测 + 日志字段
  逐条核对覆盖,实机验证为锦上添花,不阻塞合入。
- chat.go disconnect 日志与 watcher exit 日志未做 sessionID 串联(harnessProcess 创建时
  sessionID 尚未赋值);如排障需更强关联可后补 `SetLabel`。本次 KISS 不做,合理。

## 结论

**PASS**。实现正确、bug 确被修复、stderr→ring→日志字段 端到端贯通已核实、单主 Wait
竞态根因真正消除、测试覆盖核心捕获路径且 `-race` 干净、build/vet 通过、规约合规、
commit 原子无夹带。可合入。

## 改了哪些文件

- `docs/worklog/2026-07-22-review-harness-disconnect-root-cause-log.md`(本文件)。
