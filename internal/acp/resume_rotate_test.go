package acp

// resume_rotate_test.go: unit tests for the #79 rotate-once marker. ResumeChatSession
// arms tagResumeRotate before session/resume and keeps it wired after the call returns;
// the FIRST no-messageId agent_message_chunk to pass through afterwards must carry
// RotateOnce so the fallback merge (backend messageKey + frontend streamMerge) opens a
// fresh block instead of appending into a pre-resume bubble — junie-style harnesses
// replay history after the resume RPC returns (penetrating the suppression window,
// conformance audit docs/worklog/2026-08-06-acp-conformance-audit.md) and never send
// messageId. Exactly one event per resume is tagged.

import (
	"sync/atomic"
	"testing"
)

func TestTagResumeRotateTagsFirstNoIdMessageChunkOnly(t *testing.T) {
	var armed atomic.Bool
	armed.Store(true)

	// First post-resume no-messageId message chunk: tagged, arm consumed.
	e1 := tagResumeRotate(&armed, SessionEvent{Kind: "agent_message_chunk", Text: "a"})
	if !e1.RotateOnce {
		t.Fatalf("first no-messageId agent_message_chunk after resume must carry RotateOnce")
	}

	// Second chunk: arm spent → untouched, documented fallback semantics resume.
	e2 := tagResumeRotate(&armed, SessionEvent{Kind: "agent_message_chunk", Text: "b"})
	if e2.RotateOnce {
		t.Fatalf("RotateOnce must be spent after the first chunk (rotate exactly once)")
	}
	if armed.Load() {
		t.Fatalf("arm must stay spent")
	}
}

func TestTagResumeRotateDoesNotSpendArmOnNonMatchingEvents(t *testing.T) {
	var armed atomic.Bool
	armed.Store(true)

	// Thought chunks, metadata and messageId-bearing chunks pass through untagged
	// WITHOUT consuming the arm — the first no-id MESSAGE chunk still gets the tag.
	passthrough := []SessionEvent{
		{Kind: "agent_thought_chunk", Text: "think"},              // no id, wrong kind
		{Kind: "agent_message_chunk", Text: "x", MessageID: "m1"}, // right kind, has id
		{Kind: "config_option"},                                   // session metadata
		{Kind: "available_commands"},                              // session metadata
	}
	for i, e := range passthrough {
		if out := tagResumeRotate(&armed, e); out.RotateOnce {
			t.Fatalf("passthrough event %d (%s) must not be tagged", i, e.Kind)
		}
	}
	if !armed.Load() {
		t.Fatalf("arm must survive non-matching events")
	}
	e := tagResumeRotate(&armed, SessionEvent{Kind: "agent_message_chunk", Text: "a"})
	if !e.RotateOnce {
		t.Fatalf("first no-messageId message chunk after passthrough events must still be tagged")
	}
}

func TestTagResumeRotateInertWhenNotArmed(t *testing.T) {
	// NewSession never arms the gate: zero behavioral change for the non-resume path.
	var armed atomic.Bool // zero value = unarmed
	e := tagResumeRotate(&armed, SessionEvent{Kind: "agent_message_chunk", Text: "a"})
	if e.RotateOnce {
		t.Fatalf("unarmed gate must never tag")
	}
	if armed.Load() {
		t.Fatalf("unarmed gate must stay unarmed")
	}
}
