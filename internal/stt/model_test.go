package stt

// model_test.go: model catalog invariants + the download pipeline against a
// local httptest origin (no real network, §5.3/#131 fake-origin strategy).

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// newDownloadTestService wires a service whose download origin is a local
// httptest server serving `payload` for every model file.
func newDownloadTestService(t *testing.T, handler http.HandlerFunc) *Service {
	t.Helper()
	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)
	cfg := config.TestConfig(t.TempDir())
	if err := cfg.EnsureDir(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MD_WHISPER_SERVER", filepath.Join(t.TempDir(), "no-server")) // hermetic discovery
	svc := NewService(cfg)
	svc.baseURL = ts.URL
	if err := svc.ServiceStartup(context.Background(), application.ServiceOptions{}); err != nil {
		t.Fatalf("startup: %v", err)
	}
	t.Cleanup(func() { _ = svc.ServiceShutdown() })
	return svc
}

// captureProgress records the last progress event per model.
type progressSink struct {
	mu   sync.Mutex
	last map[string]ProgressPayload
}

func (p *progressSink) hook(name string, data any) {
	if pl, ok := data.(ProgressPayload); ok {
		p.mu.Lock()
		p.last[pl.ModelID] = pl
		p.mu.Unlock()
	}
}

// TestDownloadModelSucceeds: 200 + Content-Length → file lands atomically,
// progress ends Done with matching totals, second call is a no-op.
func TestDownloadModelSucceeds(t *testing.T) {
	payload := make([]byte, 3*progressEmitEvery+123) // force several progress ticks
	svc := newDownloadTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprint(len(payload)))
		_, _ = w.Write(payload)
	})
	sink := &progressSink{last: map[string]ProgressPayload{}}
	svc.emitHook = sink.hook

	if err := svc.DownloadSTTModel("tiny.en-q5_1"); err != nil {
		t.Fatalf("download: %v", err)
	}
	got, err := os.ReadFile(svc.modelPath("tiny.en-q5_1"))
	if err != nil {
		t.Fatalf("model file: %v", err)
	}
	if len(got) != len(payload) {
		t.Fatalf("downloaded %d bytes, want %d", len(got), len(payload))
	}
	if _, err := os.Stat(svc.modelPath("tiny.en-q5_1") + ".part"); !os.IsNotExist(err) {
		t.Fatal(".part file must be renamed away on success")
	}

	last := sink.last["tiny.en-q5_1"]
	if !last.Done || last.Err != "" || last.Received != int64(len(payload)) || last.Total != int64(len(payload)) {
		t.Fatalf("final progress = %+v", last)
	}

	// Idempotent: file exists → immediate success, no re-download.
	if err := svc.DownloadSTTModel("tiny.en-q5_1"); err != nil {
		t.Fatalf("re-download: %v", err)
	}
}

// TestDownloadModelHTTPFailure: non-200 surfaces the status and leaves no
// partial file behind.
func TestDownloadModelHTTPFailure(t *testing.T) {
	svc := newDownloadTestService(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusNotFound)
	})
	err := svc.DownloadSTTModel("small.en-q5_1")
	if err == nil {
		t.Fatal("404 must fail the download")
	}
	if _, statErr := os.Stat(svc.modelPath("small.en-q5_1")); !os.IsNotExist(statErr) {
		t.Fatal("failed download must not leave a model file")
	}
	if _, statErr := os.Stat(svc.modelPath("small.en-q5_1") + ".part"); !os.IsNotExist(statErr) {
		t.Fatal("failed download must clean the .part file")
	}
}

// TestDownloadModelUnknownID: catalog-foreign ids are refused before any I/O.
func TestDownloadModelUnknownID(t *testing.T) {
	svc := newDownloadTestService(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("handler must not be reached for unknown ids")
	})
	if err := svc.DownloadSTTModel("nope"); err == nil {
		t.Fatal("unknown id must error")
	}
}

// TestCatalogInvariants: unique ids/files, default resolvable, known sizes sane.
func TestCatalogInvariants(t *testing.T) {
	ids := map[string]bool{}
	files := map[string]bool{}
	for _, m := range catalog {
		if m.ID == "" || m.File == "" || m.Label == "" {
			t.Fatalf("incomplete entry %+v", m)
		}
		if ids[m.ID] {
			t.Fatalf("duplicate id %q", m.ID)
		}
		if files[m.File] {
			t.Fatalf("duplicate file %q", m.File)
		}
		ids[m.ID], files[m.File] = true, true
		if m.Lang != "en" && m.Lang != "multi" {
			t.Fatalf("lang %q must be en|multi", m.Lang)
		}
		if m.SizeBytes <= 0 {
			t.Fatalf("size for %q must be positive", m.ID)
		}
		if m.File != "ggml-"+m.ID+".bin" {
			t.Fatalf("file/id convention broken for %+v", m)
		}
	}
	if modelByID(defaultModelID) == nil {
		t.Fatal("default model id must exist in the catalog")
	}
}
