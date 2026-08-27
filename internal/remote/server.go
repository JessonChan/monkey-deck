// Package remote embeds an optional, token-authenticated HTTP server into the
// desktop process so that browsers / mobile clients can connect to the very
// same app instance while the GUI keeps running (AGENTS.md §1.8).
//
// It deliberately exposes only the existing Wails3 protocol surface:
//   - "/"            → frontend assets, wrapped by the SAME HTTPTransport
//     binding middleware the webview uses (/wails/runtime dispatch). No second
//     API is invented (§5.3 KISS).
//   - "/wails/events"→ WebSocket hub bridging app.Event.On subscriptions.
//   - "/wails/custom.js" → browser-side WS bootstrap (the desktop webview gets
//     a 404 for this path and the bundled runtime skips it silently, so the
//     webview never opens a second event channel).
//
// Auth: cookie (browsers: fetch + WS upgrade carry same-origin cookies) or
// "Authorization: Bearer <token>" (native clients). Only /health and /auth are
// exempt. The binding surface equals full agent control (bash execution), so
// unauthenticated exposure is never acceptable.
package remote

import (
	"context"
	"crypto/subtle"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// transportHandler is the subset of *application.HTTPTransport we need: the
// binding middleware. Declared as an interface so tests can inject a stub.
type transportHandler interface {
	Handler() func(http.Handler) http.Handler
}

// Options wires the remote server to the live app. Transport and Assets must
// be the very instances used for the webview path (single dispatch chain).
type Options struct {
	Transport  transportHandler
	Assets     http.Handler
	Token      func() string // current token, read per request (regeneration applies live)
	EventNames []string      // closed set of events bridged to remote clients
	Sessions   SessionStore  // per-device session persistence (nil = memory only)
	Logger     *slog.Logger
}

// Server owns the embedded HTTP listener. Zero value is not usable; use New.
type Server struct {
	opts     Options
	hub      *hub
	pairing  pairingState
	sessions *sessionRegistry

	mu      sync.Mutex
	running bool
	srv     *http.Server
	lis     net.Listener
	port    int
	offs    []func() // Event.On unsubscribers
}

// New creates a remote server. It does not listen until Start.
func New(opts Options) *Server {
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	return &Server{opts: opts, sessions: newSessionRegistry(opts.Sessions)}
}

// Running reports whether the listener is up, plus its port.
func (s *Server) Running() (bool, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running, s.port
}

// Start begins listening on 0.0.0.0:port. Restarting while running is an error
// (stop first). Event bridge subscriptions are registered here and removed on Stop.
func (s *Server) Start(port int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		return fmt.Errorf("remote server already running on port %d", s.port)
	}

	s.hub = newHub()

	// Bridge events: register via the global app once it exists. Callbacks only
	// enqueue broadcasts (wails dispatches listener callbacks under a lock).
	if app := application.Get(); app != nil {
		for _, name := range s.opts.EventNames {
			off := app.Event.On(name, func(ev *application.CustomEvent) {
				s.hub.broadcast(ev)
			})
			s.offs = append(s.offs, off)
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/pair", s.handlePair)
	mux.HandleFunc("/wails/custom.js", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(customJS))
	})
	mux.Handle("/wails/events", s.hub)
	// Root: binding middleware (intercepts /wails/runtime, passes the rest
	// through) around the shared asset handler.
	mux.Handle("/", s.opts.Transport.Handler()(s.opts.Assets))

	lis, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", port))
	if err != nil {
		s.unregisterEvents()
		return fmt.Errorf("remote listen :%d: %w", port, err)
	}
	s.lis = lis
	s.port = lis.Addr().(*net.TCPAddr).Port
	s.srv = &http.Server{Handler: s.auth(mux), ReadHeaderTimeout: 10 * time.Second}
	s.running = true
	go func() {
		if err := s.srv.Serve(lis); err != nil && err != http.ErrServerClosed {
			s.opts.Logger.Error("remote server stopped", "err", err)
		}
	}()
	s.opts.Logger.Info("remote server started", "addr", lis.Addr().String())
	return nil
}

// Stop shuts the listener and the hub down. Idempotent.
func (s *Server) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.running {
		return
	}
	s.running = false
	s.unregisterEvents()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := s.srv.Shutdown(ctx); err != nil {
		s.opts.Logger.Warn("remote server shutdown", "err", err)
	}
	s.hub.close()
	s.opts.Logger.Info("remote server stopped", "port", s.port)
}

// Addr returns the listen address, or "" when not running.
func (s *Server) Addr() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.running {
		return ""
	}
	return fmt.Sprintf("0.0.0.0:%d", s.port)
}

func (s *Server) unregisterEvents() {
	for _, off := range s.offs {
		off()
	}
	s.offs = nil
}

// (handleAuth was replaced by pairing.go's handlePair: the long-lived token
// no longer travels in URLs.)

// auth wraps the whole mux. Exemptions: /health, /pair, and the PWA static
// metadata (manifest + icons) — the browser fetches the manifest and the
// apple-touch-icon WITHOUT cookies (spec-defined credentialless subresource
// fetch), so behind auth the phone's "Add to Home Screen" would 401. These
// files are public by design (app name, colors, icons) — no secrets.
// Unauthenticated BROWSER navigations of "/" get the pairing login page
// (form → /pair); native clients keep the plain 401.
func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if p == "/health" || p == "/pair" || p == "/manifest.webmanifest" || strings.HasPrefix(p, "/icons/") {
			next.ServeHTTP(w, r)
			return
		}
		// Cookie = per-device session id (registry lookup); Bearer = master
		// token (native clients / CI).
		if c, err := r.Cookie(cookieName); err == nil {
			if _, ok := s.sessions.lookup(c.Value); ok {
				next.ServeHTTP(w, r)
				return
			}
		}
		if s.tokenEqual(bearerToken(r)) {
			next.ServeHTTP(w, r)
			return
		}
		if p == "/" && strings.Contains(r.Header.Get("Accept"), "text/html") {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(pairingRootPage))
			return
		}
		w.Header().Set("WWW-Authenticate", `Bearer realm="monkey-deck"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	})
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if v, ok := strings.CutPrefix(h, "Bearer "); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

// tokenEqual is constant-time against the current token; empty never matches.
func (s *Server) tokenEqual(v string) bool {
	want := s.opts.Token()
	if want == "" || v == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(v), []byte(want)) == 1
}

// LanAddresses lists non-loopback IPv4 addresses of this machine, used to
// render connect URLs in the settings UI.
func LanAddresses() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []string
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok {
				if v4 := ipn.IP.To4(); v4 != nil {
					out = append(out, v4.String())
				}
			}
		}
	}
	return out
}
