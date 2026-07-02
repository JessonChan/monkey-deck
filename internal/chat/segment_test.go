package chat

// segment_test.go:回归多 tool call 交替时 thinking/message 重复输出 bug(AGENTS.md §5.3)。
//
// 根因:agentBuf/thought 在整个 turn 内累积,仅在 turn 开始 resetBuffers。
// 多段(thought → tool → thought / message → tool → message)时第二段包含第一段文本。
// 修复:handleEvent 检测段边界(lastChunkKind 变化),类型切换时 flush 当前 buffer 到
// segments 再 reset;persistTurn 逐段写库。

import (
	"testing"

	"github.com/jessonchan/monkey-deck/internal/acp"
)

func TestSegmentBoundaryReset(t *testing.T) {
	svc, sessionID, _ := newTestService(t)
	ls := svc.active[sessionID]

	// ── 第一段:thought "I need" → "I need to think" ──
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_thought_chunk", Text: "I need"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_thought_chunk", Text: " to think"})

	ls.mu.Lock()
	if ls.thought.String() != "I need to think" {
		t.Fatalf("first thought buffer: got %q", ls.thought.String())
	}
	ls.mu.Unlock()

	// ── 第二段:message "Let me" → "Let me help"(触发 thought→message 边界)──
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "Let me"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: " help"})

	ls.mu.Lock()
	// thought 应已 flush 到 segments 并重置
	if ls.thought.Len() != 0 {
		t.Fatalf("thought buffer should be reset after boundary, got %q", ls.thought.String())
	}
	segs := ls.segmentEntries()
	if len(segs) != 1 || segs[0].role != "thought" || segs[0].content != "I need to think" {
		t.Fatalf("segments after thought→message: %+v", segs)
	}
	if ls.agentBuf.String() != "Let me help" {
		t.Fatalf("first agent buffer: got %q", ls.agentBuf.String())
	}
	ls.mu.Unlock()

	// ── tool_call(段边界标记)──
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call", ToolCallID: "t1", ToolTitle: "read", ToolStatus: "completed"})

	// ── 第三段:thought "Now" → "Now done"(不应包含 "I need to think")──
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_thought_chunk", Text: "Now"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_thought_chunk", Text: " done"})

	ls.mu.Lock()
	if ls.thought.String() != "Now done" {
		t.Fatalf("second thought should be 'Now done', got %q (first segment leaked!)", ls.thought.String())
	}
	foundAgent1 := false
	for _, seg := range ls.segmentEntries() {
		if seg.role == "agent" && seg.content == "Let me help" {
			foundAgent1 = true
		}
	}
	if !foundAgent1 {
		t.Fatalf("first agent segment not flushed: %+v", ls.segmentEntries())
	}
	ls.mu.Unlock()

	// ── 第四段:message "Result" → "Result here"(不应包含 "Let me help")──
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "Result"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: " here"})

	ls.mu.Lock()
	if ls.agentBuf.String() != "Result here" {
		t.Fatalf("second agent should be 'Result here', got %q (first segment leaked!)", ls.agentBuf.String())
	}
	// 第二段 thought 应已 flush
	foundThought2 := false
	for _, seg := range ls.segmentEntries() {
		if seg.role == "thought" && seg.content == "Now done" {
			foundThought2 = true
		}
	}
	if !foundThought2 {
		t.Fatalf("second thought segment not flushed: %+v", ls.segmentEntries())
	}
	ls.mu.Unlock()

	// ── flush 最终段(模拟 turn 结束)──
	ls.mu.Lock()
	ls.finalizeTurnItems()
	ls.mu.Unlock()
	// 取 segment 子序列做段边界断言(不含 tool 项)。
	segOnly := ls.segmentEntries()
	_ = segs

	// 验证:4 个段,各自独立无重复
	want := []struct{ role, content string }{
		{"thought", "I need to think"},
		{"agent", "Let me help"},
		{"thought", "Now done"},
		{"agent", "Result here"},
	}
	if len(segOnly) != len(want) {
		t.Fatalf("expected %d segments, got %d: %+v", len(want), len(segOnly), segOnly)
	}
	for i, w := range want {
		if segOnly[i].role != w.role || segOnly[i].content != w.content {
			t.Fatalf("segment %d: want {%s, %q}, got {%s, %q}", i, w.role, w.content, segOnly[i].role, segOnly[i].content)
		}
	}
}
