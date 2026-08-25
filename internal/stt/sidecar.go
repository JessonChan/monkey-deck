// sidecar.go: whisper-server sidecar process pipeline.
//
// Lifecycle: lazy start on first Transcribe (no resource cost when STT is
// unused) → readiness poll on /health (model load can take seconds on large
// models) → reused across transcriptions → restarted when the selected model
// changes or when the process died (self-heal) → stopped on model switch,
// server-path change, explicit StopSTTSidecar, and ServiceShutdown.
//
// Process discipline (§3.2, same as harnesses): own process group via Setpgid,
// group-wide SIGTERM then SIGKILL on stop, single owner for cmd.Wait (the
// watcher goroutine) so stop never races a second Wait. whisper-server spawns
// no children, so no stray-reaping layer is needed.

package stt

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os/exec"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// serverCandidates are the binary names probed on PATH (brew's whisper-cpp
// formula and upstream builds install `whisper-server`).
var serverCandidates = []string{"whisper-server"}

// sidecarStopGrace: how long the sidecar gets to exit on SIGTERM before the
// group is SIGKILLed.
const sidecarStopGrace = 3 * time.Second

// logRingCap is the stderr tail kept for "why did the sidecar die" logging.
const logRingCap = 16 * 1024

// sidecar is one running whisper-server process bound to a model file.
type sidecar struct {
	serverPath string
	modelPath  string
	modelID    string
	port       int
	cmd        *exec.Cmd
	pgid       int
	stderr     *stderrRing

	onExit func(pgid int) // pgid-registry unregister, called once from the watcher

	shutdown atomic.Bool
	alive    atomic.Bool
	done     chan struct{} // closed when the watcher's Wait returned
}

// baseURL is the local whisper-server API root.
func (sc *sidecar) baseURL() string {
	return fmt.Sprintf("http://127.0.0.1:%d", sc.port)
}

// isAlive reports whether the process is still up.
func (sc *sidecar) isAlive() bool {
	if !sc.alive.Load() {
		return false
	}
	return sc.cmd.Process != nil && sc.cmd.Process.Signal(syscall.Signal(0)) == nil
}

// startSidecar spawns whisper-server on a free loopback port and waits until
// /health answers. The caller receives a fully-ready sidecar or an error.
// onSpawned (may be nil) runs right after a successful Start — before the
// watcher can observe an exit — so the pgid registry never misses a live
// process; onExit (may be nil) runs exactly once after the process was
// reaped, on every exit path (stop, crash, health-timeout reap).
func startSidecar(ctx context.Context, serverPath, modelPath, modelID string, healthWait time.Duration, onSpawned, onExit func(int)) (*sidecar, error) {
	port, err := freePort()
	if err != nil {
		return nil, fmt.Errorf("stt: pick port: %w", err)
	}
	cmd := exec.Command(serverPath,
		"-m", modelPath,
		"--host", "127.0.0.1",
		"--port", strconv.Itoa(port),
	)
	// Own process group (§3.2): stop kills the whole group, never just the PID.
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true

	sc := &sidecar{
		serverPath: serverPath,
		modelPath:  modelPath,
		modelID:    modelID,
		port:       port,
		cmd:        cmd,
		stderr:     newStderrRing(logRingCap),
		onExit:     onExit,
		done:       make(chan struct{}),
	}
	cmd.Stderr = sc.stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("stt: start whisper-server: %w", err)
	}
	sc.pgid = cmd.Process.Pid // Setpgid ⇒ pgid == main pid
	if onSpawned != nil {
		onSpawned(sc.pgid)
	}
	sc.alive.Store(true)

	// Watcher owns cmd.Wait exclusively (no double-Wait races); it logs
	// unexpected exits with the stderr tail — the only post-mortem we have.
	go func() {
		werr := cmd.Wait()
		sc.alive.Store(false)
		if !sc.shutdown.Load() {
			msg := ""
			if werr != nil {
				msg = werr.Error()
			}
			slog.Warn("stt sidecar exited unexpectedly",
				"pgid", sc.pgid, "model", sc.modelID, "err", msg,
				"stderrTail", sc.stderr.Tail(2*1024))
		}
		if sc.onExit != nil {
			sc.onExit(sc.pgid)
		}
		close(sc.done)
	}()

	if err := waitHealthy(ctx, sc.baseURL(), healthWait); err != nil {
		sc.stop() // reap the half-started process before reporting failure
		return nil, fmt.Errorf("stt: whisper-server not ready after %s (model %s): %w", healthWait, modelID, err)
	}
	slog.Info("stt sidecar started", "port", sc.port, "model", modelID, "pid", sc.pgid)
	return sc, nil
}

// stop shuts the process group down: SIGTERM, grace period, then SIGKILL.
// Idempotent; blocks until the watcher has reaped the process.
func (sc *sidecar) stop() {
	if sc.shutdown.Swap(true) {
		<-sc.done // already stopping/stopped: just wait for the reap
		return
	}
	if err := syscall.Kill(-sc.pgid, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		slog.Warn("stt sidecar SIGTERM", "pgid", sc.pgid, "err", err)
	}
	select {
	case <-sc.done:
	case <-time.After(sidecarStopGrace):
		if err := syscall.Kill(-sc.pgid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
			slog.Warn("stt sidecar SIGKILL", "pgid", sc.pgid, "err", err)
		}
		<-sc.done
	}
}

// waitHealthy polls GET /health until it answers 200, the deadline, or ctx
// cancellation. whisper-server loads the model before listening, so first
// readiness can legitimately take a while on large models / slow disks.
func waitHealthy(ctx context.Context, baseURL string, wait time.Duration) error {
	client := &http.Client{Timeout: 2 * time.Second}
	deadline := time.Now().Add(wait)
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/health", nil)
		if err != nil {
			return err
		}
		if resp, err := client.Do(req); err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		if time.Now().After(deadline) {
			return errors.New("health check deadline exceeded")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(150 * time.Millisecond):
		}
	}
}

// freePort reserves an ephemeral loopback port and releases it for the
// sidecar to bind. The tiny TOCTOU window is fine on a local machine: a
// collision surfaces as a failed whisper-server bind, i.e. a health-check
// timeout, i.e. a transcription error — never corruption.
func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// stderrRing is a fixed-capacity ring buffer keeping the stderr tail for
// post-mortem logging (same idea as the acp package's harness stderr ring,
// inlined here to keep stt self-contained).
type stderrRing struct {
	mu     sync.Mutex
	buf    []byte
	pos    int // next write position
	stored int // bytes currently stored (<= cap)
}

func newStderrRing(capacity int) *stderrRing {
	return &stderrRing{buf: make([]byte, capacity)}
}

func (r *stderrRing) Write(p []byte) (int, error) {
	orig := len(p)
	if orig == 0 {
		return 0, nil
	}
	if orig >= len(r.buf) {
		p = p[orig-len(r.buf):] // keep only the tail: the root cause is last
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for len(p) > 0 {
		c := copy(r.buf[r.pos:], p)
		r.pos = (r.pos + c) % len(r.buf)
		p = p[c:]
	}
	r.stored = min(r.stored+orig, len(r.buf))
	return orig, nil
}

// Tail returns the most recent n bytes (oldest → newest).
func (r *stderrRing) Tail(n int) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if n <= 0 || r.stored == 0 {
		return ""
	}
	if n > r.stored {
		n = r.stored
	}
	out := make([]byte, n)
	start := (r.pos - n + len(r.buf)) % len(r.buf)
	for i := 0; i < n; i++ {
		out[i] = r.buf[(start+i)%len(r.buf)]
	}
	return string(out)
}
