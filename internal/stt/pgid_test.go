package stt

// pgid_test.go: the sidecar process-group registry — lifecycle bookkeeping
// (register on spawn, unregister on every exit path) and the startup sweep
// that kills orphans left by a crashed previous run (§3.2, #24308 review
// P2). All against the fake whisper-server binary, never the real engine.

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// TestSidecarPgidRegistryLifecycle: a spawned sidecar is registered; stop
// (the clean path) unregisters it.
func TestSidecarPgidRegistryLifecycle(t *testing.T) {
	svc := newTestService(t, defaultModelID)
	if _, err := svc.Transcribe(context.Background(), []byte("x"), "audio/wav"); err != nil {
		t.Fatal(err)
	}
	svc.mu.Lock()
	sc := svc.sidecar
	svc.mu.Unlock()
	if sc == nil {
		t.Fatal("sidecar missing after Transcribe")
	}

	ents := readSidecarEntries(svc.pgidFile)
	if len(ents) != 1 || ents[0].PGID != sc.pgid {
		t.Fatalf("pgid file = %+v, want exactly [{%d …}]", ents, sc.pgid)
	}
	serverPath := svc.serverPath // discoverFn is stubbed; this is the fake binary path
	if ents[0].Cmd != serverPath {
		t.Fatalf("entry cmd = %q, want %q", ents[0].Cmd, serverPath)
	}

	if err := svc.StopSTTSidecar(); err != nil {
		t.Fatal(err)
	}
	if ents := readSidecarEntries(svc.pgidFile); len(ents) != 0 {
		t.Fatalf("pgid file after stop = %+v, want empty", ents)
	}
}

// TestSidecarPgidUnregistersOnCrash: the watcher's exit hook unregisters
// even on unexpected death (SIGKILL behind the service's back).
func TestSidecarPgidUnregistersOnCrash(t *testing.T) {
	svc := newTestService(t, defaultModelID)
	if _, err := svc.Transcribe(context.Background(), []byte("x"), "audio/wav"); err != nil {
		t.Fatal(err)
	}
	svc.mu.Lock()
	sc := svc.sidecar
	svc.mu.Unlock()

	if err := syscall.Kill(sc.pgid, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	select {
	case <-sc.done: // watcher ran onExit before closing done
	case <-time.After(5 * time.Second):
		t.Fatal("sidecar did not exit after SIGKILL")
	}
	if ents := readSidecarEntries(svc.pgidFile); len(ents) != 0 {
		t.Fatalf("pgid file after crash = %+v, want empty", ents)
	}
}

// spawnStraySidecar starts the fake whisper-server in its own process group
// (simulating an orphan from a crashed previous run) and returns it. Waits
// for readiness so the ps-based sweep sees the fully exec'd command line.
func spawnStraySidecar(t *testing.T, serverPath string) *exec.Cmd {
	t.Helper()
	port, err := freePort()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(serverPath,
		"-m", "leftover-model",
		"--host", "127.0.0.1",
		"--port", fmt.Sprintf("%d", port),
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatalf("spawn stray: %v", err)
	}
	if err := waitHealthy(context.Background(), fmt.Sprintf("http://127.0.0.1:%d", port), 5*time.Second); err != nil {
		t.Fatalf("stray not healthy: %v", err)
	}
	t.Cleanup(func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
	})
	return cmd
}

// TestKillLeftoverSidecars: the sweep kills recorded groups that still run
// the recorded command, spares pgids whose command no longer matches (pgid
// reuse guard), and resets the registry.
func TestKillLeftoverSidecars(t *testing.T) {
	serverPath := buildFakeServer(t)
	path := filepath.Join(t.TempDir(), "stt-sidecar-pgids.json")

	// A leftover from a "crashed" run.
	stray := spawnStraySidecar(t, serverPath)
	writeSidecarEntries(path, []sidecarEntry{{PGID: stray.Process.Pid, Cmd: serverPath}})

	if killed := killLeftoverSidecars(path); killed != 1 {
		t.Fatalf("killed = %d, want 1", killed)
	}
	_ = stray.Wait() // reap first: an unreaped zombie keeps the group answerable to kill(0)
	if err := syscall.Kill(-stray.Process.Pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("stray group still alive after sweep: %v", err)
	}
	if ents := readSidecarEntries(path); len(ents) != 0 {
		t.Fatalf("registry after sweep = %+v, want empty", ents)
	}

	// Reuse guard: a live pgid whose recorded command does not match is
	// never killed.
	other := spawnStraySidecar(t, serverPath)
	writeSidecarEntries(path, []sidecarEntry{{PGID: other.Process.Pid, Cmd: "/usr/bin/definitely-not-our-sidecar"}})
	if killed := killLeftoverSidecars(path); killed != 0 {
		t.Fatalf("killed = %d, want 0 (command mismatch must be spared)", killed)
	}
	if err := syscall.Kill(-other.Process.Pid, 0); err != nil {
		t.Fatalf("mismatched pgid must stay alive: %v", err)
	}
}

// TestStartupSweepsLeftoverSidecars: the wiring — ServiceStartup on a
// CachesDir holding a stale registry kills the leftover before this run
// spawns anything of its own.
func TestStartupSweepsLeftoverSidecars(t *testing.T) {
	dir := t.TempDir()
	serverPath := buildFakeServer(t)
	stray := spawnStraySidecar(t, serverPath)
	writeSidecarEntries(filepath.Join(dir, "stt-sidecar-pgids.json"),
		[]sidecarEntry{{PGID: stray.Process.Pid, Cmd: serverPath}})

	cfg := config.TestConfig(dir)
	if err := cfg.EnsureDir(); err != nil {
		t.Fatal(err)
	}
	svc := NewService(cfg)
	t.Setenv("MD_WHISPER_SERVER", serverPath)
	if err := svc.ServiceStartup(context.Background(), application.ServiceOptions{}); err != nil {
		t.Fatalf("startup: %v", err)
	}
	t.Cleanup(func() { _ = svc.ServiceShutdown() })

	_ = stray.Wait() // reap first: an unreaped zombie keeps the group answerable to kill(0)
	if err := syscall.Kill(-stray.Process.Pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("leftover survived startup sweep: %v", err)
	}
	if ents := readSidecarEntries(filepath.Join(dir, "stt-sidecar-pgids.json")); len(ents) != 0 {
		t.Fatalf("registry after startup sweep = %+v, want reset to empty", ents)
	}
}
