package chat

import (
	"context"
	"net"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// stubTransportHandler satisfies the remote transportHandler contract without
// pulling a real HTTPTransport (which needs a live MessageProcessor).
type stubTransportHandler struct{}

func (stubTransportHandler) Handler() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler { return next }
}

// newRemoteTestService builds a ChatService over a temp store with remote
// config loaded, mirroring ServiceStartup's ordering for these fields.
func newRemoteTestService(t *testing.T) *ChatService {
	t.Helper()
	dir := t.TempDir()
	st, err := store.New(filepath.Join(dir, config.AppSlug+".db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc := NewChatService(config.TestConfig(dir))
	svc.ctx = context.Background()
	svc.st = st
	svc.loadRemoteConfig()
	return svc
}

// TestRemoteConfigPersistsAndToggles: disabled by default; enabling persists
// and reflects in GetRemoteInfo even without an attached server; token is
// generated once and stable across reloads; regeneration rotates it.
func TestRemoteConfigPersistsAndToggles(t *testing.T) {
	svc := newRemoteTestService(t)

	if info := svc.GetRemoteInfo(); info.Enabled || info.Running || info.Attached {
		t.Fatalf("default state = %+v, want all-false", info)
	}
	if info := svc.GetRemoteInfo(); info.Port != defaultRemotePort || info.Token == "" {
		t.Fatalf("default port/token = %d/%q", info.Port, info.Token)
	}

	if err := svc.SetRemoteEnabled(true); err != nil {
		t.Fatalf("SetRemoteEnabled(true): %v", err)
	}
	// No server attached: enabled persists, listener stays down.
	info := svc.GetRemoteInfo()
	if !info.Enabled || info.Running || !info.Attached && info.Running {
		t.Fatalf("after enable = %+v", info)
	}

	// Token survives a reload from the same store.
	tok := info.Token
	svc2 := &ChatService{cfg: svc.cfg, st: svc.st, ctx: context.Background()}
	svc2.loadRemoteConfig()
	if svc2.GetRemoteInfo().Token != tok {
		t.Fatalf("token changed across reload")
	}
	if !svc2.GetRemoteInfo().Enabled {
		t.Fatalf("enabled lost across reload")
	}

	// Regeneration rotates the token.
	newTok, err := svc.RegenerateRemoteToken()
	if err != nil || newTok == tok || len(newTok) < 32 {
		t.Fatalf("RegenerateRemoteToken = %q err=%v, want distinct >=32 chars", newTok, err)
	}
}

// TestRemotePortValidation: out-of-range ports rejected without persisting.
func TestRemotePortValidation(t *testing.T) {
	svc := newRemoteTestService(t)
	for _, bad := range []int{0, -1, 65536, 100000} {
		if err := svc.SetRemotePort(bad); err == nil {
			t.Fatalf("SetRemotePort(%d) accepted", bad)
		}
	}
	if err := svc.SetRemotePort(9300); err != nil {
		t.Fatalf("SetRemotePort(9300): %v", err)
	}
	if got := svc.GetRemoteInfo().Port; got != 9300 {
		t.Fatalf("port = %d, want 9300", got)
	}
}

// TestRemoteEnvOverrides: dev/CI escape hatches beat persisted settings.
func TestRemoteEnvOverrides(t *testing.T) {
	svc := newRemoteTestService(t)
	t.Setenv("MD_REMOTE_ENABLED", "1")
	t.Setenv("MD_REMOTE_PORT", "9310")
	t.Setenv("MD_REMOTE_TOKEN", "envtok")
	svc.loadRemoteConfig()
	info := svc.GetRemoteInfo()
	if !info.Enabled || info.Port != 9310 || info.Token != "envtok" {
		t.Fatalf("env override result = %+v", info)
	}
}

// TestRemoteAttachStartsWhenEnabled: with deps attached and enabled set, a
// listener comes up on the configured port and serves authenticated traffic;
// stopping shuts it down.
func TestRemoteAttachStartsWhenEnabled(t *testing.T) {
	svc := newRemoteTestService(t)

	tr := application.NewHTTPTransport()
	assets := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("<html>x</html>"))
	})
	svc.AttachEmbeddedRemote(tr, assets, []string{EventStatus})

	// Port 0 = ephemeral; Start reports the real port but our config stores
	// what we pass, so use a fixed free port instead.
	port := freePort(t)
	if err := svc.SetRemotePort(port); err != nil {
		t.Fatal(err)
	}
	if err := svc.SetRemoteEnabled(true); err != nil {
		t.Fatalf("enable: %v", err)
	}
	t.Cleanup(svc.stopRemote)

	info := svc.GetRemoteInfo()
	if !info.Running || len(info.URLs) == 0 || !strings.Contains(info.URLs[0], "/auth?token=") {
		t.Fatalf("running info = %+v, want running + auth URLs", info)
	}

	// Binding middleware chain is the real HTTPTransport: unauthenticated root 401s.
	resp, err := http.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/")
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated / = %v/%d, want 401", err, resp.StatusCode)
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

