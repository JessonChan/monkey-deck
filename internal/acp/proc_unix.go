//go:build !windows

package acp

import (
	"log/slog"
	"os"
	"os/exec"
	"syscall"
)

// setProcGroup configures an independent process group (Setpgid=true) and must
// be called before cmd.Start(). The harness and the children that stay in its
// group then share one pgid, so a later kill -PGID reaps them all together.
func setProcGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// termGroup sends SIGTERM to the whole process group.
func termGroup(pgid int) {
	if err := syscall.Kill(-pgid, syscall.SIGTERM); err != nil && !isNoProcess(err) {
		slog.Warn("kill harness group SIGTERM", "pgid", pgid, "err", err)
	}
}

// killGroup sends SIGKILL to the whole process group.
func killGroup(pgid int) {
	if err := syscall.Kill(-pgid, syscall.SIGKILL); err != nil && !isNoProcess(err) {
		slog.Warn("kill harness group SIGKILL", "pgid", pgid, "err", err)
	}
}

// groupAlive probes the process group with kill(-pgid, 0).
func groupAlive(pgid int) bool {
	return syscall.Kill(-pgid, 0) == nil
}

// probeAlive probes a single process with signal 0 (unix liveness probe).
func probeAlive(p *os.Process) bool {
	return p.Signal(syscall.Signal(0)) == nil
}

// killProcessHard SIGKILLs a single process (stray-harness reap path).
func killProcessHard(pid int) error {
	return syscall.Kill(pid, syscall.SIGKILL)
}

// isNoProcess reports whether err means "no such process/group" (safe no-op).
func isNoProcess(err error) bool {
	return err == syscall.ESRCH
}
