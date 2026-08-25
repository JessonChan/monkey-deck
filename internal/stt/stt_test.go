package stt

// stt_test.go: service-level tests against the FAKE whisper-server binary
// (testdata/fakewhisper, compiled on the fly — never the real engine, §5.1).
// The fake's transcript encodes <model-file>:<audio-bytes>:<filename>, so a
// single string assertion covers the model selection, the byte pass-through,
// and the MIME→extension mapping of the whole sidecar pipeline.

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// buildFakeServer compiles testdata/fakewhisper into a temp binary and points
// the service at it via MD_WHISPER_SERVER (env override wins discovery).
func buildFakeServer(t *testing.T) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "fakewhisper")
	cmd := exec.Command("go", "build", "-o", out, "./testdata/fakewhisper")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fakewhisper: %v: %s", err, b)
	}
	return out
}

// newTestService starts a service wired to the fake server with the given
// catalog models already "downloaded" (dummy bytes on disk).
func newTestService(t *testing.T, modelIDs ...string) *Service {
	t.Helper()
	cfg := config.TestConfig(t.TempDir())
	if err := cfg.EnsureDir(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MD_WHISPER_SERVER", buildFakeServer(t))
	svc := NewService(cfg)
	if err := svc.ServiceStartup(context.Background(), application.ServiceOptions{}); err != nil {
		t.Fatalf("startup: %v", err)
	}
	t.Cleanup(func() { _ = svc.ServiceShutdown() })
	svc.discoverFn = func() {} // hermetic: never re-discover mid-test
	for _, id := range modelIDs {
		seedModel(t, svc, id)
	}
	return svc
}

// seedModel writes a dummy model file so the pipeline sees it as downloaded.
func seedModel(t *testing.T, svc *Service, id string) {
	t.Helper()
	m := modelByID(id)
	if m == nil {
		t.Fatalf("seedModel: unknown id %q", id)
	}
	if err := os.MkdirAll(svc.modelsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(svc.modelsDir, m.File), []byte("dummy-ggml"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func fakeTranscript(modelID string, n int) string {
	return fmt.Sprintf("fake:%s:%d:audio.wav", modelByID(modelID).File, n)
}

// TestTranscribeFullPipeline: fake sidecar + downloaded default model →
// Transcribe returns the fake transcript carrying the model file, the exact
// audio length and the wav filename; the sidecar is reused across calls.
func TestTranscribeFullPipeline(t *testing.T) {
	svc := newTestService(t, defaultModelID)
	audio := []byte("hello-world-audio-bytes")

	got, err := svc.Transcribe(context.Background(), audio, "audio/wav")
	if err != nil {
		t.Fatalf("Transcribe: %v", err)
	}
	if want := fakeTranscript(defaultModelID, len(audio)); got != want {
		t.Fatalf("transcript = %q, want %q", got, want)
	}

	// Same sidecar reused for the second call (no restart).
	svc.mu.Lock()
	first := svc.sidecar
	svc.mu.Unlock()
	if first == nil || !first.isAlive() {
		t.Fatal("sidecar should be alive after first Transcribe")
	}
	got2, err := svc.Transcribe(context.Background(), []byte("second"), "audio/x-wav")
	if err != nil {
		t.Fatalf("Transcribe #2: %v", err)
	}
	if want := fakeTranscript(defaultModelID, len("second")); got2 != want {
		t.Fatalf("transcript #2 = %q, want %q", got2, want)
	}
	svc.mu.Lock()
	second := svc.sidecar
	svc.mu.Unlock()
	if second != first {
		t.Fatal("sidecar must be reused across transcriptions")
	}
}

// TestTranscribeAudioBase64: the binding entry decodes base64 and lands in
// the same pipeline; garbage base64 is a clear error.
func TestTranscribeAudioBase64(t *testing.T) {
	svc := newTestService(t, defaultModelID)
	audio := []byte("abc")

	got, err := svc.TranscribeAudio(base64.StdEncoding.EncodeToString(audio), "audio/wav")
	if err != nil {
		t.Fatalf("TranscribeAudio: %v", err)
	}
	if want := fakeTranscript(defaultModelID, len(audio)); got != want {
		t.Fatalf("transcript = %q, want %q", got, want)
	}
	if _, err := svc.TranscribeAudio("!!!not-base64!!!", "audio/wav"); err == nil {
		t.Fatal("invalid base64 must error")
	}
}

// TestTranscribeValidation: empty audio, non-audio MIME and oversize payloads
// are rejected before anything is spawned, carrying the client-fault
// sentinels the remote bridge maps to 4xx.
func TestTranscribeValidation(t *testing.T) {
	svc := newTestService(t, defaultModelID)
	if _, err := svc.Transcribe(context.Background(), nil, "audio/wav"); err == nil {
		t.Fatal("empty audio must error")
	}
	if _, err := svc.Transcribe(context.Background(), []byte("x"), "text/plain"); !errors.Is(err, ErrUnsupportedAudioType) {
		t.Fatalf("non-audio MIME err = %v, want ErrUnsupportedAudioType", err)
	}
	// A multipart part labeled video/* lands here too (#24308 review): the
	// same sentinel, not a downstream 500.
	if _, err := svc.Transcribe(context.Background(), []byte("x"), "video/mp4"); !errors.Is(err, ErrUnsupportedAudioType) {
		t.Fatalf("video/* MIME err = %v, want ErrUnsupportedAudioType", err)
	}
	if _, err := svc.Transcribe(context.Background(), make([]byte, maxAudioBytes+1), "audio/wav"); !errors.Is(err, ErrAudioTooLarge) {
		t.Fatalf("oversize audio err = %v, want ErrAudioTooLarge", err)
	}
	if st := svc.STTStatus(); st.SidecarRunning {
		t.Fatal("validation failures must not start a sidecar")
	}
}

// TestTranscribeNoModel / TestTranscribeNoServer: the two availability
// sentinels surface as-is (remote maps them to 503).
func TestTranscribeNoModel(t *testing.T) {
	svc := newTestService(t) // nothing downloaded
	_, err := svc.Transcribe(context.Background(), []byte("x"), "audio/wav")
	if !errors.Is(err, ErrNoModel) {
		t.Fatalf("err = %v, want ErrNoModel", err)
	}
}

func TestTranscribeNoServer(t *testing.T) {
	svc := newTestService(t, defaultModelID)
	svc.mu.Lock()
	svc.serverPath = "" // simulate "not found" (discoverFn is a no-op stub)
	svc.mu.Unlock()
	_, err := svc.Transcribe(context.Background(), []byte("x"), "audio/wav")
	if !errors.Is(err, ErrServerNotFound) {
		t.Fatalf("err = %v, want ErrServerNotFound", err)
	}
}

// TestSetSTTModelRestartsSidecar: switching the selection stops the running
// sidecar; the next Transcribe lazily restarts it bound to the new model.
func TestSetSTTModelRestartsSidecar(t *testing.T) {
	svc := newTestService(t, defaultModelID, "tiny.en-q5_1")
	if _, err := svc.Transcribe(context.Background(), []byte("go"), "audio/wav"); err != nil {
		t.Fatal(err)
	}

	if err := svc.SetSTTModel("tiny.en-q5_1"); err != nil {
		t.Fatalf("SetSTTModel: %v", err)
	}
	if st := svc.STTStatus(); st.SidecarRunning {
		t.Fatal("sidecar must be stopped after model switch")
	}

	got, err := svc.Transcribe(context.Background(), []byte("go2"), "audio/wav")
	if err != nil {
		t.Fatalf("Transcribe after switch: %v", err)
	}
	if want := fakeTranscript("tiny.en-q5_1", len("go2")); got != want {
		t.Fatalf("transcript = %q, want %q (new model)", got, want)
	}

	// Selection persisted: a fresh service on the same config restores it.
	svc2 := NewService(svc.cfg)
	if err := svc2.ServiceStartup(context.Background(), application.ServiceOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = svc2.ServiceShutdown() })
	if st := svc2.STTStatus(); st.ModelID != "tiny.en-q5_1" {
		t.Fatalf("restored model = %q, want tiny.en-q5_1", st.ModelID)
	}
}

// TestSetSTTModelUnknown: catalog-foreign ids are refused.
func TestSetSTTModelUnknown(t *testing.T) {
	svc := newTestService(t)
	if err := svc.SetSTTModel("gpt-4o"); err == nil {
		t.Fatal("unknown model id must error")
	}
}

// TestSidecarSelfHealsAfterDeath: SIGKILL the sidecar behind the service's
// back; the next Transcribe detects the corpse and respawns.
func TestSidecarSelfHealsAfterDeath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX process-group signals")
	}
	svc := newTestService(t, defaultModelID)
	if _, err := svc.Transcribe(context.Background(), []byte("one"), "audio/wav"); err != nil {
		t.Fatal(err)
	}

	svc.mu.Lock()
	sc := svc.sidecar
	svc.mu.Unlock()
	if err := syscall.Kill(sc.pgid, syscall.SIGKILL); err != nil {
		t.Fatalf("kill sidecar: %v", err)
	}
	select {
	case <-sc.done:
	case <-time.After(5 * time.Second):
		t.Fatal("sidecar did not exit after SIGKILL")
	}

	got, err := svc.Transcribe(context.Background(), []byte("two"), "audio/wav")
	if err != nil {
		t.Fatalf("Transcribe after sidecar death: %v", err)
	}
	if want := fakeTranscript(defaultModelID, len("two")); got != want {
		t.Fatalf("transcript = %q, want %q", got, want)
	}
	svc.mu.Lock()
	newSC := svc.sidecar
	svc.mu.Unlock()
	if newSC == sc {
		t.Fatal("a new sidecar instance must replace the killed one")
	}
	if err := syscall.Kill(newSC.pgid, 0); err != nil {
		t.Fatalf("new sidecar not alive: %v", err)
	}
}

// TestStopSTTSidecar: explicit stop kills the whole process group (§3.2) and
// is idempotent.
func TestStopSTTSidecar(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX process-group signals")
	}
	svc := newTestService(t, defaultModelID)
	if _, err := svc.Transcribe(context.Background(), []byte("x"), "audio/wav"); err != nil {
		t.Fatal(err)
	}
	svc.mu.Lock()
	sc := svc.sidecar
	svc.mu.Unlock()

	if err := svc.StopSTTSidecar(); err != nil {
		t.Fatalf("StopSTTSidecar: %v", err)
	}
	if st := svc.STTStatus(); st.SidecarRunning {
		t.Fatal("sidecar must not run after stop")
	}
	// Process group is really gone (signal 0 on -pgid fails with ESRCH).
	if err := syscall.Kill(-sc.pgid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("process group still alive after stop: %v", err)
	}
	if err := svc.StopSTTSidecar(); err != nil { // idempotent
		t.Fatalf("second StopSTTSidecar: %v", err)
	}
}

// TestStartSidecarHealthTimeout: a "server" that never serves /health fails
// readiness within the budget and is reaped (no leaked process).
func TestStartSidecarHealthTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX process-group signals")
	}
	cfg := config.TestConfig(t.TempDir())
	t.Setenv("MD_WHISPER_SERVER", "/usr/bin/false") // exits immediately
	svc := NewService(cfg)
	if err := svc.ServiceStartup(context.Background(), application.ServiceOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = svc.ServiceShutdown() })
	svc.discoverFn = func() {}
	svc.healthWait = 300 * time.Millisecond
	seedModel(t, svc, defaultModelID)

	start := time.Now()
	if _, err := svc.Transcribe(context.Background(), []byte("x"), "audio/wav"); err == nil {
		t.Fatal("transcribe against a dead server must fail")
	} else if !strings.Contains(err.Error(), "not ready") {
		t.Fatalf("err = %v, want readiness failure", err)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("readiness failure took %s, budget was 300ms", d)
	}
	svc.mu.Lock()
	sc := svc.sidecar
	svc.mu.Unlock()
	if sc != nil {
		t.Fatal("failed start must not leave a sidecar registered")
	}
}

// TestSTTStatusAndListModels: flags reflect server/model/download state.
// Selected tracks the EFFECTIVE selection (persisted or default).
func TestSTTStatusAndListModels(t *testing.T) {
	svc := newTestService(t, "tiny-q5_1")

	st := svc.STTStatus()
	if !st.ServerFound || st.ServerPath == "" {
		t.Fatalf("status server = %+v", st)
	}
	if st.ModelID != defaultModelID {
		t.Fatalf("default model = %q, want %q", st.ModelID, defaultModelID)
	}
	if st.ModelReady || st.Ready {
		t.Fatalf("default model not seeded: %+v", st)
	}

	models := svc.ListSTTModels()
	if len(models) != len(catalog) {
		t.Fatalf("ListSTTModels = %d entries, want %d", len(models), len(catalog))
	}
	byID := map[string]STTModel{}
	for _, m := range models {
		byID[m.ID] = m
	}
	if m := byID["tiny-q5_1"]; !m.Downloaded || m.Selected {
		t.Fatalf("tiny-q5_1 flags = downloaded:%v selected:%v (not the effective selection)", m.Downloaded, m.Selected)
	}
	if m := byID[defaultModelID]; m.Downloaded || !m.Selected {
		t.Fatalf("default entry flags = downloaded:%v selected:%v (effective default is selected)", m.Downloaded, m.Selected)
	}
}

// TestDeleteModelRules: selected model refused; other models' files removed;
// unknown ids rejected.
func TestDeleteModelRules(t *testing.T) {
	svc := newTestService(t, defaultModelID, "tiny-q5_1")

	if err := svc.DeleteSTTModel(defaultModelID); !errors.Is(err, ErrModelInUse) {
		t.Fatalf("delete selected = %v, want ErrModelInUse", err)
	}
	if err := svc.DeleteSTTModel("tiny-q5_1"); err != nil {
		t.Fatalf("delete other: %v", err)
	}
	if _, err := os.Stat(svc.modelPath("tiny-q5_1")); !os.IsNotExist(err) {
		t.Fatal("model file should be gone")
	}
	if err := svc.DeleteSTTModel("nope"); err == nil {
		t.Fatal("unknown id must error")
	}
}

// TestSetSTTServerPath: validation, persistence, sidecar restart on change.
func TestSetSTTServerPath(t *testing.T) {
	svc := newTestService(t, defaultModelID)

	if err := svc.SetSTTServerPath("/definitely/not/here"); err == nil {
		t.Fatal("nonexistent path must error")
	}
	dir := t.TempDir() // a directory: exists but not an executable file
	if err := svc.SetSTTServerPath(dir); err == nil {
		t.Fatal("directory must error")
	}

	fake := buildFakeServer(t)
	if err := svc.SetSTTServerPath(fake); err != nil {
		t.Fatalf("SetSTTServerPath: %v", err)
	}
	if st := svc.STTStatus(); st.ServerPath != fake {
		t.Fatalf("serverPath = %q, want %q", st.ServerPath, fake)
	}

	// Persisted: fresh startup on the same config picks the setting up even
	// with the env override cleared (setting beats PATH discovery).
	t.Setenv("MD_WHISPER_SERVER", "")
	svc2 := NewService(svc.cfg)
	if err := svc2.ServiceStartup(context.Background(), application.ServiceOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = svc2.ServiceShutdown() })
	if st := svc2.STTStatus(); st.ServerPath != fake {
		t.Fatalf("persisted serverPath = %q, want %q", st.ServerPath, fake)
	}

	// Clearing falls back to discovery (env empty + not on PATH → not found
	// here, but the field must be emptied deterministically via the stub).
	svc2.discoverFn = func() {}
	if err := svc2.SetSTTServerPath(""); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if st := svc2.STTStatus(); st.ServerFound {
		t.Fatalf("cleared serverPath should be empty, got %+v", st)
	}
}

// TestConcurrentTranscribesSerialize: parallel Transcribes share one sidecar
// (spawn is single-flighted) and all succeed.
func TestConcurrentTranscribesSerialize(t *testing.T) {
	svc := newTestService(t, defaultModelID)
	const n = 6
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = svc.Transcribe(context.Background(), []byte("zz"), "audio/wav")
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("concurrent Transcribe %d: %v", i, err)
		}
	}
	svc.mu.Lock()
	defer svc.mu.Unlock()
	if svc.sidecar == nil || !svc.sidecar.isAlive() {
		t.Fatal("exactly one live sidecar expected after concurrent start")
	}
}

// TestExtForMIME: the MIME→extension mapping for the multipart filename.
// Only whisper-native types reach here — webm/m4a/aac are transcoded (or
// rejected) before the mapping is consulted.
func TestExtForMIME(t *testing.T) {
	cases := map[string]string{
		"audio/wav":     ".wav",
		"audio/x-wav":   ".wav",
		"audio/mpeg":    ".mp3",
		"audio/flac":    ".flac",
		"audio/ogg":     ".ogg", // no-ffmpeg passthrough path
		"audio/x-zebra": ".wav", // unknown audio → whisper's safest default
	}
	for mt, want := range cases {
		if got := extForMIME(mt); got != want {
			t.Errorf("extForMIME(%q) = %q, want %q", mt, got, want)
		}
	}
}
