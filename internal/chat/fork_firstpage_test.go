package chat

// fork_firstpage_test.go — regression for the #208 reopen (2026-09-09):
// forkLineagePage asked ListMessagesBefore for limit+pre rows, but the store
// adds its own +1 probe row, returning limit+pre+1; the defensive truncate
// own[:limit+pre] then cut the NEWEST row off the ascending slice. Every fresh
// DB load (idle switch-back re-pull, PWA cold open) of a fork with ≥ limit+2
// own messages hid the turn's final agent reply — production forensic: fork
// with 285 own rows, first page (limit 30) ended at seq 284 (tool) while the
// 1518-char agent reply at seq 285 sat in SQLite invisible.

import (
	"testing"
)

// TestForkFirstPageIncludesNewestOwnRow seeds the production shape: a fork
// with limit+2 own rows whose NEWEST row is the agent reply (turn-end batch
// writes agent last). The first page must end on that row.
func TestForkFirstPageIncludesNewestOwnRow(t *testing.T) {
	svc, st := newLineageSvc(t)
	proj, err := st.CreateProject(svc.ctx, "p", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	src, err := st.CreateSession(svc.ctx, proj.ID, "src", "", "omp")
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 5; i++ {
		if _, err := st.AppendMessage(svc.ctx, src.ID, "user", "", "base", ""); err != nil {
			t.Fatal(err)
		}
	}
	fork, err := st.CreateSession(svc.ctx, proj.ID, "src (fork)", "", "omp")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetSessionForkedFrom(svc.ctx, fork.ID, src.ID); err != nil {
		t.Fatal(err)
	}
	if err := st.SetSessionForkBaseSeq(svc.ctx, fork.ID, 5); err != nil {
		t.Fatal(err)
	}
	// limit+2 own rows: enough that the pre-fix own query returned 33 rows
	// for the 31-row budget and the truncate dropped the newest one.
	const limit = 30
	for i := 1; i <= limit+1; i++ {
		if _, err := st.AppendMessage(svc.ctx, fork.ID, "tool", "tool_call", "t", ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.AppendMessage(svc.ctx, fork.ID, "agent", "agent_message_chunk", "FINAL REPLY", ""); err != nil {
		t.Fatal(err)
	}

	msgs, err := svc.LoadMessagesPage(fork.ID, 0, limit)
	if err != nil {
		t.Fatal(err)
	}
	last := msgs[len(msgs)-1]
	if last.Role != "agent" || last.Content != "FINAL REPLY" {
		t.Fatalf("newest own row missing from first page: last=(seq=%d role=%s content=%q) rows=%d",
			last.Seq, last.Role, last.Content, len(msgs))
	}
	// Page budget contract: at most limit+1 rows (probe row included).
	if len(msgs) > limit+1 {
		t.Fatalf("first page returned %d rows, exceeds limit+1=%d", len(msgs), limit+1)
	}
}

// TestForkPagingDeepOwnWalkNoLoss walks pagination with the same dense fork
// across the own-range boundary: pages must be strictly continuous (no gap,
// no duplicate) and the walk must reach the base prefix. The pre-fix bug also
// corrupted cursors here (each page's newest row was the next page's hole).
func TestForkPagingDeepOwnWalkNoLoss(t *testing.T) {
	svc, st := newLineageSvc(t)
	proj, err := st.CreateProject(svc.ctx, "p", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	src, err := st.CreateSession(svc.ctx, proj.ID, "src", "", "omp")
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 7; i++ {
		if _, err := st.AppendMessage(svc.ctx, src.ID, "user", "", "base", ""); err != nil {
			t.Fatal(err)
		}
	}
	fork, err := st.CreateSession(svc.ctx, proj.ID, "src (fork)", "", "omp")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetSessionForkedFrom(svc.ctx, fork.ID, src.ID); err != nil {
		t.Fatal(err)
	}
	if err := st.SetSessionForkBaseSeq(svc.ctx, fork.ID, 7); err != nil {
		t.Fatal(err)
	}
	const ownCount = 33
	for i := 1; i <= ownCount; i++ {
		if _, err := st.AppendMessage(svc.ctx, fork.ID, "agent", "", "own", ""); err != nil {
			t.Fatal(err)
		}
	}

	// Mirror the frontend exactly (App.tsx loadMoreMessages): each older page
	// is PREPENDED, so the rendered transcript = pages reversed and
	// concatenated. Collect pages, then assert the assembled view equals the
	// full merged transcript with no loss, duplication, or reorder.
	var pages [][]int64
	before := int64(0)
	for range 50 {
		msgs, err := svc.LoadMessagesPage(fork.ID, before, 10)
		if err != nil {
			t.Fatal(err)
		}
		if len(msgs) == 0 {
			break
		}
		hasMore := len(msgs) > 10
		if hasMore {
			msgs = msgs[1:] // drop the probe row
		}
		var page []int64
		for _, m := range msgs {
			page = append(page, m.Seq)
		}
		pages = append(pages, page)
		if !hasMore {
			break
		}
		before = msgs[0].Seq // oldest displayed row → next page is strictly older
	}
	var display []int64
	for i := len(pages) - 1; i >= 0; i-- {
		display = append(display, pages[i]...)
	}
	// Full merged transcript: base offsets -7..-1 then own 1..33 → 40 rows.
	if len(display) != ownCount+7 {
		t.Fatalf("assembled %d rows, want %d (own %d + base 7): %v", len(display), ownCount+7, ownCount, display)
	}
	for i := range display {
		want := int64(i - 7) // [-7..-1] base prefix, then own 1..33
		if i >= 7 {
			want = int64(i - 6)
		}
		if display[i] != want {
			t.Fatalf("assembled[%d]=%d, want %d (full view %v)", i, display[i], want, display)
		}
	}
	if pages[0][len(pages[0])-1] != ownCount {
		t.Fatalf("first page ends at seq %d, want newest own seq %d", pages[0][len(pages[0])-1], ownCount)
	}
}
