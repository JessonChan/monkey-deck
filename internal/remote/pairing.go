package remote

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// One-time pairing (2-of-2 model, user review 2026-08-23):
//
//   QR / pairing link  →  /pair?sid=<128-bit random>   (the "where" channel;
//                        high entropy, cannot be shoulder-surfed — only
//                        captured digitally or scanned)
//   6-digit code       →  typed by the human at the desk  (the "authorization"
//                        proof; glancable, so it must never work alone)
//
// Both must match the SAME active pairing attempt. A leaked link alone shows
// an entry page but no code works; a glimpsed code alone has nowhere to be
// typed (the sid-less root page is informational only). The long-lived master
// token never appears anywhere user-visible except the settings pane /
// Bearer header.

const (
	pairingTTL      = 10 * time.Minute
	pairingMaxFails = 5
)

// pairingState holds the single active pairing attempt. Locked by its own
// mutex; zero value = no active pairing.
type pairingState struct {
	mu      sync.Mutex
	sid     string // 128-bit random, binds the QR/link to this attempt
	code    string // 6 digits, typed by the human
	expires time.Time
	fails   int
	used    bool
}

// GeneratePairingCode replaces any active attempt with a fresh {sid, code}
// pair. Called from the settings UI binding only.
func (s *Server) GeneratePairingCode() (code string, sid string, expires time.Time) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		binary.LittleEndian.PutUint32(b[:], uint32(time.Now().UnixNano()))
	}
	sid = hex.EncodeToString(b[:])

	var c [4]byte
	if _, err := rand.Read(c[:]); err != nil {
		binary.LittleEndian.PutUint32(c[:], uint32(time.Now().UnixNano())>>1)
	}
	code = fmt.Sprintf("%06d", binary.LittleEndian.Uint32(c[:])%1000000)

	s.pairing.mu.Lock()
	defer s.pairing.mu.Unlock()
	s.pairing.sid = sid
	s.pairing.code = code
	s.pairing.expires = time.Now().Add(pairingTTL)
	s.pairing.fails = 0
	s.pairing.used = false
	return code, sid, s.pairing.expires
}

// verifyPairing checks the 2-of-2 pair {sid, code} against the active
// attempt: constant-time compares, attempt-capped, single-use. Empty values
// never burn attempts (they are not guesses).
func (s *Server) verifyPairing(sid, code string) bool {
	s.pairing.mu.Lock()
	defer s.pairing.mu.Unlock()
	p := &s.pairing
	if p.sid == "" || p.used || p.fails >= pairingMaxFails || time.Now().After(p.expires) {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(sid), []byte(p.sid)) != 1 {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(code), []byte(p.code)) != 1 {
		if code != "" {
			p.fails++
		}
		return false
	}
	p.used = true
	return true
}

// sidMatches reports whether sid belongs to the live (unused, unexpired)
// pairing attempt — gates serving the code-entry page.
func (s *Server) sidMatches(sid string) bool {
	s.pairing.mu.Lock()
	defer s.pairing.mu.Unlock()
	p := &s.pairing
	if p.sid == "" || p.used || p.fails >= pairingMaxFails || time.Now().After(p.expires) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(sid), []byte(p.sid)) == 1
}

// handlePair: GET /pair?sid=X serves the code-entry page bound to that
// attempt (sid is NOT secret enough alone — the page is harmless without the
// code). POST /pair with {sid, code} exchanges the matched pair for a
// per-device session cookie.
func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		sid := r.URL.Query().Get("sid")
		if !s.sidMatches(sid) {
			s.servePairingError(w)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(pairingEntryPage(sid)))
	case http.MethodPost:
		_ = r.ParseForm()
		if !s.verifyPairing(r.PostFormValue("sid"), r.PostFormValue("code")) {
			s.servePairingError(w)
			return
		}
		// Pairing issues an INDEPENDENT per-device session (the cookie never
		// carries the master token): listable, individually revocable.
		sess := s.sessions.issue(r.UserAgent())
		http.SetCookie(w, sessionCookie(sess.ID))
		http.Redirect(w, r, "/", http.StatusFound)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) servePairingError(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = w.Write([]byte(pairingErrPage))
}

// ListSessions snapshots the paired-device sessions (newest first).
func (s *Server) ListSessions() []Session { return s.sessions.list() }

// RevokeSession kicks one device by session id.
func (s *Server) RevokeSession(id string) bool { return s.sessions.revoke(id) }

// RevokeAllSessions is the token-regeneration kill switch: every paired
// device dies with the old token.
func (s *Server) RevokeAllSessions() { s.sessions.revokeAll() }

// pairingEntryPage is the sid-bound code-entry page. The sid rides along as
// a hidden field (POST body — never a URL). No assets, no info beyond the
// app name.
func pairingEntryPage(sid string) string {
	return `<!doctype html>
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
  input.code { width:100%; box-sizing:border-box; padding:12px; font-size:22px; letter-spacing:8px;
          text-align:center; border-radius:10px; border:1px solid #4a4a50; background:#1a1a1c;
          color:#e8e8ea; outline:none; }
  input.code:focus { border-color:#0a84ff; }
  button { margin-top:14px; width:100%; padding:12px; font-size:15px; font-weight:600;
           border:none; border-radius:10px; background:#0a84ff; color:#fff; cursor:pointer; }
</style>
</head>
<body>
  <!-- POST: the code (and sid) travel in the body, never the URL/history. -->
  <form class="card" method="post" action="/pair">
    <input type="hidden" name="sid" value="` + sid + `">
    <h1>Monkey Deck</h1>
    <p>请输入桌面端「设置 → 远程」显示的 6 位配对码<br>10 分钟内有效,仅可使用一次</p>
    <input class="code" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="······" autofocus autocomplete="one-time-code">
    <button type="submit">配对</button>
  </form>
</body>
</html>`
}

// pairingRootPage is served to unauthenticated BROWSER navigations of "/".
// It is the DEAD-END RECOVERY path (user report: a standalone PWA window has
// no address bar, so an unpaired launch must be able to complete pairing
// IN-PLACE). The user pastes the pairing link (or bare sid); inline JS
// extracts the sid and navigates to the sid-bound entry page. The 6-digit
// code itself is still only accepted there — the 2-of-2 model is unchanged:
// this page carries NO secret, it just parses one the user supplies.
const pairingRootPage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Monkey Deck</title>
<style>
  body { margin:0; min-height:100dvh; display:flex; align-items:center; justify-content:center;
         background:#1a1a1c; color:#e8e8ea; font-family:-apple-system,"SF Pro Text",sans-serif;
         padding:24px; box-sizing:border-box; }
  .card { width:min(360px,90vw); background:#232326; border:1px solid #3a3a3e; border-radius:14px;
          padding:28px 24px; text-align:center; }
  h1 { font-size:17px; margin:0 0 10px; }
  p { font-size:13px; color:#c8c8cc; margin:0 0 14px; line-height:1.6; }
  .dim { font-size:11.5px; color:#9a9aa0; margin:0 0 16px; }
  input { width:100%; box-sizing:border-box; padding:11px 10px; font-size:13px;
          border-radius:10px; border:1px solid #4a4a50; background:#1a1a1c;
          color:#e8e8ea; outline:none; }
  input:focus { border-color:#0a84ff; }
  button { margin-top:12px; width:100%; padding:12px; font-size:15px; font-weight:600;
           border:none; border-radius:10px; background:#0a84ff; color:#fff; cursor:pointer; }
  .err { color:#ff6961; font-size:12px; margin-top:10px; min-height:14px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Monkey Deck</h1>
    <p>此设备尚未配对。<br>请粘贴桌面端「设置 → 远程 → 复制配对链接」的内容:</p>
    <input id="link" placeholder="https://…/pair?sid=… 或 32 位 sid" autocomplete="off" spellcheck="false">
    <button type="button" onclick="go()">继续</button>
    <div class="err" id="err"></div>
    <p class="dim">也可以用相机扫描桌面端二维码。粘贴的内容不含配对码——还需输入 6 位码才能登录。</p>
  </div>
<script>
function go() {
  var v = document.getElementById('link').value.trim();
  var m = v.match(/sid=([0-9a-fA-F]{32})/) || v.match(/^([0-9a-fA-F]{32})$/);
  if (!m) { document.getElementById('err').textContent = '未识别到有效的配对链接或 32 位 sid'; return; }
  location.href = '/pair?sid=' + m[1].toLowerCase();
}
document.getElementById('link').addEventListener('keydown', function(e) { if (e.key === 'Enter') go(); });
</script>
</body>
</html>`

// pairingErrPage is the 401 body for wrong/expired/mismatched attempts.
const pairingErrPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>配对失败</title>
<style>body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;background:#1a1a1c;color:#e8e8ea;font-family:-apple-system,sans-serif}
.c{width:min(320px,86vw);background:#232326;border:1px solid #3a3a3e;border-radius:14px;padding:24px;text-align:center}
a{color:#64d2ff;text-decoration:none}</style></head>
<body><div class="c"><p>配对码无效、已过期,或与配对链接不匹配<br>(错误超过 5 次或超过 10 分钟)。<br>请到桌面端重新生成。</p>
<a href="/" onclick="history.back();return false">返回重试</a></div></body></html>`
