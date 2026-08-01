// Package shellenv resolves the user's login-shell PATH into the running
// process, fixing the classic macOS/Linux problem where a GUI app launched
// from Finder/Dock/Spotlight inherits only launchd's minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) and cannot find user-installed tools
// (Homebrew, bun, npm-global, nvm/volta-managed node, …).
//
// Mechanism (mirrors VS Code's src/vs/platform/shell/node/shellEnv.ts):
// spawn the user's login+interactive shell, ask it to dump its env, parse
// the PATH out. We do NOT read or parse .zshrc/.zprofile ourselves — the
// shell is the only correct interpreter of its own config (source chains,
// conditionals, functions). We borrow the shell's brain, we don't act as a
// parser. Only PATH is touched; other vars stay untouched to avoid breaking
// the app (e.g. NODE_OPTIONS).
//
// Idempotent per process: sync.Once guards the work so only the first caller
// spawns a shell; later callers get the cached result (or cached error)
// instantly. Two call sites (harness.Discover path + harness spawn path)
// thus never double-spawn — whoever needs PATH first wins, the other no-ops.
//
// Windows is a no-op (env vars are global via the registry, no per-shell PATH).
package shellenv

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// resolveBudget is the internal timeout for spawning the user's shell.
// We deliberately do NOT inherit the caller's ctx deadline — the first
// caller may carry a short context (e.g. Discover's 5s budget) while shell
// startup legitimately takes longer on some machines. A fixed, generous
// budget keeps the cache from being poisoned by a transiently short caller
// ctx. Mirrors VS Code's MAX_SHELL_RESOLVE_TIME (default 10s).
const resolveBudget = 10 * time.Second

// sentinel env value that user rc files can guard on to skip noisy side
// effects (prompts, banners) while we capture env. Mirrors VS Code's
// VSCODE_RESOLVING_ENVIRONMENT.
const sentinelKey = "MONKEY_DECK_RESOLVING_ENV"

var (
	once   sync.Once
	resErr error  // cached result of the single resolve attempt
	didRun bool   // true after the single attempt completes (success or fail)
	resMu  sync.RWMutex
)

// Injectable seams for tests (§5.1): production uses the real pickShell and
// captureShellEnv; tests swap them to fake the shell without spawning anything.
var (
	pickShellFn      = pickShell
	captureShellEnvFn = captureShellEnv
)

// Resolve merges the user's login-shell PATH into the current process.
// Idempotent: the first call spawns the shell and caches the outcome; all
// subsequent calls return instantly with the same result. Returns nil on
// Windows (no-op) and on success. On failure PATH is left untouched and a
// non-nil error is returned (caller should log and continue — the app still
// runs, just with the minimal PATH).
//
// The ctx is accepted for API symmetry but is NOT used to cancel the resolve
// work. The work runs under a fixed internal budget (resolveBudget) and its
// result is cached process-wide via sync.Once; allowing a caller to abort it
// would risk poisoning the shared cache with a premature failure that later
// callers (with a long-lived ctx) would inherit forever. All callers therefore
// wait for the work to finish (bounded by resolveBudget) on the first call.
func Resolve(ctx context.Context) error {
	_ = ctx // accepted for symmetry; the resolve work is not caller-cancellable
	if runtime.GOOS == "windows" {
		return nil // no-op: Windows env is registry-global
	}

	// Fast path: already resolved in this process? Return cached outcome.
	// This is what makes the second call site (harness spawn) free: by the time
	// a user opens a session, the Discover path has usually already resolved.
	resMu.RLock()
	if didRun {
		err := resErr
		resMu.RUnlock()
		return err
	}
	resMu.RUnlock()

	// Slow path: the first caller does the work under once.Do. Concurrent callers
	// block on once.Do (it's a full barrier) until the work finishes, then read
	// the published result via the fast path. Every caller reads the SAME shared
	// fields — never a per-goroutine channel (that would leak blocked receivers).
	once.Do(func() {
		err := doResolve()
		resMu.Lock()
		resErr = err
		didRun = true
		resMu.Unlock()
	})

	// once.Do has returned for all callers; the shared result is now published.
	resMu.RLock()
	defer resMu.RUnlock()
	return resErr
}

// doResolve spawns the user's login+interactive shell, captures its env, and
// merges the resolved PATH into os.environ. Called exactly once per process.
//
// Steps:
//  1. Pick the shell: $SHELL (if usable), else platform default (zsh on darwin,
//     bash elsewhere). We never use a broken shell (/bin/false etc.).
//  2. Spawn `<shell> -i -l -c 'echo <MARK>; env'` (interactive+login so both
//     .zprofile/.profile AND .zshrc/.bashrc are sourced). tcsh/csh use -ic.
//  3. Find the marker, parse KEY=VALUE lines after it.
//  4. If a PATH was resolved, UNION-merge it into the current PATH (shell dirs
//     first in their declared order, then any pre-existing dir not in the shell
//     PATH appended). This never loses a dir, so a terminal launch that already
//     added e.g. /tmp/extra keeps it; a Finder launch (minimal PATH) just gets
//     the full shell PATH.
//
// CRITICAL: doResolve deliberately does NOT take the caller's ctx. The resolve
// work runs under our own resolveBudget derived from context.Background(), so a
// transiently short caller ctx (e.g. Discover's 5s) can neither shrink the
// budget nor abort the work. This is essential because the result is cached for
// the whole process via sync.Once: a caller that merely gave up must NOT poison
// the shared cache with a premature failure (otherwise a later caller with a
// long-lived ctx, like spawnAndInit, would inherit the cached failure forever).
func doResolve() error {
	shell := pickShellFn()
	if shell == "" {
		return errors.New("shellenv: no usable shell found")
	}

	resolveCtx, cancel := context.WithTimeout(context.Background(), resolveBudget)
	defer cancel()
	resolved, err := captureShellEnvFn(resolveCtx, shell)
	if err != nil {
		return fmt.Errorf("shellenv: %w", err)
	}
	shellPath := resolved["PATH"]
	if shellPath == "" {
		// Shell ran but didn't export a PATH — nothing to do. Not an error.
		slog.Debug("shellenv: shell did not export PATH", "shell", shell)
		return nil
	}
	prev := os.Getenv("PATH")
	merged := mergePATH(prev, shellPath)
	if err := os.Setenv("PATH", merged); err != nil {
		return fmt.Errorf("shellenv: setenv PATH: %w", err)
	}
	slog.Info("shellenv: merged PATH from login shell", "shell", shell, "prevLen", len(prev), "mergedLen", len(merged))
	return nil
}

// mergePATH unions the existing PATH with the login-shell PATH. Shell entries
// keep their declared order and precedence; any existing entry not already
// present in the shell PATH is appended afterwards. No directory is ever lost.
//
// Why union instead of overwrite: a terminal launch may have prepended
// session-specific dirs (e.g. a temporarily-installed harness in /tmp/extra)
// that the login shell doesn't know about. Overwriting with the shell PATH
// would drop them and make a previously-findable harness vanish. Union keeps
// them (at lower precedence). For the Finder-launch case (the primary target),
// the existing PATH is launchd's minimal set, which is already a subset of the
// shell PATH, so union == shell PATH with no observable difference.
func mergePATH(existing, shellPath string) string {
	seen := make(map[string]struct{})
	var b strings.Builder
	add := func(dir string) {
		if dir == "" {
			return
		}
		if _, ok := seen[dir]; ok {
			return
		}
		seen[dir] = struct{}{}
		if b.Len() > 0 {
			b.WriteByte(os.PathListSeparator)
		}
		b.WriteString(dir)
	}
	for _, d := range strings.Split(shellPath, string(os.PathListSeparator)) {
		add(d)
	}
	for _, d := range strings.Split(existing, string(os.PathListSeparator)) {
		add(d)
	}
	return b.String()
}

// pickShell returns the user's login shell if usable, else a platform default.
// A "usable" shell is a non-empty $SHELL that isn't /bin/false or /bin/nologin
// (which some systems set for non-login service accounts).
func pickShell() string {
	if s := os.Getenv("SHELL"); s != "" && !isBrokenShell(s) {
		return s
	}
	if runtime.GOOS == "darwin" {
		return "/bin/zsh"
	}
	return "/bin/bash"
}

func isBrokenShell(s string) bool {
	base := filepath.Base(s)
	return base == "false" || base == "nologin" || s == "/bin/false" || s == "/usr/sbin/nologin"
}

// captureShellEnv spawns the shell in login+interactive mode and returns its
// exported environment (only the part after the marker is trusted). The ctx is
// expected to already carry the internal budget (resolveBudget) — doResolve
// derives it from context.Background() so no caller deadline can shrink it.
func captureShellEnv(ctx context.Context, shell string) (map[string]string, error) {
	mark := "MD_ENV_BEGIN_" + fmt.Sprintf("%d", time.Now().UnixNano())

	args := shellArgs(filepath.Base(shell), mark)
	// Build the command that runs inside the shell: print marker then dump env.
	// Using /usr/bin/env keeps us off the shell's built-in parsing quirks; the
	// marker separates shell startup noise from our trusted output.
	innerCmd := fmt.Sprintf("echo %s; env", mark)

	cmd := exec.CommandContext(ctx, shell, append(args, innerCmd)...)
	// Minimal env for the child: avoid inheriting GUI-app junk that could confuse
	// the shell, but keep what it needs to start. Sentinel lets user rc guard.
	cmd.Env = childEnv()
	cmd.Stdin = nil

	var out bytes.Buffer
	cmd.Stdout = &out
	// Discard stderr but capture size for diagnostics; shell rc files are chatty.
	var stderrBuf bytes.Buffer
	cmd.Stderr = &stderrBuf

	start := time.Now()
	if err := cmd.Run(); err != nil {
		// Distinguish our budget expiry from a caller-initiated cancellation.
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("spawn %s timed out after %s", shell, resolveBudget)
		}
		return nil, fmt.Errorf("spawn %s: %w (stderr: %q)", shell, err, truncForLog(stderrBuf.String()))
	}
	env, err := parseAfterMarker(out.String(), mark)
	if err != nil {
		return nil, fmt.Errorf("parse shell env: %w (stderr: %q)", err, truncForLog(stderrBuf.String()))
	}
	slog.Debug("shellenv: captured shell env", "shell", shell, "keys", len(env), "elapsed", time.Since(start))
	return env, nil
}

// shellArgs returns the per-shell invocation flags for "run this command in a
// login+interactive shell". tcsh/csh only support -ic (combined). POSIX shells
// use -i -l -c. PowerShell/nushell are not supported (they don't share the Unix
// PATH semantics relevant here); users on those shells fall back to the default.
func shellArgs(name, _ string) []string {
	switch name {
	case "tcsh", "csh":
		return []string{"-ic"}
	default:
		return []string{"-i", "-l", "-c"}
	}
}

// childEnv builds the minimal environment passed to the spawned login shell.
// We avoid forwarding the GUI app's whole env (which can contain VITE_*, debug
// flags, etc. that would break the shell), but keep what the shell needs to
// start and read its config. Sentinel allows rc files to guard noisy side
// effects. GIT_TERMINAL_PROMPT=0 prevents git from hanging on missing creds.
func childEnv() []string {
	keep := []string{"HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM"}
	env := make([]string, 0, len(keep)+4)
	for _, k := range keep {
		if v := os.Getenv(k); v != "" {
			env = append(env, k+"="+v)
		}
	}
	if os.Getenv("TERM") == "" {
		env = append(env, "TERM=dumb") // avoid terminal-control noise from rc files
	}
	env = append(env,
		"PS1=",                 // silence prompt emission in interactive mode
		"GIT_TERMINAL_PROMPT=0",
		"HOMEBREW_NO_AUTO_UPDATE=1",
		sentinelKey+"=1",
	)
	return env
}

// parseAfterMarker returns the KEY=VALUE entries found after the marker line.
// Everything before the marker (shell startup banners, MOTD, rc echo) is
// ignored. Only well-formed KEY=VALUE lines (key matches [A-Za-z_][A-Za-z0-9_]*)
// are kept; malformed lines are skipped silently.
func parseAfterMarker(output, mark string) (map[string]string, error) {
	sc := bufio.NewScanner(strings.NewReader(output))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024) // large env dumps
	found := false
	env := map[string]string{}
	for sc.Scan() {
		line := sc.Text()
		if !found {
			if strings.TrimSpace(line) == mark {
				found = true
			}
			continue
		}
		k, v, ok := splitEnvLine(line)
		if !ok {
			continue
		}
		// Don't carry our own sentinel back into the app env.
		if k == sentinelKey {
			continue
		}
		env[k] = v
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if !found {
		return nil, errors.New("marker not found in shell output")
	}
	return env, nil
}

// splitEnvLine splits "KEY=VALUE" at the first '='. Returns ok=false if the
// line isn't a valid env entry (no '=' or bad key).
func splitEnvLine(line string) (key, val string, ok bool) {
	eq := strings.IndexByte(line, '=')
	if eq <= 0 {
		return "", "", false
	}
	k := line[:eq]
	if !validEnvKey(k) {
		return "", "", false
	}
	return k, line[eq+1:], true
}

func validEnvKey(k string) bool {
	if k == "" {
		return false
	}
	for i, r := range k {
		isAlpha := (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || r == '_'
		isDigit := r >= '0' && r <= '9'
		if i == 0 {
			if !isAlpha {
				return false
			}
		} else if !(isAlpha || isDigit) {
			return false
		}
	}
	return true
}

func truncForLog(s string) string {
	const max = 300
	if len(s) > max {
		return s[:max] + "…"
	}
	return s
}

// resetForTest clears the once-guard and cached result so a test can exercise
// Resolve repeatedly with different injected pickShellFn/captureShellEnvFn.
// Production code never calls this. NOT safe to call concurrently with Resolve.
func resetForTest() {
	once = sync.Once{}
	resMu.Lock()
	resErr = nil
	didRun = false
	resMu.Unlock()
}
