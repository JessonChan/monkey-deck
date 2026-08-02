package chat

// segment_test.go:回归多 tool call 交替时 thinking/message 独立分段(AGENTS.md §5.3)。
//
// 旧根因(已由 timeline 重构根除):agentBuf/thought 在整个 turn 内累积,多段时第二段
// 包含第一段文本。现模型:每个 message entry 独立累积,按 messageId+role 归并。
//
// 本测试验证:thought→tool→agent→tool→agent 交错时,各 message entry 文本独立、
// 不互相污染;timeline 时序正确(thought/agent/tool 交错,工具不堆末尾)。

import (
	"testing"

	"github.com/jessonchan/monkey-deck/internal/acp"
)

func TestSegmentBoundaryReset(t *testing.T) {
	svc, sessionID, _ := newTestService(t)
	ls := svc.active[sessionID]

	// 第一段:thought "I need" → "I need to think"(同 messageId 归并)
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_thought_chunk", Text: "I need", MessageID: "m1"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_thought_chunk", Text: " to think", MessageID: "m1"})

	// 第二段:agent message "Let me" → "Let me help"(不同 messageId)
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "Let me", MessageID: "m2"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: " help", MessageID: "m2"})

	// tool_call(段边界)
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call", ToolCallID: "t1", ToolTitle: "read", ToolStatus: "completed"})

	// 第三段:thought "Now" → "Now done"(新 messageId,不应包含第一段)
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_thought_chunk", Text: "Now", MessageID: "m3"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_thought_chunk", Text: " done", MessageID: "m3"})

	// 第四段:agent message "Result" → "Result here"(新 messageId,不应包含第二段)
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "Result", MessageID: "m4"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: " here", MessageID: "m4"})

	ls.mu.Lock()
	segs := ls.segmentEntries()
	ls.mu.Unlock()

	// 期望:4 个 message entry,各自独立无重复文本。
	want := []struct{ role, content string }{
		{"thought", "I need to think"},
		{"agent", "Let me help"},
		{"thought", "Now done"},
		{"agent", "Result here"},
	}
	if len(segs) != len(want) {
		t.Fatalf("expected %d segments, got %d: %+v", len(want), len(segs), segs)
	}
	for i, w := range want {
		if segs[i].role != w.role || segs[i].content != w.content {
			t.Fatalf("segment %d: want {%s, %q}, got {%s, %q}", i, w.role, w.content, segs[i].role, segs[i].content)
		}
	}
}

// Without messageId, a role change is still a segment boundary: a thought chunk
// followed by an agent chunk yields two distinct entries (the fallback merges only
// consecutive same-role chunks, see TestSegmentFallbackMergeNoMessageId).
func TestSegmentBoundaryNoMessageId(t *testing.T) {
	svc, sessionID, _ := newTestService(t)
	ls := svc.active[sessionID]

	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_thought_chunk", Text: "想"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "答"})

	ls.mu.Lock()
	segs := ls.segmentEntries()
	ls.mu.Unlock()

	if len(segs) != 2 {
		t.Fatalf("expected 2 segments (role change = boundary), got %d: %+v", len(segs), segs)
	}
	if segs[0].role != "thought" || segs[0].content != "想" {
		t.Fatalf("seg0: %+v", segs[0])
	}
	if segs[1].role != "agent" || segs[1].content != "答" {
		t.Fatalf("seg1: %+v", segs[1])
	}
}

// TestSegmentFallbackMergeNoMessageId covers harnesses that never send messageId
// (UNSTABLE/optional in ACP — e.g. Reasonix streams every chunk with no id). The
// fallback must append consecutive same-role chunks into one entry, and rotate to a
// fresh entry on (a) a role change and (b) a tool_call. Mirrors the real Reasonix
// wire shape: a clean reasoning phase, then an answer phase, optionally split by tools.
func TestSegmentFallbackMergeNoMessageId(t *testing.T) {
	t.Run("reasoning then answer merge", func(t *testing.T) {
		svc, sessionID, _ := newTestService(t)
		ls := svc.active[sessionID]

		// Reasoning phase: 3 token deltas, no messageId → one thought entry.
		svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_thought_chunk", Text: "The"})
		svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_thought_chunk", Text: " user"})
		svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_thought_chunk", Text: " wants"})
		// Answer phase: 2 token deltas, no messageId → one agent entry.
		svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "Hello"})
		svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "!"})

		ls.mu.Lock()
		segs := ls.segmentEntries()
		ls.mu.Unlock()

		want := []segEntry{{"thought", "The user wants"}, {"agent", "Hello!"}}
		if len(segs) != len(want) {
			t.Fatalf("expected %d merged segments, got %d: %+v", len(want), len(segs), segs)
		}
		for i, w := range want {
			if segs[i] != w {
				t.Fatalf("segment %d: want %+v, got %+v", i, w, segs[i])
			}
		}
	})

	t.Run("tool_call breaks the merge", func(t *testing.T) {
		svc, sessionID, _ := newTestService(t)
		ls := svc.active[sessionID]

		// First agent message (2 chunks, no id) → "ab".
		svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "a"})
		svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "b"})
		// A tool call is a hard boundary.
		svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call", ToolCallID: "t1", ToolTitle: "read", ToolStatus: "completed"})
		// Second agent message (2 chunks, no id) → "cd", must NOT merge with "ab".
		svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "c"})
		svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "d"})

		ls.mu.Lock()
		segs := ls.segmentEntries()
		ls.mu.Unlock()

		want := []segEntry{{"agent", "ab"}, {"agent", "cd"}}
		if len(segs) != len(want) {
			t.Fatalf("expected %d agent segments (tool breaks merge), got %d: %+v", len(want), len(segs), segs)
		}
		for i, w := range want {
			if segs[i] != w {
				t.Fatalf("segment %d: want %+v, got %+v", i, w, segs[i])
			}
		}
	})
}

// TestSegmentFallbackIsolatedFromMessageId ensures the no-messageId fallback never
// bleeds into the primary (messageId) path: a messageId-bearing chunk and a
// messageId-less chunk of the same role stay in separate entries.
func TestSegmentFallbackIsolatedFromMessageId(t *testing.T) {
	svc, sessionID, _ := newTestService(t)
	ls := svc.active[sessionID]

	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "id-path", MessageID: "m1"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "fb-path"}) // no messageId

	ls.mu.Lock()
	segs := ls.segmentEntries()
	ls.mu.Unlock()

	if len(segs) != 2 {
		t.Fatalf("expected id-path and fallback-path to stay separate, got %d: %+v", len(segs), segs)
	}
	if segs[0].content != "id-path" || segs[1].content != "fb-path" {
		t.Fatalf("segments not isolated: %+v", segs)
	}
}

// TestSegmentFallbackToolCallUpdateNoBreak locks the deliberate behavior that a
// tool_call_update does NOT break an in-progress fallback message stream. A late
// async tool result arriving mid-stream (no new tool_call between chunks) must keep
// the chunks merging — clearing fallbackRole on tool_call_update would wrongly split a
// streaming message in two. Only tool_call (the announcement) is a hard boundary.
func TestSegmentFallbackToolCallUpdateNoBreak(t *testing.T) {
	svc, sessionID, _ := newTestService(t)
	ls := svc.active[sessionID]

	// Announce + complete a tool, then the agent streams a message.
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call", ToolCallID: "t1", ToolTitle: "read", ToolStatus: "in_progress"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call_update", ToolCallID: "t1", ToolStatus: "completed"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "a"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "b"})
	// A late tool_call_update for the already-completed tool arrives mid-stream.
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call_update", ToolCallID: "t1", ToolStatus: "completed"})
	// The agent keeps streaming the same message — must merge, not split.
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "c"})

	ls.mu.Lock()
	segs := ls.segmentEntries()
	ls.mu.Unlock()

	if len(segs) != 1 || segs[0].role != "agent" || segs[0].content != "abc" {
		t.Fatalf("tool_call_update must not break the stream; want one agent segment %q, got %+v", "abc", segs)
	}
}
