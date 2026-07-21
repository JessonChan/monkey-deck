package acp

// proc_exit_test.go:harnessProcess 生命周期单主 + 结构化 exit 根因日志的行为单测。
// 不启真 harness(§5.1)—— 用 sleep/sh 通用子进程验证进程包装层:expected/crash/clean
// 退出分类、stderr 捕获拼入根因、IsAlive 翻转、shutdown 幂等收尸。

import (
	"os/exec"
	"strings"
	"testing"
	"time"
)

// waitDone 等待 harnessProcess 的 watcher 落定(done 关闭 = Wait 已 reap + logExit 已跑)。
func waitDone(t *testing.T, hp *harnessProcess, timeout time.Duration) {
	t.Helper()
	select {
	case <-hp.done:
	case <-time.After(timeout):
		t.Fatalf("harnessProcess.done did not close within %v", timeout)
	}
}

// startDummy 启一个通用子进程(非 harness),stderr 接到 ring,返回已 Start 的 cmd + ring。
// 必须 setProcGroup:复刻生产路径(spawnAndInit),使子进程自成进程组,signalGroupDead 的
// kill -PGID 才能命中(否则子进程的 pgid = 测试进程组,组信号会误判/无效)。
func startDummy(t *testing.T, name string, args ...string) (*exec.Cmd, *stderrRing) {
	t.Helper()
	cmd := exec.Command(name, args...)
	setProcGroup(cmd)
	stderr := newStderrRing(nil)
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start %s %v: %v", name, args, err)
	}
	return cmd, stderr
}

// TestExitKind 覆盖退出分类纯函数的三分支(日志级别据此选择)。
func TestExitKind(t *testing.T) {
	cases := []struct {
		name      string
		expected  bool
		exitCode  int
		signaled  bool
		want      string
	}{
		{"expected clean", true, 0, false, "expected"},
		{"expected signaled", true, -1, true, "expected"},
		{"crash nonzero exit", false, 3, false, "crash"},
		{"crash signaled (OOM SIGKILL)", false, -1, true, "crash"},
		{"clean exit 0 unexpected", false, 0, false, "unexpected-clean"},
	}
	for _, c := range cases {
		if got := exitKind(c.expected, c.exitCode, c.signaled); got != c.want {
			t.Errorf("%s: exitKind(%v,%d,%v) = %q, want %q", c.name, c.expected, c.exitCode, c.signaled, got, c.want)
		}
	}
}

// TestExitCodeSignalNilState nil ProcessState 返回 (-1, "")(防御:Wait 未填状态的兜底)。
func TestExitCodeSignalNilState(t *testing.T) {
	if code, sig := exitCodeSignal(nil); code != -1 || sig != "" {
		t.Fatalf("exitCodeSignal(nil) = (%d,%q), want (-1,\"\")", code, sig)
	}
}

// TestHarnessProcessExpectedShutdown 主动 shutdown 标记 expected:进程被信号终止,分类=expected,
// IsAlive 翻为 false,done 关闭,shutdownStarted=true。验证「我们关停」不打扰(Info 路径)。
func TestHarnessProcessExpectedShutdown(t *testing.T) {
	cmd, stderr := startDummy(t, "sleep", "30")
	proc := newHarnessProcess(cmd, "sleep 30", stderr)

	if !proc.IsAlive() {
		t.Fatal("IsAlive should be true right after spawn")
	}
	proc.shutdown() // 主动关停:SIGTERM → 落定

	waitDone(t, proc, 5*time.Second)
	if proc.IsAlive() {
		t.Fatal("IsAlive should be false after shutdown")
	}
	if !proc.shutdownStarted.Load() {
		t.Fatal("shutdownStarted should be true after shutdown")
	}
	exitCode, signal := exitCodeSignal(proc.state.Load())
	if exitCode != -1 {
		t.Fatalf("signaled-death exitCode = %d, want -1", exitCode)
	}
	if signal == "" {
		t.Fatal("expected a signal name for signaled death")
	}
	if got := exitKind(true, exitCode, signal != ""); got != "expected" {
		t.Fatalf("exitKind = %q, want %q", got, "expected")
	}
}

// TestHarnessProcessUnexpectedCleanExit 进程自行干净退出(exit 0)且非我们发起:
// 分类=unexpected-clean(典型 harness 空闲自杀),IsAlive 翻 false。
func TestHarnessProcessUnexpectedCleanExit(t *testing.T) {
	cmd, stderr := startDummy(t, "sh", "-c", "exit 0")
	proc := newHarnessProcess(cmd, "sh -c exit 0", stderr)

	waitDone(t, proc, 5*time.Second)
	if proc.IsAlive() {
		t.Fatal("IsAlive should be false after exit")
	}
	if proc.shutdownStarted.Load() {
		t.Fatal("shutdownStarted should be false (we did not initiate)")
	}
	exitCode, signal := exitCodeSignal(proc.state.Load())
	if exitCode != 0 {
		t.Fatalf("exitCode = %d, want 0", exitCode)
	}
	if signal != "" {
		t.Fatalf("signal = %q, want empty (not signaled)", signal)
	}
	if got := exitKind(false, exitCode, signal != ""); got != "unexpected-clean" {
		t.Fatalf("exitKind = %q, want %q", got, "unexpected-clean")
	}
}

// TestHarnessProcessCrashWithStderr 进程崩溃(非零退出 + stderr 输出):分类=crash,
// stderr 环捕获到崩溃前的输出(根因日志的素材)。这是「peer disconnected」真因定位的核心路径。
func TestHarnessProcessCrashWithStderr(t *testing.T) {
	cmd, stderr := startDummy(t, "sh", "-c", "echo boom-before-crash 1>&2; exit 3")
	proc := newHarnessProcess(cmd, "sh -c 'echo boom 1>&2; exit 3'", stderr)

	waitDone(t, proc, 5*time.Second)
	if proc.shutdownStarted.Load() {
		t.Fatal("shutdownStarted should be false (crash, not our shutdown)")
	}
	exitCode, signal := exitCodeSignal(proc.state.Load())
	if exitCode != 3 {
		t.Fatalf("exitCode = %d, want 3", exitCode)
	}
	if got := exitKind(false, exitCode, signal != ""); got != "crash" {
		t.Fatalf("exitKind = %q, want %q", got, "crash")
	}
	if got := stderr.Snapshot(); !strings.Contains(got, "boom-before-crash") {
		t.Fatalf("stderr ring did not capture crash output: %q", got)
	}
}

// TestHarnessProcessSignalDeathClassifiedAsCrash 被信号杀(模拟外部 kill / OOM)且非我们发起:
// 分类=crash(SIGKILL 由 OS OOM killer 或外部发送,不是我们的 shutdown)。
func TestHarnessProcessSignalDeathClassifiedAsCrash(t *testing.T) {
	cmd, stderr := startDummy(t, "sleep", "30")
	proc := newHarnessProcess(cmd, "sleep 30", stderr)

	// 外部杀(模拟 OOM/外部 kill):不经 shutdown → 不标 expected。
	// 用进程组主 PID 直接发 SIGKILL(Setpgid 后 pgid==主 PID)。
	if err := cmd.Process.Kill(); err != nil {
		t.Fatalf("kill: %v", err)
	}
	waitDone(t, proc, 5*time.Second)

	exitCode, signal := exitCodeSignal(proc.state.Load())
	if exitCode != -1 {
		t.Fatalf("exitCode = %d, want -1 (signaled)", exitCode)
	}
	if signal == "" {
		t.Fatal("expected signal name")
	}
	if got := exitKind(false, exitCode, signal != ""); got != "crash" {
		t.Fatalf("exitKind = %q, want %q (external signal death = crash)", got, "crash")
	}
}
