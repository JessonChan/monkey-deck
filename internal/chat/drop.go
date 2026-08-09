package chat

import (
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// drop.go:OS-level file drag-and-drop → frontend routing bridge.
//
// Wails3 native file drop (window option EnableFileDrop + DOM attribute
// data-file-drop-target) gives us absolute file paths via the WindowFilesDropped
// event — exactly what we need to route on the frontend (worktree-internal files
// become @mentions / inline images, external files become paperclip attachments).
// The webview's own JS DataTransfer only yields content-bearing File objects with
// no usable absolute paths, so we MUST go through the native drop path.
//
// This file only forwards the drop (paths + target session id) to the frontend;
// all routing logic (internal vs external, image vs mention) lives in the UI
// (lib/dropFiles.ts), which already holds the per-session cwd + imageSupport state.

// EventFilesDropped is emitted to the frontend when the user drops OS files onto
// a data-file-drop-target element. Carries absolute paths + the target session id
// (read from the drop target's data-md-session attribute). The frontend routes
// per lib/dropFiles.ts.
const EventFilesDropped = "chat:files-dropped"

// FilesDroppedPayload is the chat:files-dropped event payload.
type FilesDroppedPayload struct {
	Files     []string `json:"files"`     // absolute paths dropped from the OS file manager
	SessionID string   `json:"sessionId"` // data-md-session of the drop target element ("" if absent)
}

// RegisterFilesDroppedEmitter wires a WindowFilesDropped handler on win that
// re-emits the dropped absolute paths as chat:files-dropped. The session id is
// read from the drop target element's data-md-session attribute (stamped on
// ChatView's root by the frontend), so the frontend can route to the right
// session without guessing from window focus. Used by both the main window
// (desktop.go) and popout windows (window.go) — the frontend scopes which
// window handles which session (popout owns its own; main skips popped-out).
//
// No-op if win is nil; never returns an error. Drops only fire when the window
// was created with EnableFileDrop: true AND the cursor is over a
// [data-file-drop-target] element, so non-chat areas stay inert.
func RegisterFilesDroppedEmitter(win *application.WebviewWindow) {
	if win == nil {
		return
	}
	win.OnWindowEvent(events.Common.WindowFilesDropped, func(event *application.WindowEvent) {
		files := event.Context().DroppedFiles()
		if len(files) == 0 {
			return
		}
		var sid string
		if dt := event.Context().DropTargetDetails(); dt != nil && dt.Attributes != nil {
			sid = dt.Attributes["data-md-session"]
		}
		app := application.Get()
		if app == nil {
			return
		}
		app.Event.Emit(EventFilesDropped, FilesDroppedPayload{Files: files, SessionID: sid})
	})
}
