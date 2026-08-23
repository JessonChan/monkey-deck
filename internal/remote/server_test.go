package remote

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/url"
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
	srv, base, _ := startTestServer(t)

	if resp := get(t, base+"/health"); resp.StatusCode != http.StatusOK {
		t.Fatalf("/health = %d, want 200", resp.StatusCode)
	}

	for _, path := range []string{"/", "/wails/custom.js", "/wails/events"} {
		if resp := get(t, base+path); resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s unauthenticated = %d, want 401", path, resp.StatusCode)
		}
	}

	// Cookie auth: pair a session first, then use its cookie.
	code, sid, _ := srv.GeneratePairingCode()
	presp, perr := postPairRaw(base, sid, code)
	if perr != nil {
		t.Fatalf("pair: %v", perr)
	}
	sessID := ""
	for _, c := range presp.Cookies() {
		if c.Name == "md_remote_session" {
			sessID = c.Value
		}
	}
	req, _ := http.NewRequest("GET", base+"/", nil)
	req.AddCookie(&http.Cookie{Name: "md_remote_session", Value: sessID})
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

	// Unknown session id rejected.
	req3, _ := http.NewRequest("GET", base+"/", nil)
	req3.AddCookie(&http.Cookie{Name: "md_remote_session", Value: "deadbeefdeadbeefdeadbeefdeadbeef"})
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

	code, sid, expires := srv.GeneratePairingCode()
	if len(code) != 6 || len(sid) != 32 || !expires.After(time.Now()) {
		t.Fatalf("pairing = code %q sid %q exp %v, want 6 digits + 32-hex sid + future expiry", code, sid, expires)
	}

	// sid alone (GET) serves the entry page; it must NOT pair.
	entry := get(t, base+"/pair?sid="+sid)
	if entry.StatusCode != http.StatusOK || entry.Body == nil {
		t.Fatalf("entry page = %d, want 200", entry.StatusCode)
	}
	entryBody, _ := io.ReadAll(entry.Body)
	if !bytes.Contains(entryBody, []byte(`name="sid" value="`+sid+`"`)) {
		t.Fatal("entry page must embed the sid as a hidden field")
	}

	resp, err := postPairRaw(base, sid, code)
	if err != nil {
		t.Fatalf("pair: %v", err)
	}
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("pair = %d, want 302", resp.StatusCode)
	}
	var got string
	for _, c := range resp.Cookies() {
		if c.Name == "md_remote_session" {
			got = c.Value
		}
	}
	if got == "" || got == "secret-token" || len(got) != 32 {
		t.Fatalf("pair cookie = %q, want a fresh 128-bit session id", got)
	}

	// The session cookie actually authorizes (session registry path).
	reqAuth, _ := http.NewRequest("GET", base+"/", nil)
	reqAuth.AddCookie(&http.Cookie{Name: "md_remote_session", Value: got})
	respAuth, err2 := http.DefaultClient.Do(reqAuth)
	if err2 != nil || respAuth.StatusCode != http.StatusOK {
		t.Fatalf("session cookie auth = %v/%d, want nil/200", err2, respAuth.StatusCode)
	}

	// Exactly one session registered, labeled from the UA.
	sessions := srv.ListSessions()
	if len(sessions) != 1 || sessions[0].ID != got || sessions[0].Label == "" {
		t.Fatalf("sessions = %+v, want exactly the paired one", sessions)
	}

	// Single use: the same code is dead immediately.
	if resp := get(t, base+"/pair?code="+code); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("reused code = %d, want 401", resp.StatusCode)
	}

	// Attempt cap: fresh attempt, 5 wrong code guesses (valid sid) kill it.
	code2, sid2, _ := srv.GeneratePairingCode()
	for i := range pairingMaxFails {
		if resp := postPair(t, base, sid2, "000000"); resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("wrong guess %d = %d, want 401", i, resp.StatusCode)
		}
	}
	if resp := postPair(t, base, sid2, code2); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("code after %d fails = %d, want 401 (capped)", pairingMaxFails, resp.StatusCode)
	}

	// 2-of-2 negatives: right code + WRONG sid fails; code alone (no sid)
	// fails; the sid-less root page carries no input at all.
	srv2code, srv2sid, _ := srv.GeneratePairingCode()
	if r := postPair(t, base, "0123456789abcdef0123456789abcdef", srv2code); r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("right code wrong sid = %d, want 401", r.StatusCode)
	}
	if r := postPair(t, base, "", srv2code); r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("code without sid = %d, want 401", r.StatusCode)
	}
	if r := get(t, base+"/pair?sid=0123456789abcdef0123456789abcdef"); r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unknown sid entry = %d, want 401", r.StatusCode)
	}
	// The valid sid still pairs after those failed attempts (fails were
	// counted against code guesses on OTHER sids / empty — sid mismatch
	// does not burn attempts; code guesses here were zero).
	if r := postPair(t, base, srv2sid, srv2code); r.StatusCode != http.StatusFound {
		t.Fatalf("valid pair after negatives = %d, want 302", r.StatusCode)
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
	// Informational only: no code input on the sid-less page (2-of-2).
	if resp.StatusCode != http.StatusOK || bytes.Contains(body, []byte(`name="code"`)) {
		t.Fatalf("browser / = %d, want 200 info page WITHOUT code input", resp.StatusCode)
	}
	if !bytes.Contains(body, []byte("尚未配对")) {
		t.Fatal("root page should explain pairing is required")
	}

	if resp := get(t, base+"/"); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("native / = %d, want 401", resp.StatusCode)
	}
}


// TestSessionRevoke: individual kick + kill switch.
func TestSessionRevoke(t *testing.T) {
	srv, base, _ := startTestServer(t)

	pair := func() string {
		code, sid, _ := srv.GeneratePairingCode()
		resp, err := postPairRaw(base, sid, code)
		if err != nil {
			t.Fatalf("pair: %v", err)
		}
		for _, ck := range resp.Cookies() {
			if ck.Name == "md_remote_session" {
				return ck.Value
			}
		}
		return ""
	}
	a, b := pair(), pair()
	if len(srv.ListSessions()) != 2 {
		t.Fatalf("sessions = %d, want 2", len(srv.ListSessions()))
	}

	// Revoke a → its cookie dies, b keeps working.
	if !srv.RevokeSession(a) {
		t.Fatal("revoke(a) = false, want true")
	}
	reqA, _ := http.NewRequest("GET", base+"/", nil)
	reqA.AddCookie(&http.Cookie{Name: "md_remote_session", Value: a})
	if resp, _ := http.DefaultClient.Do(reqA); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("revoked a = %d, want 401", resp.StatusCode)
	}
	reqB, _ := http.NewRequest("GET", base+"/", nil)
	reqB.AddCookie(&http.Cookie{Name: "md_remote_session", Value: b})
	if resp, _ := http.DefaultClient.Do(reqB); resp.StatusCode != http.StatusOK {
		t.Fatalf("surviving b = %d, want 200", resp.StatusCode)
	}

	// Kill switch: everything dies.
	srv.RevokeAllSessions()
	if resp, _ := http.DefaultClient.Do(reqB); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("after revokeAll b = %d, want 401", resp.StatusCode)
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


// postPair submits the 2-of-2 pair as a form POST (sid+code in the body).
func postPair(t *testing.T, base, sid, code string) *http.Response {
	t.Helper()
	resp, err := postPairRaw(base, sid, code)
	if err != nil {
		t.Fatalf("postPair: %v", err)
	}
	return resp
}

func postPairRaw(base, sid, code string) (*http.Response, error) {
	c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	form := url.Values{"sid": {sid}, "code": {code}}
	return c.PostForm(base+"/pair", form)
}
