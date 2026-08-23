package remote

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// stubTransport implements transportHandler with a marker so tests can assert
// the binding middleware actually wraps the asset chain.
type stubTransport struct{ hit *bool }

func (s stubTransport) Handler() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/wails/runtime") {
				*s.hit = true
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"stub":true}`))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func newTestServer(t *testing.T) (*Server, *bool) {
	t.Helper()
	bindingHit := new(bool)
	s := New(Options{
		Transport: stubTransport{hit: bindingHit},
		Assets: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte("<html>app</html>"))
		}),
		Token:      func() string { return "secret-token" },
		EventNames: []string{"chat:event"},
	})
	return s, bindingHit
}

// startTestServer starts on an ephemeral port and returns the base URL.
func startTestServer(t *testing.T) (*Server, string, *bool) {
	t.Helper()
	s, hit := newTestServer(t)
	if err := s.Start(0); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(s.Stop)
	return s, "http://127.0.0.1:" + strings.TrimPrefix(s.Addr(), "0.0.0.0:"), hit
}

func get(t *testing.T, url string) *http.Response {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	return resp
}

// TestAuthGating: /health is open; everything else 401s without credentials;
// cookie and Bearer both authenticate.
func TestAuthGating(t *testing.T) {
	_, base, _ := startTestServer(t)

	if resp := get(t, base+"/health"); resp.StatusCode != http.StatusOK {
		t.Fatalf("/health = %d, want 200", resp.StatusCode)
	}

	for _, path := range []string{"/", "/wails/custom.js", "/wails/events"} {
		if resp := get(t, base+path); resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s unauthenticated = %d, want 401", path, resp.StatusCode)
		}
	}

	// Cookie auth.
	req, _ := http.NewRequest("GET", base+"/", nil)
	req.AddCookie(&http.Cookie{Name: CookieName, Value: "secret-token"})
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("cookie auth = %v/%d, want nil/200", err, resp.StatusCode)
	}

	// Bearer auth.
	req2, _ := http.NewRequest("GET", base+"/", nil)
	req2.Header.Set("Authorization", "Bearer secret-token")
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil || resp2.StatusCode != http.StatusOK {
		t.Fatalf("bearer auth = %v/%d, want nil/200", err, resp2.StatusCode)
	}

	// Wrong token rejected.
	req3, _ := http.NewRequest("GET", base+"/", nil)
	req3.AddCookie(&http.Cookie{Name: CookieName, Value: "wrong"})
	resp3, _ := http.DefaultClient.Do(req3)
	if resp3.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong token = %d, want 401", resp3.StatusCode)
	}
}

// TestPairingLifecycle: the complete one-time-code bootstrap flow —
// generate → exchange for cookie → code consumed → attempts capped →
// expiry → wrong-code handling for browsers (HTML) vs native (plain 401).
func TestPairingLifecycle(t *testing.T) {
	srv, base, _ := startTestServer(t)

	code, expires := srv.GeneratePairingCode()
	if len(code) != 6 || !expires.After(time.Now()) {
		t.Fatalf("pairing code = %q/%v, want 6 digits + future expiry", code, expires)
	}

	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Get(base + "/pair?code=" + code)
	if err != nil {
		t.Fatalf("pair: %v", err)
	}
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("pair = %d, want 302", resp.StatusCode)
	}
	var got string
	for _, c := range resp.Cookies() {
		if c.Name == CookieName {
			got = c.Value
		}
	}
	if got != "secret-token" {
		t.Fatalf("pair cookie = %q, want the long-term token", got)
	}

	// Single use: the same code is dead immediately.
	if resp := get(t, base+"/pair?code="+code); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("reused code = %d, want 401", resp.StatusCode)
	}

	// Attempt cap: fresh code, 5 wrong guesses kill it before the right one.
	code2, _ := srv.GeneratePairingCode()
	for i := range pairingMaxFails {
		if resp := get(t, base+"/pair?code=000000"); resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("wrong guess %d = %d, want 401", i, resp.StatusCode)
		}
	}
	if resp := get(t, base+"/pair?code="+code2); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("code after %d fails = %d, want 401 (capped)", pairingMaxFails, resp.StatusCode)
	}

	// Wrong code on a browser flow returns the HTML error page.
	srv.GeneratePairingCode()
	req, _ := http.NewRequest("GET", base+"/pair?code=999999", nil)
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	respHTML, _ := http.DefaultClient.Do(req)
	body, _ := io.ReadAll(respHTML.Body)
	if respHTML.StatusCode != http.StatusUnauthorized || !bytes.Contains(body, []byte("配对码无效")) {
		t.Fatalf("browser wrong code = %d/%q, want 401 + HTML page", respHTML.StatusCode, body[:min(60, len(body))])
	}
}

// TestPairingLoginPage: unauthenticated browser "/" gets the pairing form;
// native clients keep the plain 401.
func TestPairingLoginPage(t *testing.T) {
	_, base, _ := startTestServer(t)

	req, _ := http.NewRequest("GET", base+"/", nil)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	resp, _ := http.DefaultClient.Do(req)
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || !bytes.Contains(body, []byte(`action="/pair"`)) {
		t.Fatalf("browser / = %d, want 200 pairing form", resp.StatusCode)
	}

	if resp := get(t, base+"/"); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("native / = %d, want 401", resp.StatusCode)
	}
}


// TestRootChain: authenticated / serves assets through the transport middleware;
// /wails/runtime is intercepted by the binding middleware.
func TestRootChain(t *testing.T) {
	_, base, hit := startTestServer(t)

	req, _ := http.NewRequest("GET", base+"/", nil)
	req.Header.Set("Authorization", "Bearer secret-token")
	resp, _ := http.DefaultClient.Do(req)
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "app") {
		t.Fatalf("/ = %d %q, want asset html", resp.StatusCode, body)
	}
	if *hit {
		t.Fatalf("binding middleware hit on / — should pass through")
	}

	post, _ := http.NewRequest("POST", base+"/wails/runtime", strings.NewReader("{}"))
	post.Header.Set("Authorization", "Bearer secret-token")
	resp2, _ := http.DefaultClient.Do(post)
	if resp2.StatusCode != http.StatusOK || !*hit {
		t.Fatalf("/wails/runtime dispatch failed (%d, hit=%v)", resp2.StatusCode, *hit)
	}
}

// TestCustomJSServedAuthenticated verifies the browser bootstrap endpoint.
func TestCustomJSServedAuthenticated(t *testing.T) {
	_, base, _ := startTestServer(t)
	req, _ := http.NewRequest("GET", base+"/wails/custom.js", nil)
	req.Header.Set("Authorization", "Bearer secret-token")
	resp, _ := http.DefaultClient.Do(req)
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "remote:resync") {
		t.Fatalf("custom.js = %d %q", resp.StatusCode, body)
	}
}

// TestHubFanout: two WS clients both receive a bridged event with the exact
// CustomEvent JSON shape; Stop closes connections.
func TestHubFanout(t *testing.T) {
	s, base, _ := startTestServer(t)
	hdr := http.Header{"Authorization": {"Bearer secret-token"}}
	c1, _, err := websocket.Dial(context.Background(), "ws://"+strings.TrimPrefix(base, "http://")+"/wails/events", &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		t.Fatalf("dial1: %v", err)
	}
	defer c1.CloseNow()
	c2, _, err := websocket.Dial(context.Background(), "ws://"+strings.TrimPrefix(base, "http://")+"/wails/events", &websocket.DialOptions{HTTPHeader: hdr})
	defer c2.CloseNow()

	s.hub.broadcast(&application.CustomEvent{Name: "chat:event", Data: map[string]any{"n": 1}})

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, msg1, err := c1.Read(ctx)
	if err != nil {
		t.Fatalf("read1: %v", err)
	}
	if !strings.Contains(string(msg1), `"name":"chat:event"`) || !strings.Contains(string(msg1), `"n":1`) {
		t.Fatalf("msg1 = %s, want chat:event JSON", msg1)
	}
	if _, msg2, err := c2.Read(ctx); err != nil || !strings.Contains(string(msg2), "chat:event") {
		t.Fatalf("msg2 = %s err=%v, want fanout to second client", msg2, err)
	}

	// Stop tears clients down.
	s.Stop()
	readCtx, readCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer readCancel()
	if _, _, err := c1.Read(readCtx); err == nil {
		t.Fatalf("expected connection closed after Stop")
	}
}
