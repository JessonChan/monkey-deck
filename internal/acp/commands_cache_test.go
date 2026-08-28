package acp

import (
	"context"
	"testing"
	"time"

	"github.com/coder/acp-go-sdk"
)

// Handler-side contract for the slash command cache (#152): every
// available_commands_update — INCLUDING an empty table (a harness clearing its
// commands is legitimate state, not the absence of a cache) — must reach the
// OnCommandsCache callback with the flattened []SlashCommand. The service pins
// the DB session id in its closure (startLive), so the handler just forwards
// the ACP session id it received.

func TestSessionUpdateEmitsCommandsCache(t *testing.T) {
	type emit struct {
		sessionID string
		cmds      []SlashCommand
	}
	emitCh := make(chan emit, 4)
	h := NewHandler("/work", func(SessionEvent) {}, nil, nil, 0)
	h.SetCommandsCache(func(sessionID string, cmds []SlashCommand) {
		emitCh <- emit{sessionID, cmds}
	})

	// First advertisement: a populated table flattens through to the callback.
	_ = h.SessionUpdate(context.Background(), acp.SessionNotification{
		SessionId: "acs-1",
		Update: acp.SessionUpdate{
			AvailableCommandsUpdate: &acp.SessionAvailableCommandsUpdate{
				AvailableCommands: []acp.AvailableCommand{
					{Name: "model", Description: "Show model",
						Input: &acp.AvailableCommandInput{Unstructured: &acp.UnstructuredCommandInput{Hint: "[on|off]"}}},
					{Name: "test", Description: "Run tests"},
				},
			},
		},
	})
	select {
	case got := <-emitCh:
		if got.sessionID != "acs-1" {
			t.Fatalf("session id = %q, want acs-1", got.sessionID)
		}
		if len(got.cmds) != 2 || got.cmds[0].Name != "model" || got.cmds[0].InputHint != "[on|off]" || got.cmds[1].Name != "test" {
			t.Fatalf("cmds = %+v", got.cmds)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("OnCommandsCache not called for populated table")
	}

	// Second advertisement: an EMPTY table must still be delivered (full-table
	// replace; dropping it would strand stale commands in the cache forever).
	_ = h.SessionUpdate(context.Background(), acp.SessionNotification{
		SessionId: "acs-1",
		Update: acp.SessionUpdate{
			AvailableCommandsUpdate: &acp.SessionAvailableCommandsUpdate{
				AvailableCommands: []acp.AvailableCommand{},
			},
		},
	})
	select {
	case got := <-emitCh:
		if got.cmds == nil {
			t.Fatal("empty table delivered as nil, want non-nil empty slice (marshal must yield [])")
		}
		if len(got.cmds) != 0 {
			t.Fatalf("empty table delivered %d cmds, want 0", len(got.cmds))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("OnCommandsCache not called for empty table")
	}
}

// TestCommandsCacheNilCallbackSafe: handler unit tests construct the Handler
// without SetCommandsCache — a nil callback must be a silent no-op.
func TestCommandsCacheNilCallbackSafe(t *testing.T) {
	h := NewHandler("/work", func(SessionEvent) {}, nil, nil, 0)
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("nil callback panicked: %v", r)
		}
	}()
	_ = h.SessionUpdate(context.Background(), acp.SessionNotification{
		SessionId: "acs-1",
		Update: acp.SessionUpdate{
			AvailableCommandsUpdate: &acp.SessionAvailableCommandsUpdate{
				AvailableCommands: []acp.AvailableCommand{{Name: "model", Description: "Show model"}},
			},
		},
	})
}

// TestCommandsCacheCallbackPanicRecovered: the callback runs on the ACP reader
// goroutine — a panic inside the service callback (persistCommandsCache) must
// be recovered, not bubble up and tear down the connection.
func TestCommandsCacheCallbackPanicRecovered(t *testing.T) {
	h := NewHandler("/work", func(SessionEvent) {}, nil, nil, 0)
	h.SetCommandsCache(func(string, []SlashCommand) { panic("boom") })
	if err := h.SessionUpdate(context.Background(), acp.SessionNotification{
		SessionId: "acs-1",
		Update: acp.SessionUpdate{
			AvailableCommandsUpdate: &acp.SessionAvailableCommandsUpdate{
				AvailableCommands: []acp.AvailableCommand{{Name: "model", Description: "Show model"}},
			},
		},
	}); err != nil {
		t.Fatalf("SessionUpdate returned error after callback panic: %v", err)
	}
}
