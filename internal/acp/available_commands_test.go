package acp

import (
	"context"
	"testing"

	"github.com/coder/acp-go-sdk"
)

// TestSessionUpdateFlattensAvailableCommands verifies the ACP available_commands_update
// notification is flattened into a SessionEvent the frontend can render as a slash-command
// palette. Each harness advertises a different, dynamic list (opencode=3, omp=42 in real
// probes); this test fixes the contract: name carries NO leading "/", description + inputHint
// are forwarded, commands without input still flatten (empty InputHint).
func TestSessionUpdateFlattensAvailableCommands(t *testing.T) {
	var events []SessionEvent
	h := NewHandler("/work", func(e SessionEvent) { events = append(events, e) }, nil, 0)

	_ = h.SessionUpdate(context.Background(), acp.SessionNotification{
		SessionId: "sess-1",
		Update: acp.SessionUpdate{
			AvailableCommandsUpdate: &acp.SessionAvailableCommandsUpdate{
				AvailableCommands: []acp.AvailableCommand{
					{Name: "model", Description: "Show current model selection",
						Input: &acp.AvailableCommandInput{Unstructured: &acp.UnstructuredCommandInput{Hint: "[on|off|status]"}}},
					{Name: "test", Description: "Run tests for the current project"},
				},
			},
		},
	})

	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	e := events[0]
	if e.Kind != "available_commands" {
		t.Fatalf("kind = %q, want available_commands", e.Kind)
	}
	if len(e.Commands) != 2 {
		t.Fatalf("expected 2 commands, got %d", len(e.Commands))
	}
	// First command: name WITHOUT leading "/", description + hint forwarded.
	c0 := e.Commands[0]
	if c0.Name != "model" {
		t.Fatalf("name = %q, want model (no leading /)", c0.Name)
	}
	if c0.Description != "Show current model selection" {
		t.Fatalf("description = %q", c0.Description)
	}
	if c0.InputHint != "[on|off|status]" {
		t.Fatalf("inputHint = %q, want [on|off|status]", c0.InputHint)
	}
	// Second command: no Input → empty InputHint, not a crash.
	c1 := e.Commands[1]
	if c1.Name != "test" || c1.InputHint != "" {
		t.Fatalf("second cmd = %+v, want name=test empty hint", c1)
	}
}
