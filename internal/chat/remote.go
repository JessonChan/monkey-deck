package chat

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jessonchan/monkey-deck/internal/remote"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// Embedded remote server wiring (AGENTS.md §1.8): an optional, token-gated HTTP
// listener inside the desktop process so browsers / mobile clients share the
// same app instance. The server-tag build never attaches (see attachEmbeddedRemote
// in the main package), so remote stays inert there — server mode serves HTTP itself.

const (
	settingRemoteEnabled   = "remote.enabled"
	settingRemotePort      = "remote.port"
	settingRemoteToken     = "remote.token"
	settingRemoteSessions  = "remote.sessions"
	settingRemotePublicURL = "remote.public_url"
	defaultRemotePort      = 9250
)

// RemoteInfo is the settings-UI view of the embedded remote server.
type RemoteInfo struct {
	Enabled   bool // persisted preference
	Running   bool // listener currently up
	Port      int
	Token     string
	URLs      []string // tokenless base URLs, one per LAN IPv4 address
	PublicURL string   // optional public reverse-proxy base (https://md.example.com)
	Attached  bool     // false when not wired (server-tag build / tests)
}

// AttachEmbeddedRemote wires the transport + asset instances shared with the
// webview into an embedded remote server. Desktop builds call this before
// app.Run(); the server-tag build does not (build-tag split, same pattern as
// runDesktop). EventNames is the closed set of events bridged to clients.
// Package-level on purpose: a ChatService method would be picked up by the
// wails binding generator, which has no per-method exclusion.
func AttachEmbeddedRemote(s *ChatService, tr *application.HTTPTransport, assets http.Handler, eventNames []string) {
	s.remoteSrv = remote.New(remote.Options{
		Transport:  tr,
		Assets:     remote.WithAssetCache(assets),
		EventNames: eventNames,
		Token:      s.remoteTokenSnapshot,
		Sessions:   sessionStore{svc: s},
		Logger:     slog.Default(),
	})
}

// loadRemoteConfig restores persisted remote settings (settings KV table) and
// applies dev/CI env overrides. Generates the token on first use.
func (s *ChatService) loadRemoteConfig() {
	if v, err := s.st.GetSetting(s.ctx, settingRemoteEnabled); err != nil {
		slog.Warn("read remote.enabled", "err", err)
	} else {
		s.mu.Lock()
		s.remoteEnabled = v == "1"
		s.mu.Unlock()
	}
	port := defaultRemotePort
	if v, err := s.st.GetSetting(s.ctx, settingRemotePort); err == nil && v != "" {
		if p, perr := strconv.Atoi(v); perr == nil && p > 0 && p < 65536 {
			port = p
		}
	}
	token, err := s.st.GetSetting(s.ctx, settingRemoteToken)
	if err != nil || token == "" {
		token = newRemoteToken()
		if serr := s.st.SetSetting(s.ctx, settingRemoteToken, token); serr != nil {
			slog.Warn("persist remote token", "err", serr)
		}
	}
	s.mu.Lock()
	s.remotePort = port
	s.remoteToken = token
	if v, err := s.st.GetSetting(s.ctx, settingRemotePublicURL); err == nil {
		s.remotePublicURL = v
	}
	s.mu.Unlock()

	// Dev/CI escape hatches (AGENTS.md §1.8): env beats persisted settings so
	// headless verification can force-enable without touching the UI.
	if v := os.Getenv("MD_REMOTE_ENABLED"); v == "1" || v == "0" {
		s.mu.Lock()
		s.remoteEnabled = v == "1"
		s.mu.Unlock()
	}
	if v := os.Getenv("MD_REMOTE_PORT"); v != "" {
		if p, perr := strconv.Atoi(v); perr == nil && p > 0 && p < 65536 {
			s.mu.Lock()
			s.remotePort = p
			s.mu.Unlock()
		}
	}
	if v := os.Getenv("MD_REMOTE_TOKEN"); v != "" {
		s.mu.Lock()
		s.remoteToken = v
		s.mu.Unlock()
	}
}

// maybeStartRemote starts the listener at startup when attached + enabled.
func (s *ChatService) maybeStartRemote() {
	s.mu.Lock()
	enabled, attached := s.remoteEnabled, s.remoteSrv != nil
	s.mu.Unlock()
	if !attached || !enabled {
		return
	}
	port := s.remotePortSnapshot()
	if err := s.remoteSrv.Start(port); err != nil {
		// Keep the preference; surface in logs. The UI re-attempts on toggle.
		slog.Warn("start remote server", "err", err)
	}
}

func (s *ChatService) stopRemote() {
	if s := s.remoteServer(); s != nil {
		s.Stop()
	}
}

func (s *ChatService) remoteServer() *remote.Server {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.remoteSrv
}

func (s *ChatService) remoteTokenSnapshot() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.remoteToken
}

func (s *ChatService) remotePortSnapshot() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.remotePort
}

// GetRemoteInfo returns the remote server state for the settings UI.
func (s *ChatService) GetRemoteInfo() RemoteInfo {
	s.mu.Lock()
	enabled, port, token, pub, srv := s.remoteEnabled, s.remotePort, s.remoteToken, s.remotePublicURL, s.remoteSrv
	s.mu.Unlock()
	info := RemoteInfo{Enabled: enabled, Port: port, Token: token, PublicURL: pub, Attached: srv != nil}
	if srv != nil {
		info.Running, _ = srv.Running()
		if info.Running {
			for _, ip := range remote.LanAddresses() {
				// Tokenless base URLs: browser pairing goes through the
				// one-time /pair code (GenerateRemotePairingCode), never a
				// token-in-URL link.
				info.URLs = append(info.URLs, fmt.Sprintf("http://%s:%d", ip, port))
			}
		}
	}
	return info
}

// SetRemotePublicURL persists the optional public reverse-proxy base used for
// pairing links/QR (empty = LAN addresses only). No validation beyond
// trimming: the origin must simply be the one the phone will use.
func (s *ChatService) SetRemotePublicURL(url string) error {
	url = strings.TrimSpace(url)
	if url != "" && !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://") {
		return fmt.Errorf("public URL must start with http(s)://")
	}
	url = strings.TrimSuffix(url, "/")
	if err := s.st.SetSetting(s.ctx, settingRemotePublicURL, url); err != nil {
		return fmt.Errorf("persist remote.public_url: %w", err)
	}
	s.mu.Lock()
	s.remotePublicURL = url
	s.mu.Unlock()
	return nil
}

// GenerateRemotePairingCode issues a fresh one-time pairing attempt (10 min,
// single use) for browser clients: {6-digit code, pairing sid, expiry}. The
// sid binds the QR/link to THIS attempt — the code only works on the
// sid-bound entry page (2-of-2). Requires the remote server to be running.
func (s *ChatService) GenerateRemotePairingCode() (code string, sid string, expiresAt string, err error) {
	s.mu.Lock()
	srv := s.remoteSrv
	s.mu.Unlock()
	if srv == nil {
		return "", "", "", fmt.Errorf("remote server not attached")
	}
	if running, _ := srv.Running(); !running {
		return "", "", "", fmt.Errorf("remote server not running")
	}
	c, s2, exp := srv.GeneratePairingCode()
	return c, s2, exp.Format(time.RFC3339), nil
}

// SetRemoteEnabled toggles the listener live (persist + start/stop).
func (s *ChatService) SetRemoteEnabled(on bool) error {
	if err := s.st.SetSetting(s.ctx, settingRemoteEnabled, map[bool]string{true: "1", false: "0"}[on]); err != nil {
		return fmt.Errorf("persist remote.enabled: %w", err)
	}
	s.mu.Lock()
	s.remoteEnabled = on
	srv := s.remoteSrv
	s.mu.Unlock()
	if srv == nil {
		return nil // not attached (server-tag build / tests): persist only
	}
	if on {
		if err := srv.Start(s.remotePortSnapshot()); err != nil {
			return fmt.Errorf("start remote server: %w", err)
		}
	} else {
		srv.Stop()
	}
	return nil
}

// SetRemotePort persists the port and restarts the listener if it is running
// (browser clients reconnect within ~1s via custom.js).
func (s *ChatService) SetRemotePort(port int) error {
	if port <= 0 || port >= 65536 {
		return fmt.Errorf("invalid port %d", port)
	}
	if err := s.st.SetSetting(s.ctx, settingRemotePort, strconv.Itoa(port)); err != nil {
		return fmt.Errorf("persist remote.port: %w", err)
	}
	s.mu.Lock()
	s.remotePort = port
	srv := s.remoteSrv
	s.mu.Unlock()
	if srv == nil {
		return nil
	}
	if running, _ := srv.Running(); running {
		srv.Stop()
		if err := srv.Start(port); err != nil {
			return fmt.Errorf("restart remote server on %d: %w", port, err)
		}
	}
	return nil
}

// RegenerateRemoteToken rotates the token; takes effect immediately for new
// requests (existing cookies stop validating). Returns the new token.
func (s *ChatService) RegenerateRemoteToken() (string, error) {
	tok := newRemoteToken()
	if err := s.st.SetSetting(s.ctx, settingRemoteToken, tok); err != nil {
		return "", fmt.Errorf("persist remote token: %w", err)
	}
	s.mu.Lock()
	s.remoteToken = tok
	srv := s.remoteSrv
	s.mu.Unlock()
	// Kill switch: every paired session dies with the old token.
	if srv != nil {
		srv.RevokeAllSessions()
	}
	return tok, nil
}

// RemoteSessionInfo is one paired remote device for the settings UI.
// (No json tags — matches RemoteInfo's wire convention: Wails marshals Go
// field names, and the generated bindings + pane code agree on PascalCase.)
type RemoteSessionInfo struct {
	ID        string
	Label     string
	CreatedAt string
	LastSeen  string
}

// RemoteListSessions returns the paired devices, newest first.
func (s *ChatService) RemoteListSessions() []RemoteSessionInfo {
	s.mu.Lock()
	srv := s.remoteSrv
	s.mu.Unlock()
	if srv == nil {
		return nil
	}
	out := []RemoteSessionInfo{}
	for _, sess := range srv.ListSessions() {
		out = append(out, RemoteSessionInfo{
			ID:        sess.ID,
			Label:     sess.Label,
			CreatedAt: sess.CreatedAt.Format("2006-01-02 15:04"),
			LastSeen:  relativeTime(sess.LastSeen),
		})
	}
	return out
}

// RemoteRevokeSession kicks one paired device by session id.
func (s *ChatService) RemoteRevokeSession(id string) (bool, error) {
	s.mu.Lock()
	srv := s.remoteSrv
	s.mu.Unlock()
	if srv == nil {
		return false, fmt.Errorf("remote server not attached")
	}
	return srv.RevokeSession(id), nil
}

// sessionStore persists remote sessions through the settings KV table
// (AGENTS.md §1.5: SQLite is the truth source — sessions survive restarts).
type sessionStore struct{ svc *ChatService }

func (ss sessionStore) LoadSessions() string {
	v, err := ss.svc.st.GetSetting(ss.svc.ctx, settingRemoteSessions)
	if err != nil {
		return ""
	}
	return v
}

func (ss sessionStore) SaveSessions(blob string) {
	_ = ss.svc.st.SetSetting(ss.svc.ctx, settingRemoteSessions, blob)
}

// relativeTime renders a coarse "just now / Nm ago / Nh ago" label (§4.4
// human words; the i18n layer could localize later if needed).
func relativeTime(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return t.Format("2006-01-02")
	}
}

// newRemoteToken returns a 256-bit URL-safe random token.
func newRemoteToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failing is process-fatal territory; a fixed fallback is
		// worse than panicking loudly.
		panic(fmt.Errorf("generate remote token: %w", err))
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
