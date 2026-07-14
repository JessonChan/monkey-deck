package acp

import (
	"context"
	"testing"

	"github.com/coder/acp-go-sdk"
)

// TestEmitTurnUsageForwardsBreakdown 复现 Task #15138:PromptResponse.Usage 的 token 明细
// (CachedRead/Write/Input/Output/Thought/Total)必须经 EmitTurnUsage 转发给前端。
// 断言:明细字段正确填充、指针类型(*int)安全解引用、cost 携带最近 streaming 快照。
func TestEmitTurnUsageForwardsBreakdown(t *testing.T) {
	var got []SessionEvent
	h := NewHandler("/work", func(e SessionEvent) { got = append(got, e) }, nil, 0)
	// 模拟 streaming 阶段已收到一条 UsageUpdate(used/size/cost)。
	h.lastUsed = 12000
	h.lastSize = 200000
	h.lastCost = 0.03

	cr, cw, th := 8000, 1000, 200
	h.EmitTurnUsage("sess-1", &acp.Usage{
		CachedReadTokens:  &cr,
		CachedWriteTokens: &cw,
		InputTokens:       12000,
		OutputTokens:      500,
		ThoughtTokens:     &th,
		TotalTokens:       12500,
	})

	if len(got) != 1 {
		t.Fatalf("expected 1 event, got %d", len(got))
	}
	e := got[0]
	if e.Kind != "usage_update" {
		t.Fatalf("kind = %q, want usage_update", e.Kind)
	}
	if e.CachedReadTokens != 8000 || e.CachedWriteTokens != 1000 {
		t.Fatalf("cached read/write = %d/%d, want 8000/1000", e.CachedReadTokens, e.CachedWriteTokens)
	}
	if e.InputTokens != 12000 || e.OutputTokens != 500 {
		t.Fatalf("input/output = %d/%d, want 12000/500", e.InputTokens, e.OutputTokens)
	}
	if e.ThoughtTokens != 200 || e.TotalTokens != 12500 {
		t.Fatalf("thought/total = %d/%d, want 200/12500", e.ThoughtTokens, e.TotalTokens)
	}
	// 携带最近 streaming 的 used/size/cost,避免前端用 0 覆盖既有占比。
	if e.Used != 12000 || e.Size != 200000 {
		t.Fatalf("used/size = %d/%d, want 12000/200000 (carried from streaming)", e.Used, e.Size)
	}
	if e.Cost == nil || *e.Cost != 0.03 {
		t.Fatalf("cost = %v, want 0.03 (carried from streaming)", e.Cost)
	}
}

// TestEmitTurnUsageNilSafe:nil handler / nil OnEvent / nil usage 不 panic(零值安全)。
func TestEmitTurnUsageNilSafe(t *testing.T) {
	t.Run("nil usage", func(t *testing.T) {
		h := NewHandler("/work", func(SessionEvent) {}, nil, 0)
		h.EmitTurnUsage("s", nil) // 不应 panic
	})
	t.Run("nil handler", func(t *testing.T) {
		var h *Handler
		h.EmitTurnUsage("s", &acp.Usage{TotalTokens: 1}) // 不应 panic
	})
}

// TestSessionUpdateTracksStreamingUsage 复现:streaming UsageUpdate 的 used/size/cost 必须被
// 记录到 handler,供后续 EmitTurnUsage 携带转发(否则前端用 0 覆盖占比)。
func TestSessionUpdateTracksStreamingUsage(t *testing.T) {
	var events []SessionEvent
	h := NewHandler("/work", func(e SessionEvent) { events = append(events, e) }, nil, 0)
	// 发一条 streaming UsageUpdate。
	_ = h.SessionUpdate(context.Background(), acp.SessionNotification{
		SessionId: "sess-1",
		Update: acp.SessionUpdate{
			UsageUpdate: &acp.SessionUsageUpdate{
				Used: 9999,
				Size: 160000,
				Cost: &acp.Cost{Currency: "USD", Amount: 0.05},
			},
		},
	})
	if h.lastUsed != 9999 || h.lastSize != 160000 || h.lastCost != 0.05 {
		t.Fatalf("streaming usage not tracked: used=%d size=%d cost=%v", h.lastUsed, h.lastSize, h.lastCost)
	}
}
