//go:build !windows

package terminal

import (
	"os/exec"
	"syscall"
)

// killProcessGroup reaps the shell's whole process group: an interactive shell
// makes itself group leader (pgid==pid), so SIGKILLing the group also takes
// down vim/foreground children inside the terminal. Falls back to killing just
// the shell process when the pgid query fails.
func killProcessGroup(cmd *exec.Cmd) {
	if pgid, err := syscall.Getpgid(cmd.Process.Pid); err == nil {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
	} else {
		_ = cmd.Process.Kill()
	}
}
