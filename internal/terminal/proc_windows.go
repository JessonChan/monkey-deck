//go:build windows

package terminal

import (
	"os/exec"
)

// Windows limitation (first version): no POSIX process groups (and no SIGHUP
// via PTY close), so killProcessGroup degrades to killing just the shell
// process; children inside the terminal are orphaned.
// TODO(#207): consider Windows Job Objects for full-tree teardown.
func killProcessGroup(cmd *exec.Cmd) {
	_ = cmd.Process.Kill()
}
