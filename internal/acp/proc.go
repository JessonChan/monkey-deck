// Package acp 封装 coder/acp-go-sdk,实现桌面客户端侧的 ACP 客户端。
//
// 设计服从 AGENTS.md §1.2/§1.3:我们是 ACP client(调 NewClientSideConnection),
// harness(opencode acp)是 peer。Handler 实现 acp.Client 回调接口,
// Runner/ChatSession 管理 harness 子进程 + ACP 连接的完整生命周期。
//
// 生命周期(照搬 references/real-agent-kanban/internal/acp/runner.go):
//
//	spawn harness(独立进程组 Setpgid)→ NewClientSideConnection(handler, stdin, stdout)
//	→ Initialize → NewSession(cwd=项目目录) → Prompt(同步返回,期间 SessionUpdate 并发流入)
//	→ 判定 StopReasonEndTurn → kill 进程组 + 注销活跃 + reap 逃逸子进程
package acp

// proc.go:harness 子进程的进程组管理 + 生命周期单主(reap/exit 根因日志)。
// 治本 harness 子进程泄漏(AGENTS.md §3.2 / §5.4 #4)+ 断连根因日志(§3.3)。
// 与具体 harness 无关:omp/opencode/... 都走同一套(以 pgidFile 登记的 pgid 为准)。
//
// 三层职责:
//  1. 进程组:Setpgid 建独立进程组 + kill -PGID 整组回收(覆盖留在组内的子孙)。
//     signalGroupDead 只发信号 + 等死;reap(Wait)由 harnessProcess 的 watcher 独占(单一 Wait,
//     杜绝双 Wait 竞态)。
//  2. 精确 reap:harness 内部 fork 的子进程会自己 setpgid 逃逸(脱离父组)+ reparent。
//     reapStrayHarnesses 在安全时机调用(harness 已 unregister 之后),杀掉这些逃逸进程。
//     ⚠️ 不做周期性 reap:运行中时逃逸 worker 与孤儿无法区分,周期 reap 会误杀活跃 worker(§5.4 #5)。
//  3. 结构化 exit 根因日志:harnessProcess.watch 在进程退出时记录退出码/信号 + stderr 尾部,
//     区分 expected(我们关停)/ unexpected(崩溃 / OOM / 空闲自杀)—— 定位「peer disconnected」真因。

import (
	"encoding/json"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// setProcGroup 给 cmd 配置独立进程组(Setpgid=true),必须在 cmd.Start() 前调。
// 这样该 harness 及其留在组内的子孙进程都属于同一进程组,结束 kill -PGID 整组回收。
func setProcGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// signalGroupDead 向进程组发 SIGTERM,3s 后仍存活则 SIGKILL,直到整组死。
// 只负责「发信号 + 等死」,不做 Wait/reap —— harness 的 reap 由 harnessProcess 的
// watcher 统一负责(单一 Wait,杜绝双 Wait 竞态,见 harnessProcess.watch)。幂等(组已死则 no-op)。
func signalGroupDead(pgid int) {
	termGroup(pgid)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if !groupAlive(pgid) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	if groupAlive(pgid) {
		killGroup(pgid)
	}
}

func termGroup(pgid int) {
	if err := syscall.Kill(-pgid, syscall.SIGTERM); err != nil && !isNoProcess(err) {
		slog.Warn("kill harness group SIGTERM", "pgid", pgid, "err", err)
	}
}

func killGroup(pgid int) {
	if err := syscall.Kill(-pgid, syscall.SIGKILL); err != nil && !isNoProcess(err) {
		slog.Warn("kill harness group SIGKILL", "pgid", pgid, "err", err)
	}
}

func groupAlive(pgid int) bool {
	return syscall.Kill(-pgid, 0) == nil
}

func isNoProcess(err error) bool {
	return err == syscall.ESRCH
}

// ─── harnessProcess:进程生命周期单主 + 结构化 exit 根因日志 ───────────────────

// harnessProcess 封装一个 harness 子进程,统一拥有 cmd.Wait()(单一 reap,杜绝双 Wait 竞态),
// 并在进程退出时产出「结构化 exit + stderr 尾部」根因日志 —— 定位 §3.3 崩溃检测的真因。
//
// 为什么需要单主 Wait:旧 killProcessGroup 自己 Wait 收尸;若另起 goroutine 观测 exit,
// 两个 goroutine 调 cmd.Wait() 会竞态(exec.Cmd.Wait 非并发安全,会释放/复写 cmd 内部状态)。
// 改成 watcher 独占 Wait,signalGroupDead 只发信号不 reap,Close 经 shutdown 等待 watcher 落定。
//
// 退出分类(根因日志的关键):
//   - expected:我们主动 shutdown(Close/teardown)→ 信号终止是预期,Info 级,不打扰。
//   - unexpected:进程自行退出 —— 崩溃 / OOM(SIGKILL)/ panic(exit 2)/ harness 空闲自杀
//     (exit 0)等。Warn/Error 级,并附 stderr ring 尾部:harness 自身日志常含崩溃栈/根因,
//     这是「peer disconnected」之外唯一能回答「为什么断」的素材。
type harnessProcess struct {
	cmd    *exec.Cmd
	pgid   int        // Setpgid 后 == 主 PID,回收/日志用
	cmdStr string     // 启动命令,日志可读性用
	stderr *stderrRing // harness stderr 捕获(根因日志的素材)

	shutdownStarted atomic.Bool       // true = 我们已主动开始关停(expected)
	alive           atomic.Bool       // true = 进程尚未退出;watcher 在 Wait 返回后置 false
	done            chan struct{}     // Wait 返回后关闭(shutdown 等它落定,确保 reap 完成)
	state           atomic.Pointer[os.ProcessState] // Wait 后的退出状态(退出码/信号来源)
}

// newHarnessProcess 包装一个已 Start 的 cmd,起 watcher goroutine 独占 Wait。
// 调用方在进程不再需要时调 shutdown(主动关停)—— 不可再对 cmd 调 Wait。
func newHarnessProcess(cmd *exec.Cmd, cmdStr string, stderr *stderrRing) *harnessProcess {
	hp := &harnessProcess{
		cmd:    cmd,
		pgid:   cmd.Process.Pid,
		cmdStr: cmdStr,
		stderr: stderr,
		done:   make(chan struct{}),
	}
	hp.alive.Store(true)
	go hp.watch()
	return hp
}

// watch 独占 cmd.Wait:进程退出时记录退出状态并产出结构化 exit 根因日志。
// 只跑一次(由 newHarnessProcess 起一个 goroutine)。close(done) 通知 shutdown reap 已落定。
func (h *harnessProcess) watch() {
	err := h.cmd.Wait()
	h.alive.Store(false)
	if ps := h.cmd.ProcessState; ps != nil {
		h.state.Store(ps)
	}
	h.logExit(err)
	close(h.done)
}

// shutdown 主动关停:标记 expected → signalGroupDead(发信号 + 等死)→ 等 watcher reap 落定。
// 幂等:done 已关闭则立即返回。
func (h *harnessProcess) shutdown() {
	h.shutdownStarted.Store(true)
	signalGroupDead(h.pgid)
	<-h.done
}

// IsAlive 报告 harness 进程是否仍存活。alive flag 是快路径(watcher 确认死后永返 false,
// 省一次 signal syscall);flag 仍真时再用 signal 0 探活拿到实时结果。
func (h *harnessProcess) IsAlive() bool {
	if !h.alive.Load() {
		return false
	}
	p := h.cmd.Process
	if p == nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}

// exitCodeSignal 从 ProcessState 解出退出码与(若被信号杀)信号名。
// Go 的 ExitCode:正常退出=退出码;被信号终止=-1(信号名走 WaitStatus 另取)。
func exitCodeSignal(ps *os.ProcessState) (int, string) {
	if ps == nil {
		return -1, ""
	}
	code := ps.ExitCode()
	sig := ""
	if ws, ok := ps.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		sig = ws.Signal().String()
	}
	return code, sig
}

// logExit 产出结构化 exit 根因日志。unexpected 退出时附 stderr 尾部 —— harness 自身日志
// 常含崩溃栈/根因,是定位「peer disconnected」真因的关键素材(§3.3 / §5.4 #2)。
func (h *harnessProcess) logExit(waitErr error) {
	expected := h.shutdownStarted.Load()
	ps := h.state.Load()
	exitCode, signal := exitCodeSignal(ps)
	kind := exitKind(expected, exitCode, signal != "")

	fields := []any{
		"pid", h.pgid,
		"pgid", h.pgid,
		"cmd", h.cmdStr,
		"expected", expected,
		"exitCode", exitCode,
		"signal", signal,
		"kind", kind,
		"alive", "no",
	}
	if waitErr != nil {
		fields = append(fields, "waitErr", waitErr.Error())
	}
	switch kind {
	case "expected":
		slog.Info("harness exited (expected)", fields...)
	case "crash":
		// 崩溃/OOM/panic:附 stderr 尾部定位根因。
		if h.stderr != nil {
			fields = append(fields, "stderrTail", h.stderr.Tail(stderrTailForLog))
		}
		slog.Error("harness exited unexpectedly (crash)", fields...)
	default: // "unexpected-clean":干净 exit 0 但非我们发起 —— 典型 harness 空闲自杀。
		if h.stderr != nil {
			fields = append(fields, "stderrTail", h.stderr.Tail(stderrTailForLog))
		}
		slog.Warn("harness exited unexpectedly (clean exit 0)", fields...)
	}
}

// exitKind 把退出分类成日志级别用的人类可读类别(纯函数,便于单测覆盖分支):
//   - "expected":我们主动关停(shutdownStarted=true)—— 信号终止是预期,Info。
//   - "crash":非零退出码或被信号杀 —— 崩溃 / OOM(SIGKILL)/ panic(exit 2)。Error + stderr 尾部。
//   - "unexpected-clean":干净 exit 0 但非我们发起 —— 典型 harness 空闲自杀(opencode idle)。Warn。
func exitKind(expected bool, exitCode int, signaled bool) string {
	if expected {
		return "expected"
	}
	if exitCode != 0 || signaled {
		return "crash"
	}
	return "unexpected-clean"
}

// ─── 活跃 harness 注册表 + 精确 reap(治本第二层防线)─────────────────────────

var (
	activeMu        sync.RWMutex
	activeHarnesses = map[int]struct{}{} // pgid 集合;当前活跃的 harness 进程组(Setpgid 后 pgid==主 PID)

	// pgidFile:持久化记录「本应用 spawn 过的 harness pgid」,跨进程存活。
	// 启动时 KillAllHarnesses 只杀 pgid 在此文件中的残留进程 —— 避免误杀用户在其它终端
	// 跑的 harness(§3.2 回收范围只限本应用)。空字符串 = 不启用(单测/未配置)。
	pgidFile string

	// harnessCmds:受支持 harness 的 ACP 启动命令子串(如 "omp acp"/"opencode acp"),
	// SetHarnessCommands 注入。listHarnessProcs 据此识别「我们的 harness」——与具体 harness 无关。
	// 空 = 不识别任何进程 → KillAllHarnesses/reapStrayHarnesses 不杀(安全:宁可漏杀不误杀)。
	harnessCmds []string
)

// SetPgidFile 配置 pgid 持久化文件路径(应用启动时调一次,传 dataDir 下的文件)。
func SetPgidFile(path string) { pgidFile = path }

// SetHarnessCommands 配置受支持 harness 的 ACP 启动命令(应用启动时调一次,传 harness.Supported
// 的 Command 列表)。进程回收据此识别本应用派生的 harness(omp/opencode/...),不再写死 opencode。
func SetHarnessCommands(cmds []string) { harnessCmds = cmds }

// readPgidFile 读回 pgid 集合;文件不存在/损坏返回空集(容错:宁可漏杀不误杀)。
func readPgidFile() map[int]struct{} {
	set := map[int]struct{}{}
	if pgidFile == "" {
		return set
	}
	b, err := os.ReadFile(pgidFile)
	if err != nil {
		return set // 不存在视为空
	}
	var pgids []int
	if err := json.Unmarshal(b, &pgids); err != nil {
		return set // 损坏视为空(容错)
	}
	for _, p := range pgids {
		set[p] = struct{}{}
	}
	return set
}

// writePgidFile 落盘当前 active 集合(best-effort:写失败只告警,不影响运行)。
func writePgidFile() {
	if pgidFile == "" {
		return
	}
	activeMu.RLock()
	pgids := make([]int, 0, len(activeHarnesses))
	for p := range activeHarnesses {
		pgids = append(pgids, p)
	}
	activeMu.RUnlock()
	b, err := json.Marshal(pgids)
	if err != nil {
		return
	}
	if err := os.WriteFile(pgidFile, b, 0o644); err != nil {
		slog.Warn("write pgid file", "err", err)
	}
}

func registerHarness(pgid int) {
	activeMu.Lock()
	activeHarnesses[pgid] = struct{}{}
	activeMu.Unlock()
	writePgidFile()
}

func unregisterHarness(pgid int) {
	activeMu.Lock()
	delete(activeHarnesses, pgid)
	activeMu.Unlock()
	writePgidFile()
}

func isActiveHarness(pgid int) bool {
	activeMu.RLock()
	_, ok := activeHarnesses[pgid]
	activeMu.RUnlock()
	return ok
}

type harnessProc struct {
	pid, pgid int
}

// isHarnessCmdline 报告 ps 命令行是否命中任一受支持 harness 命令子串(omp/opencode/...)。
// omp 实际以 `bun …/omp acp` 启动,"omp acp" 仍是其子串,故子串匹配覆盖裸命令与 wrapper 两种形态。
func isHarnessCmdline(line string, cmds []string) bool {
	for _, c := range cmds {
		if c != "" && strings.Contains(line, c) {
			return true
		}
	}
	return false
}

// listHarnessProcs 一次 ps 列出所有「受支持 harness」进程的 pid + pgid(omp/opencode/...)。
// 匹配规则见 isHarnessCmdline。未配置 harnessCmds(SetHarnessCommands 未调)时返回 nil(安全)。
func listHarnessProcs() []harnessProc {
	if len(harnessCmds) == 0 {
		return nil
	}
	out, err := exec.Command("ps", "-eo", "pid=,pgid=,command=").Output()
	if err != nil {
		return nil
	}
	var procs []harnessProc
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !isHarnessCmdline(line, harnessCmds) {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		pid, err1 := strconv.Atoi(fields[0])
		pgid, err2 := strconv.Atoi(fields[1])
		if err1 != nil || err2 != nil || pid <= 0 {
			continue
		}
		procs = append(procs, harnessProc{pid: pid, pgid: pgid})
	}
	return procs
}

// reapStrayHarnesses 杀掉所有 pgid 不属于活跃 harness 的 harness 进程(脱组逃逸的 harness)。
// ⚠️ 只能在安全时机调(harness 已 unregister 之后)。返回杀掉的进程数。
// 注意:按「非活跃 harness 命令行」判定,理论上会命中其它应用(如 RAK)派生的同命令 harness——
// 这是既有行为;限定本应用 pgid 的主孤儿回收在 KillAllHarnesses(启动时)。
func reapStrayHarnesses() int {
	killed := 0
	for _, p := range listHarnessProcs() {
		if isActiveHarness(p.pgid) {
			continue
		}
		if err := syscall.Kill(p.pid, syscall.SIGKILL); err != nil && !isNoProcess(err) {
			slog.Warn("reap kill stray harness", "pid", p.pid, "pgid", p.pgid, "err", err)
			continue
		}
		killed++
	}
	if killed > 0 {
		slog.Info("reaper: killed stray harness processes", "count", killed)
	}
	return killed
}

// ActiveHarnessCount 返回当前活跃 harness 数(供调用方判断是否安全 reap)。
func ActiveHarnessCount() int {
	activeMu.RLock()
	defer activeMu.RUnlock()
	return len(activeHarnesses)
}

// ReapStrayHarnesses 导出版(杀掉所有非活跃 harness)。多 session 时只能在 ActiveHarnessCount()==0 调。
func ReapStrayHarnesses() int { return reapStrayHarnesses() }

// KillAllHarnesses 杀掉「本应用上轮残留」的 harness 进程组(应用启动时调)。
// 与具体 harness 无关:以 pgidFile 登记的 pgid 为唯一真相(omp/opencode/... spawn 时都登记了),
// 对每个 tracked pgid 整组 kill -PGID 回收(§3.2)。仅当该 pgid 当前进程仍是受支持 harness
// 时才杀(isHarnessCmdline 安全过滤,防 pgid 被 OS 复用后误杀无关进程)。杀完清空 pgidFile(本轮重新登记)。
func KillAllHarnesses() int {
	tracked := readPgidFile()
	if len(tracked) == 0 {
		// 未配置 pgidFile 或上轮干净退出:不杀任何进程(保守,宁可漏杀不误杀)。
		return 0
	}
	// 当前存活且形似受支持 harness 的 pgid 集合(安全过滤)。
	alive := map[int]struct{}{}
	for _, p := range listHarnessProcs() {
		alive[p.pgid] = struct{}{}
	}
	killed := 0
	for pgid := range tracked {
		if _, ok := alive[pgid]; !ok {
			continue // 该 pgid 当前不是 harness 进程(已死 / 被复用为非 harness):跳过
		}
		killGroup(pgid) // 整组 SIGKILL(harness 主进程 + 留在组内的子孙,§3.2)
		killed++
	}
	if killed > 0 {
		slog.Info("startup: killed leftover harness processes (this app only)", "count", killed)
	}
	// 清空登记文件:本轮 registerHarness 会重新写入。best-effort。
	if pgidFile != "" {
		_ = os.WriteFile(pgidFile, []byte("[]"), 0o644)
	}
	return killed
}
