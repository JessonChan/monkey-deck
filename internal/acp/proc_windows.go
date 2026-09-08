//go:build windows

package acp

import (
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"syscall"
)

// Windows process handling (first version, degraded):
//
// Windows has no POSIX process groups, so there is no Setpgid and no group
// signal. Every "group" helper below degrades to a single-process kill keyed
// by the recorded pgid — which on windows is simply the harness main PID (see
// newHarnessProcess). Known limits of this first version:
//   - kill cannot reap the whole group: harness children/grandchildren are
//     orphaned when only the main PID is terminated;
//   - the SIGTERM→SIGKILL grace sequence collapses into one immediate
//     TerminateProcess (no graceful signal concept).
//
// TODO(#207): consider Windows Job Objects for full-tree teardown.

// setProcGroup is a no-op on windows: there are no process groups.
func setProcGroup(cmd *exec.Cmd) {}

// termGroup degrades to a single-process kill: SIGTERM has no group semantics.
func termGroup(pgid int) {
	killSingleProcess(pgid)
}

// killGroup degrades to a single-process kill (TerminateProcess).
func killGroup(pgid int) {
	killSingleProcess(pgid)
}

// groupAlive probes the harness main process (the recorded "pgid" on windows).
func groupAlive(pgid int) bool {
	return pidAlive(pgid)
}

// probeAlive probes one process. Signal(0) is unsupported on windows (every
// non-Kill signal returns EWINDOWS), so probe via OpenProcess+WaitForSingleObject.
func probeAlive(p *os.Process) bool {
	if p == nil {
		return false
	}
	return pidAlive(p.Pid)
}

// killProcessHard kills a single process (stray-harness reap path).
func killProcessHard(pid int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}

// isNoProcess reports whether err means "process already gone" (safe no-op).
// ESRCH never surfaces on windows; os.ErrProcessDone is the equivalent.
func isNoProcess(err error) bool {
	return errors.Is(err, os.ErrProcessDone)
}

// killSingleProcess terminates exactly one process by pid (best-effort).
func killSingleProcess(pid int) {
	p, err := os.FindProcess(pid)
	if err != nil {
		return // process gone: nothing to kill
	}
	if err := p.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		slog.Warn("kill harness process (windows single-process)", "pid", pid, "err", err)
	}
}

// pidAlive reports whether pid is still running: OpenProcess(SYNCHRONIZE) +
// WaitForSingleObject(0). WAIT_TIMEOUT means alive; a terminated process
// object is signaled. Pid reuse can false-positive, same as unix kill(pid, 0).
func pidAlive(pid int) bool {
	h, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)
	event, err := syscall.WaitForSingleObject(h, 0)
	if err != nil {
		return false
	}
	return event == syscall.WAIT_TIMEOUT
}
