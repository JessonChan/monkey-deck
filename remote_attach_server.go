//go:build server

// remote_attach_server.go: server-tag builds never attach the embedded remote
// server — server mode's own HTTP serving (application_server.go) already
// exposes the app, and the two must not double-serve (AGENTS.md §1.8).
package main

import (
	"net/http"

	"github.com/jessonchan/monkey-deck/internal/chat"
	"github.com/jessonchan/monkey-deck/internal/remote"
	"github.com/wailsapp/wails/v3/pkg/application"
)

func attachEmbeddedRemote(_ *chat.ChatService, _ *application.HTTPTransport, _ http.Handler, _ remote.Transcriber) {
	// Intentional no-op in server mode.
}
