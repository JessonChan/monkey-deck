// Package stt provides the host-side speech-to-text backend (#131 phase 1):
// a whisper.cpp `whisper-server` sidecar pipeline plus local model management,
// exposed to the frontend via Wails3 bindings (TranscribeAudio & friends) and
// to remote browser/PWA clients via the embedded remote server's /api/stt.
//
// This is NOT an agent channel (§1.1 purity applies to agent harnesses only):
// whisper-server is a plain local subprocess owned by the host app, managed
// with the same process-group discipline as harnesses (§3.2: Setpgid + group
// kill, no stray reaping needed — the sidecar spawns no children).
//
// Phase 1 scope: backend only. No frontend UI yet.
package stt

// model.go: whisper.cpp GGML model catalog + download pipeline.
//
// Models are the ggerganov/whisper.cpp HF artifacts; they are re-downloadable
// caches, so they live under CachesDir (config semantics), never DataDir.
// Downloads stream to a `.part` file and rename atomically on success, so a
// killed download never leaves a half-written model that whisper would load.

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// progressEmitEvery throttles download progress events: emit at most once per
// received MiB (plus a final Done event). Keeps the event channel quiet on
// multi-GB models while still surfacing steady progress.
const progressEmitEvery = 1 << 20

// defaultModelID is the effective selection when nothing is persisted: the
// smallest English model with usable accuracy (57 MB) — right size for
// dictation without a heavy first download.
const defaultModelID = "base.en-q5_1"

// defaultBaseURL is the canonical whisper.cpp model distribution (HF).
const defaultBaseURL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

// Model is one catalog entry. SizeBytes is approximate (display/progress
// fallback only; readiness is decided by the file's presence, not its size).
type Model struct {
	ID        string `json:"id"`              // catalog id, e.g. "base.en-q5_1"
	File      string `json:"file"`            // ggml file name on the download host
	Label     string `json:"label"`           // human label, e.g. "Base (English)"
	Lang      string `json:"lang"`            // "en" | "multi"
	Quant     string `json:"quant,omitempty"` // "" = full precision (F16)
	SizeBytes int64  `json:"sizeBytes"`       // approximate on-disk size
}

// catalog is the curated download list. Quantized q5_1/q5_0 variants keep
// desktop resource use sane; large-v3 family covers quality-demanding users.
var catalog = []Model{
	{ID: "tiny.en-q5_1", File: "ggml-tiny.en-q5_1.bin", Label: "Tiny (English)", Lang: "en", Quant: "Q5_1", SizeBytes: 31 << 20},
	{ID: "base.en-q5_1", File: "ggml-base.en-q5_1.bin", Label: "Base (English)", Lang: "en", Quant: "Q5_1", SizeBytes: 57 << 20},
	{ID: "small.en-q5_1", File: "ggml-small.en-q5_1.bin", Label: "Small (English)", Lang: "en", Quant: "Q5_1", SizeBytes: 181 << 20},
	{ID: "large-v3-turbo-q5_0", File: "ggml-large-v3-turbo-q5_0.bin", Label: "Large v3 Turbo (English)", Lang: "en", Quant: "Q5_0", SizeBytes: 574 << 20},
	{ID: "large-v3-turbo", File: "ggml-large-v3-turbo.bin", Label: "Large v3 Turbo (English)", Lang: "en", SizeBytes: 1624 << 20},
	{ID: "tiny-q5_1", File: "ggml-tiny-q5_1.bin", Label: "Tiny (multilingual)", Lang: "multi", Quant: "Q5_1", SizeBytes: 31 << 20},
	{ID: "base-q5_1", File: "ggml-base-q5_1.bin", Label: "Base (multilingual)", Lang: "multi", Quant: "Q5_1", SizeBytes: 57 << 20},
	{ID: "small-q5_1", File: "ggml-small-q5_1.bin", Label: "Small (multilingual)", Lang: "multi", Quant: "Q5_1", SizeBytes: 181 << 20},
	{ID: "large-v3", File: "ggml-large-v3.bin", Label: "Large v3 (multilingual)", Lang: "multi", SizeBytes: 3090 << 20},
}

// Models returns the catalog (ordered small → large, English first).
func Models() []Model { return catalog }

// modelByID looks up a catalog entry; nil when unknown.
func modelByID(id string) *Model {
	for i := range catalog {
		if catalog[i].ID == id {
			return &catalog[i]
		}
	}
	return nil
}

// DefaultModelID returns the effective default selection.
func DefaultModelID() string { return defaultModelID }

// modelPath returns the local file path for a model id (whether or not it
// has been downloaded yet).
func (s *Service) modelPath(id string) string {
	m := modelByID(id)
	if m == nil {
		return ""
	}
	return filepath.Join(s.modelsDir, m.File)
}

// downloadModel streams a catalog model to modelsDir with atomic rename.
// Emits throttled EventProgress payloads. Idempotent: an already-present
// model is a no-op success.
func (s *Service) downloadModel(ctx context.Context, id string) error {
	m := modelByID(id)
	if m == nil {
		return fmt.Errorf("stt: unknown model %q", id)
	}
	dest := filepath.Join(s.modelsDir, m.File)
	if _, err := os.Stat(dest); err == nil {
		return nil // already downloaded
	}
	if err := os.MkdirAll(s.modelsDir, 0o700); err != nil {
		return fmt.Errorf("stt: create models dir: %w", err)
	}

	// Serialize downloads: two concurrent calls for the same (or different)
	// models must not interleave .part writes or spam progress events.
	s.downMu.Lock()
	defer s.downMu.Unlock()

	// Re-check after acquiring: a concurrent download may have finished it.
	if _, err := os.Stat(dest); err == nil {
		return nil
	}

	part := dest + ".part"
	url := strings.TrimSuffix(s.baseURL, "/") + "/" + m.File
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("stt: download %s: %w", id, err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("stt: download %s: %w", id, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("stt: download %s: status %d", id, resp.StatusCode)
	}

	f, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("stt: download %s: %w", id, err)
	}

	total := resp.ContentLength // may be -1 (unknown): progress falls back to 0
	var received int64
	var lastEmit int64
	buf := make([]byte, 64<<10)
	emit := func(done bool, errMsg string) {
		s.emitProgress(ProgressPayload{ModelID: id, Received: received, Total: total, Done: done, Err: errMsg})
	}
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			received += int64(n)
			if _, werr := f.Write(buf[:n]); werr != nil {
				f.Close()
				_ = os.Remove(part)
				return fmt.Errorf("stt: download %s: %w", id, werr)
			}
			if received-lastEmit >= progressEmitEvery { // throttle: 1 MiB deltas
				lastEmit = received
				emit(false, "")
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			_ = os.Remove(part)
			emit(true, rerr.Error())
			return fmt.Errorf("stt: download %s: %w", id, rerr)
		}
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(part)
		return fmt.Errorf("stt: download %s: %w", id, err)
	}
	if total > 0 && received != total {
		_ = os.Remove(part)
		err := fmt.Errorf("stt: download %s: short read (%d/%d bytes)", id, received, total)
		emit(true, err.Error())
		return err
	}
	if err := os.Rename(part, dest); err != nil {
		_ = os.Remove(part)
		return fmt.Errorf("stt: download %s: %w", id, err)
	}
	emit(true, "")
	slog.Info("stt model downloaded", "id", id, "bytes", received)
	return nil
}

// deleteModel removes a downloaded model file (and any leftover .part).
func (s *Service) deleteModel(id string) error {
	m := modelByID(id)
	if m == nil {
		return fmt.Errorf("stt: unknown model %q", id)
	}
	for _, p := range []string{filepath.Join(s.modelsDir, m.File), filepath.Join(s.modelsDir, m.File) + ".part"} {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("stt: delete %s: %w", id, err)
		}
	}
	return nil
}
