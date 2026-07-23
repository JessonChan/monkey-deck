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

// 回归:无 messageId 时(role 回退路径),role 变化 = 新 entry。
func TestSegmentBoundaryNoMessageId(t *testing.T) {
	svc, sessionID, _ := newTestService(t)
	ls := svc.active[sessionID]

	// 无 messageId 且 role 变化(thought→agent):各自独立 entry(role 在 key 里 → 不同段)。
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_thought_chunk", Text: "想"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "答"})

	ls.mu.Lock()
	segs := ls.segmentEntries()
	ls.mu.Unlock()

	// 两个独立 entry(role 不同 → 不归并;同 role 连续 chunk 的归并见 TestSegmentMergeNoMessageIdConsecutive)。
	if len(segs) != 2 {
		t.Fatalf("expected 2 segments without messageId, got %d: %+v", len(segs), segs)
	}
	if segs[0].role != "thought" || segs[0].content != "想" {
		t.Fatalf("seg0: %+v", segs[0])
	}
	if segs[1].role != "agent" || segs[1].content != "答" {
		t.Fatalf("seg1: %+v", segs[1])
	}
}

// 回归(§5.3 / goose):无 messageId(goose 等不发 messageId 的 harness)时,
// 连续同 role chunk 必须归并成一条 entry;tool_call 是段边界,tool 后的同 role 文本落新段。
// 旧 bug:messageKey 无 id 时每条 chunk 生成唯一 key → 每条新 entry → 一个 turn 碎成数百条。
func TestSegmentMergeNoMessageIdConsecutive(t *testing.T) {
	svc, sessionID, _ := newTestService(t)
	ls := svc.active[sessionID]

	// 连续 agent chunk(无 messageId,goose 形态)→ 必须归并成一条。
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "我来看"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "看当前"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "代码。"})

	// tool_call = 段边界。
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call", ToolCallID: "T1", ToolTitle: "read", ToolStatus: "completed"})

	// tool 后的连续 agent chunk → 新的一段(不并入 tool 前那段)。
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "看完了"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: ",总结如下。"})

	ls.mu.Lock()
	segs := ls.segmentEntries()
	ls.mu.Unlock()

	want := []struct{ role, content string }{
		{"agent", "我来看看当前代码。"},
		{"agent", "看完了,总结如下。"},
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
