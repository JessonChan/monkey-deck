package remote

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// Per-device sessions: each successful pairing issues an INDEPENDENT session
// id (the cookie no longer carries the master token), so the desktop admin
// can list and individually revoke logged-in devices, and a stolen cookie is
// not the master key. Sessions persist through the app's settings store
// (injected via Options.SessionStore) and die on token regeneration.

// Session is one paired device.
type Session struct {
	ID        string    `json:"id"`
	Label     string    `json:"label"`     // UA-derived, e.g. "iPhone · Safari"
	CreatedAt time.Time `json:"createdAt"` // pairing time
	LastSeen  time.Time `json:"lastSeen"`  // throttled request touch
}

// SessionStore persists the session list (JSON blob) — implemented by the
// chat service over the settings KV table; nil disables persistence
// (sessions then live only for the process lifetime).
type SessionStore interface {
	LoadSessions() string
	SaveSessions(blob string)
}

const (
	// lastSeenWriteThrottle: persist the list at most once per minute per
	// burst of requests — LastSeen is telemetry, not accounting.
	lastSeenWriteThrottle = time.Minute
	cookieName            = "md_remote_session"
)

// sessionRegistry owns the live session set. Mutex-guarded; Load merges the
// persisted blob on first use.
type sessionRegistry struct {
	mu       sync.Mutex
	sessions map[string]*Session
	loaded   bool
	store    SessionStore
}

func newSessionRegistry(store SessionStore) *sessionRegistry {
	return &sessionRegistry{sessions: map[string]*Session{}, store: store}
}

func (r *sessionRegistry) loadLocked() {
	if r.loaded || r.store == nil {
		r.loaded = true
		return
	}
	blob := r.store.LoadSessions()
	if blob != "" {
		var list []Session
		if err := json.Unmarshal([]byte(blob), &list); err == nil {
			for i := range list {
				s := list[i]
				r.sessions[s.ID] = &s
			}
		}
	}
	r.loaded = true
}

func (r *sessionRegistry) persistLocked() {
	if r.store == nil {
		return
	}
	list := make([]Session, 0, len(r.sessions))
	for _, s := range r.sessions {
		list = append(list, *s)
	}
	blob, err := json.Marshal(list)
	if err == nil {
		r.store.SaveSessions(string(blob))
	}
}

// issue creates a new session for the pairing request and persists it.
func (r *sessionRegistry) issue(ua string) Session {
	label := uaLabel(ua)
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		for i := range b {
			b[i] = byte(time.Now().UnixNano() >> (i * 8))
		}
	}
	s := Session{
		ID:        hex.EncodeToString(b[:]),
		Label:     label,
		CreatedAt: time.Now(),
		LastSeen:  time.Now(),
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.loadLocked()
	r.sessions[s.ID] = &s
	r.persistLocked()
	return s
}

// lookup validates a cookie value as a live session; touches LastSeen
// (throttled persist).
func (r *sessionRegistry) lookup(id string) (Session, bool) {
	if id == "" {
		return Session{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.loadLocked()
	s, ok := r.sessions[id]
	if !ok {
		return Session{}, false
	}
	if time.Since(s.LastSeen) > lastSeenWriteThrottle {
		s.LastSeen = time.Now()
		r.persistLocked()
	}
	return *s, true
}

// list snapshots the sessions, newest pairing first.
func (r *sessionRegistry) list() []Session {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.loadLocked()
	out := make([]Session, 0, len(r.sessions))
	for _, s := range r.sessions {
		out = append(out, *s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out
}

// revoke removes one session by id (constant-time map access is not a thing;
// ids are 128-bit random, enumeration-safe). Reports whether it existed.
func (r *sessionRegistry) revoke(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.loadLocked()
	if _, ok := r.sessions[id]; !ok {
		return false
	}
	delete(r.sessions, id)
	r.persistLocked()
	return true
}

// revokeAll clears every session (token regeneration kill switch).
func (r *sessionRegistry) revokeAll() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sessions = map[string]*Session{}
	r.persistLocked()
}

// sessionCookie is the per-device cookie set on pairing.
func sessionCookie(id string) *http.Cookie {
	return &http.Cookie{
		Name:     cookieName,
		Value:    id,
		Path:     "/",
		MaxAge:   365 * 24 * 3600,
		HttpOnly: true,
		// Lax, not Strict: Strict cookies are dropped on navigations without
		// same-site initiating context — cold-launching an installed PWA from
		// the launcher / entering via an app link (camera QR) logged the user
		// out (user report). Lax still withholds the cookie from cross-site
		// POSTs; our binding surface is same-origin fetch, so the CSRF surface
		// is unchanged.
		SameSite: http.SameSiteLaxMode,
	}
}

// uaLabel derives a short human device label from a User-Agent. Deliberately
// crude (§4.4 human words, not raw UA): OS + browser families only.
func uaLabel(ua string) string {
	os := "Unknown device"
	switch {
	case strings.Contains(ua, "iPhone"), strings.Contains(ua, "iPad"):
		os = "iPhone"
		if strings.Contains(ua, "iPad") {
			os = "iPad"
		}
	case strings.Contains(ua, "Android"):
		os = "Android"
	case strings.Contains(ua, "Macintosh"), strings.Contains(ua, "Mac OS"):
		os = "Mac"
	case strings.Contains(ua, "Windows"):
		os = "Windows"
	case strings.Contains(ua, "Linux"):
		os = "Linux"
	}
	browser := ""
	switch {
	case strings.Contains(ua, "Edg/"):
		browser = "Edge"
	case strings.Contains(ua, "Firefox/"):
		browser = "Firefox"
	case strings.Contains(ua, "Chrome/"), strings.Contains(ua, "CriOS"):
		browser = "Chrome"
	case strings.Contains(ua, "Safari/"):
		browser = "Safari"
	}
	if browser == "" {
		return os
	}
	return os + " · " + browser
}
