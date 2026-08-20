//go:build !server

// remote_attach_desktop.go: desktop builds wire the embedded remote server
// (AGENTS.md §1.8). Server-tag builds get the no-op twin (remote_attach_server.go)
// — server mode already serves HTTP itself and must not double-serve.
package main

import (
	"net/http"

	"github.com/jessonchan/monkey-deck/internal/chat"
	"github.com/jessonchan/monkey-deck/internal/terminal"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// attachEmbeddedRemote wires the transport + asset instances shared with the
// webview into the chat service's embedded remote server. Must run after
// application.New and before app.Run (ServiceStartup starts the listener).
func attachEmbeddedRemote(chatSvc *chat.ChatService, tr *application.HTTPTransport, assets http.Handler) {
	chat.AttachEmbeddedRemote(chatSvc, tr, assets, remoteEventNames())
}

// remoteEventNames is the closed set of app-emitted events bridged to remote
// clients over /wails/events. Keep in sync with the emit sites (chat/terminal
// constants are the single source; adding an event means adding it here).
func remoteEventNames() []string {
	return append([]string{
		chat.EventUpdate,
		chat.EventPermission,
		chat.EventElicitation,
		chat.EventElicitationResolved,
		chat.EventStatus,
		chat.EventSessionMeta,
		chat.EventHarnesses,
		chat.EventHarnessCapabilities,
		chat.EventFilesDropped,
		chat.EventPopoutChanged,
	}, terminal.EventData, terminal.EventExit, terminal.EventState)
}
