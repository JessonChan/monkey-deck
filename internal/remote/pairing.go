package remote
import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/binary"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)
// (valid pairingTTL, single use, max pairingMaxFails wrong attempts); /pair
// exchanges it for the 365-day HttpOnly cookie. A leaked pairing link is
// worthless once used or expired. The token remains available for the
// "Authorization: Bearer" path (native clients) via the settings UI.

const (
	pairingTTL      = 10 * time.Minute
	pairingMaxFails = 5
)

// pairingState holds the single active pairing code. Locked by its own mutex;
// zero value = no active code.
type pairingState struct {
	mu      sync.Mutex
	code    string
	expires time.Time
	fails   int
	used    bool
}

// GeneratePairingCode replaces any active code with a fresh 6-digit one-time
// code. Called from the settings UI binding only; the previous code dies on
// replacement.
func (s *Server) GeneratePairingCode() (code string, expires time.Time) {
	s.pairing.mu.Lock()
	defer s.pairing.mu.Unlock()
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand failing is unrecoverable; fall back to a time-seeded
		// value rather than panicking inside the UI call.
		binary.LittleEndian.PutUint32(b[:], uint32(time.Now().UnixNano()))
	}
	s.pairing.code = fmt.Sprintf("%06d", binary.LittleEndian.Uint32(b[:])%1000000)
	s.pairing.expires = time.Now().Add(pairingTTL)
	s.pairing.fails = 0
	s.pairing.used = false
	return s.pairing.code, s.pairing.expires
}

// verifyPairing attempts a code: constant-time compare, attempt-capped,
// single-use. Empty codes do not burn attempts (they are not guesses).
func (s *Server) verifyPairing(v string) bool {
	s.pairing.mu.Lock()
	defer s.pairing.mu.Unlock()
	p := &s.pairing
	if p.code == "" || p.used || p.fails >= pairingMaxFails || time.Now().After(p.expires) {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(v), []byte(p.code)) != 1 {
		if v != "" {
			p.fails++
		}
		return false
	}
	p.used = true
	return true
}

// handlePair exchanges ?code= (query or form field) for the long-lived auth
// cookie, then redirects to the app. Auth-exempt like the old /auth.
func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" && r.Method == http.MethodPost {
		_ = r.ParseForm()
		code = r.PostFormValue("code")
	}
	if !s.verifyPairing(code) {
		if strings.Contains(r.Header.Get("Accept"), "text/html") {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(pairingErrPage))
		} else {
			http.Error(w, "invalid or expired pairing code", http.StatusUnauthorized)
		}
		return
	}
	// Pairing issues an INDEPENDENT per-device session (cookie no longer
	// carries the master token): listable, individually revocable, and a
	// stolen cookie is not the master key.
	sess := s.sessions.issue(r.UserAgent())
	http.SetCookie(w, sessionCookie(sess.ID))
	http.Redirect(w, r, "/", http.StatusFound)
}

// pairingLoginPage is served (200) to unauthenticated BROWSER navigations of
// "/" — a minimal self-contained form asking for the one-time code. Native
// clients (curl, Accept without text/html) keep getting plain 401. No assets,
// no info beyond the app name.
const pairingLoginPage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Monkey Deck · 配对</title>
<style>
  body { margin:0; min-height:100dvh; display:flex; align-items:center; justify-content:center;
         background:#1a1a1c; color:#e8e8ea; font-family:-apple-system,"SF Pro Text",sans-serif; }
  .card { width:min(320px,86vw); background:#232326; border:1px solid #3a3a3e; border-radius:14px;
          padding:28px 24px; text-align:center; }
  h1 { font-size:17px; margin:0 0 6px; }
  p { font-size:12.5px; color:#9a9aa0; margin:0 0 18px; line-height:1.5; }
  input { width:100%; box-sizing:border-box; padding:12px; font-size:22px; letter-spacing:8px;
          text-align:center; border-radius:10px; border:1px solid #4a4a50; background:#1a1a1c;
          color:#e8e8ea; outline:none; }
  input:focus { border-color:#0a84ff; }
  button { margin-top:14px; width:100%; padding:12px; font-size:15px; font-weight:600;
           border:none; border-radius:10px; background:#0a84ff; color:#fff; cursor:pointer; }
</style>
</head>
<body>
  <form class="card" method="get" action="/pair">
    <h1>Monkey Deck</h1>
    <p>请输入桌面端「设置 → 远程」生成的 6 位配对码<br>10 分钟内有效,仅可使用一次</p>
    <input name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="······" autofocus autocomplete="off">
    <button type="submit">配对</button>
  </form>
</body>
</html>`

// pairingErrPage is the 401 body for wrong/expired codes on browser flows.
const pairingErrPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>配对失败</title>
<style>body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;background:#1a1a1c;color:#e8e8ea;font-family:-apple-system,sans-serif}
.c{width:min(320px,86vw);background:#232326;border:1px solid #3a3a3e;border-radius:14px;padding:24px;text-align:center}
a{color:#64d2ff;text-decoration:none}</style></head>
<body><div class="c"><p>配对码无效或已过期(错误超过 5 次或超过 10 分钟)。<br>请到桌面端重新生成。</p>
<a href="/">返回重试</a></div></body></html>`

// ListSessions snapshots the paired-device sessions (newest first).
func (s *Server) ListSessions() []Session { return s.sessions.list() }

// RevokeSession kicks one device by session id.
func (s *Server) RevokeSession(id string) bool { return s.sessions.revoke(id) }

// RevokeAllSessions is the token-regeneration kill switch: every paired
// device dies with the old token.
func (s *Server) RevokeAllSessions() { s.sessions.revokeAll() }
