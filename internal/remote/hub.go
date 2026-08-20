package remote

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// hub fans out bridged events to all connected WebSocket clients. Server-mode
// wails has an equivalent (WebSocketBroadcaster) but it is server-tag-only, so
// we keep a small one here for the embedded desktop server.
type hub struct {
	mu      sync.Mutex
	clients map[*websocket.Conn]struct{}
	closed  bool
}

func newHub() *hub {
	return &hub{clients: map[*websocket.Conn]struct{}{}}
}

// ServeHTTP upgrades and registers a client. Incoming frames are drained in a
// read loop purely to observe closure; clients never send meaningful data.
func (h *hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		_ = conn.Close(websocket.StatusGoingAway, "server stopped")
		return
	}
	h.clients[conn] = struct{}{}
	h.mu.Unlock()

	// Read loop: blocks until the client disconnects (or sends a close frame).
	// NOTE: context.Background(), NOT r.Context() — the request context is
	// canceled once ServeHTTP returns, which would tear the connection down
	// immediately after the upgrade.
	go func() {
		defer h.remove(conn)
		for {
			if _, _, err := conn.Read(context.Background()); err != nil {
				return
			}
		}
	}()
}

// broadcast sends the event JSON to every client. Non-blocking by design: each
// write runs in its own goroutine with its own timeout; failed writes drop the
// client. Called from wails event-listener dispatch, so it must never stall.
func (h *hub) broadcast(ev *application.CustomEvent) {
	if ev == nil {
		return
	}
	payload := []byte(ev.ToJSON())

	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return
	}
	targets := make([]*websocket.Conn, 0, len(h.clients))
	for c := range h.clients {
		targets = append(targets, c)
	}
	h.mu.Unlock()

	for _, c := range targets {
		go func(c *websocket.Conn) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := c.Write(ctx, websocket.MessageText, payload); err != nil {
				h.remove(c)
			}
		}(c)
	}
}

func (h *hub) remove(c *websocket.Conn) {
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		// CloseNow: no close handshake — the handshake blocks waiting for a
		// peer reply that idle broadcast clients never send.
		c.CloseNow()
	}
	h.mu.Unlock()
}

func (h *hub) close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	for c := range h.clients {
		c.CloseNow()
	}
	h.clients = map[*websocket.Conn]struct{}{}
}
