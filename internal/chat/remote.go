package chat

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"

	"github.com/jessonchan/monkey-deck/internal/remote"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// Embedded remote server wiring (AGENTS.md §1.8): an optional, token-gated HTTP
// listener inside the desktop process so browsers / mobile clients share the
// same app instance. The server-tag build never attaches (see attachEmbeddedRemote
// in the main package), so remote stays inert there — server mode serves HTTP itself.

const (
	settingRemoteEnabled = "remote.enabled"
	settingRemotePort    = "remote.port"
	settingRemoteToken   = "remote.token"
	defaultRemotePort    = 9250
)

// RemoteInfo is the settings-UI view of the embedded remote server.
type RemoteInfo struct {
	Enabled  bool // persisted preference
	Running  bool // listener currently up
	Port     int
	Token    string
	URLs     []string // ready-to-open auth URLs, one per LAN IPv4 address
	Attached bool     // false when not wired (server-tag build / tests)
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
		Assets:     assets,
		EventNames: eventNames,
		Token:      s.remoteTokenSnapshot,
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
	enabled, port, token, srv := s.remoteEnabled, s.remotePort, s.remoteToken, s.remoteSrv
	s.mu.Unlock()
	info := RemoteInfo{Enabled: enabled, Port: port, Token: token, Attached: srv != nil}
	if srv != nil {
		info.Running, _ = srv.Running()
		if info.Running {
			for _, ip := range remote.LanAddresses() {
				info.URLs = append(info.URLs, fmt.Sprintf("http://%s:%d/auth?token=%s", ip, port, token))
			}
		}
	}
	return info
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
	s.mu.Unlock()
	return tok, nil
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
