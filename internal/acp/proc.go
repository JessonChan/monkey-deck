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

// proc.go:harness 子进程的进程组管理 —— 治本 opencode 子进程泄漏(AGENTS.md §3.2 / §5.4 #4)。
//
// 两层防线:
//  1. 进程组:Setpgid 建独立进程组 + kill -PGID 整组回收(覆盖留在组内的子孙)。
//  2. 精确 reap:opencode 内部 fork 的子进程会自己 setpgid 逃逸(脱离父组)+ reparent。
//     reapStrayOpencode 在安全时机调用(harness 已 unregister 之后),杀掉这些逃逸进程。
//     ⚠️ 不做周期性 reap:运行中时逃逸 worker 与孤儿无法区分,周期 reap 会误杀活跃 worker(§5.4 #5)。

import (
	"log/slog"
	"os/exec"
	"strconv"
	"strings"
	"sync"
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

// killProcessGroup 杀掉 cmd 所属的整个进程组(harness 主进程 + 留在组内的子孙)。
// 先 SIGTERM 优雅退出,3s 后仍存活则 SIGKILL 强杀,最后 Wait 收尸。幂等。
func killProcessGroup(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	pgid := cmd.Process.Pid // Setpgid 后主 PID 即 pgid

	termGroup(pgid)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if !groupAlive(pgid) {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if groupAlive(pgid) {
		killGroup(pgid)
	}
	_, _ = cmd.Process.Wait() // 收尸主进程,避免僵尸
	slog.Debug("killed harness process group", "pgid", pgid)
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

// ─── 活跃 harness 注册表 + 精确 reap(治本第二层防线)─────────────────────────

var (
	activeMu        sync.RWMutex
	activeHarnesses = map[int]struct{}{} // pgid 集合;当前活跃的 harness 进程组(Setpgid 后 pgid==主 PID)
)

func registerHarness(pgid int) {
	activeMu.Lock()
	activeHarnesses[pgid] = struct{}{}
	activeMu.Unlock()
}

func unregisterHarness(pgid int) {
	activeMu.Lock()
	delete(activeHarnesses, pgid)
	activeMu.Unlock()
}

func isActiveHarness(pgid int) bool {
	activeMu.RLock()
	_, ok := activeHarnesses[pgid]
	activeMu.RUnlock()
	return ok
}

type opencodeProc struct {
	pid, pgid int
}

// listOpencodeProcs 一次 ps 列出所有 "opencode acp" 进程的 pid + pgid。
func listOpencodeProcs() []opencodeProc {
	out, err := exec.Command("ps", "-eo", "pid=,pgid=,command=").Output()
	if err != nil {
		return nil
	}
	var procs []opencodeProc
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.Contains(line, "opencode acp") {
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
		procs = append(procs, opencodeProc{pid: pid, pgid: pgid})
	}
	return procs
}

// reapStrayOpencode 杀掉所有 pgid 不属于活跃 harness 的 opencode 进程。
// ⚠️ 只能在安全时机调(harness 已 unregister 之后)。返回杀掉的进程数。
func reapStrayOpencode() int {
	killed := 0
	for _, p := range listOpencodeProcs() {
		if isActiveHarness(p.pgid) {
			continue
		}
		if err := syscall.Kill(p.pid, syscall.SIGKILL); err != nil && !isNoProcess(err) {
			slog.Warn("reap kill stray opencode", "pid", p.pid, "pgid", p.pgid, "err", err)
			continue
		}
		killed++
	}
	if killed > 0 {
		slog.Info("reaper: killed stray opencode processes", "count", killed)
	}
	return killed
}

// ActiveHarnessCount 返回当前活跃 harness 数(供调用方判断是否安全 reap)。
func ActiveHarnessCount() int {
	activeMu.RLock()
	defer activeMu.RUnlock()
	return len(activeHarnesses)
}

// ReapStrayOpencode 导出版(杀掉所有非活跃 opencode)。多 session 时只能在 ActiveHarnessCount()==0 调。
func ReapStrayOpencode() int { return reapStrayOpencode() }

// KillAllOpencode 杀掉所有 opencode acp 进程(应用启动时调,清上轮残留)。
func KillAllOpencode() int {
	killed := 0
	for _, p := range listOpencodeProcs() {
		if err := syscall.Kill(p.pid, syscall.SIGKILL); err != nil && !isNoProcess(err) {
			slog.Warn("startup kill opencode", "pid", p.pid, "err", err)
			continue
		}
		killed++
	}
	if killed > 0 {
		slog.Info("startup: killed leftover opencode processes", "count", killed)
	}
	return killed
}
