package chat

// fork_lineage_test.go — behavior tests for the #172 Phase 3 lineage view:
// a fork row's transcript pages through [source prefix (negative seq offsets)]
// + [own messages] under ONE cursor, preserving the +1 hasMore probe contract.

import (
	"context"
	"fmt"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
)

func newLineageSvc(t *testing.T) (*ChatService, *store.Store) {
	t.Helper()
	st, err := store.New("")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc := NewChatService(config.TestConfig(t.TempDir()))
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	svc.ctx = ctx
	svc.st = st
	return svc, st
}

// TestForkLineagePagePaging walks the full pagination of a fork transcript:
// source has 5 messages (seq 1..5), watermark 5; fork has 3 own messages
// (seq 1..3). Merged transcript = src1..src5 (offsets -5..-1) + own1..own3.
// all8Messages fetches the session's full merged view via a single wide page.
func all8Messages(t *testing.T, svc *ChatService, sessionID string) []store.Message {
	t.Helper()
	msgs, err := svc.LoadMessagesPage(sessionID, 0, 1000)
	if err != nil {
		t.Fatal(err)
	}
	return msgs
}
func TestForkLineagePagePaging(t *testing.T) {
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
		if _, err := st.AppendMessage(svc.ctx, src.ID, "user", "", string(rune('a'+i-1)), ""); err != nil {
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
	for i := 1; i <= 3; i++ {
		if _, err := st.AppendMessage(svc.ctx, fork.ID, "agent", "", string(rune('x'+i-1)), ""); err != nil {
			t.Fatal(err)
		}
	}

	type page struct {
		texts   []string
		hasMore bool
	}
	var pages []page
	var before int64
	for {
		msgs, err := svc.LoadMessagesPage(fork.ID, before, 2)
		if err != nil {
			t.Fatal(err)
		}
		hasMore := len(msgs) > 2
		// Frontend convention (App.tsx openSession): probe row is msgs[0]
		// (oldest of the limit+1); slice it off, cursor = the NEW first row.
		if hasMore {
			msgs = msgs[1:]
		}
		if len(msgs) == 0 {
			break
		}
		var texts []string
		for _, m := range msgs {
			texts = append(texts, m.Content)
		}
		pages = append(pages, page{texts, hasMore})
		before = msgs[0].Seq // displayed-oldest row: next page fetches strictly older
		if !hasMore {
			break
		}
	}
	// Property assertion (stronger than pinning page boundaries): the UI
	// prepends each older page, so displayed order = pages[N-1] + … + pages[0].
	// That assembly must equal the full merged transcript exactly — no loss,
	// no duplicates, no reorder. The loop finishing at all is the termination
	// proof (the first server version looped forever on the negative cursor).
	var display []string
	for i := len(pages) - 1; i >= 0; i-- {
		display = append(display, pages[i].texts...)
	}
	var fullTexts []string
	for _, m := range all8Messages(t, svc, fork.ID) {
		fullTexts = append(fullTexts, m.Content)
	}
	if len(display) != len(fullTexts) {
		t.Fatalf("paged display %d msgs (%v), full has %d (%v)", len(display), display, len(fullTexts), fullTexts)
	}
	for i := range display {
		if display[i] != fullTexts[i] {
			t.Fatalf("display[%d]=%q full[%d]=%q — pagination diverges from full view", i, display[i], i, fullTexts[i])
		}
	}
	// The pagination walk must end on a proper terminal page: the last page
	// reports hasMore=false (it reached the oldest row). A page that still
	// claims hasMore would mean the loop stopped before the oldest row.
	if len(pages) == 0 {
		t.Fatal("no pages returned")
	}
	if pages[len(pages)-1].hasMore {
		t.Fatal("pagination ended on a hasMore page — walk stopped before the oldest row")
	}
	// Monotonic cursor sanity: every returned seq must be strictly ascending
	// within a page, and every page's first seq must be lower than the last.
	all, err := svc.LoadMessagesPage(fork.ID, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i < len(all); i++ {
		if all[i].Seq <= all[i-1].Seq {
			t.Fatalf("merged transcript not ascending at %d: %d then %d", i, all[i-1].Seq, all[i].Seq)
		}
	}
	// Base rows carry the fork's session id (UI keys off it).
	for _, m := range all[:5] {
		if m.SessionID != fork.ID {
			t.Fatalf("base row session = %q, want fork %q", m.SessionID, fork.ID)
		}
	}
}

// TestForkLineageSourceGrowsAfterFork pins the watermark semantics: messages
// appended to the SOURCE after the fork must NOT appear in the fork's view.
func TestForkLineageSourceGrowsAfterFork(t *testing.T) {
	svc, st := newLineageSvc(t)
	proj, err := st.CreateProject(svc.ctx, "p", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	src, err := st.CreateSession(svc.ctx, proj.ID, "src", "", "omp")
	if err != nil {
		t.Fatal(err)
	}
	st.AppendMessage(svc.ctx, src.ID, "user", "", "before", "")
	st.AppendMessage(svc.ctx, src.ID, "agent", "", "reply", "")
	fork, err := st.CreateSession(svc.ctx, proj.ID, "src (fork)", "", "omp")
	if err != nil {
		t.Fatal(err)
	}
	st.SetSessionForkedFrom(svc.ctx, fork.ID, src.ID)
	st.SetSessionForkBaseSeq(svc.ctx, fork.ID, 2)
	// Source continues after the fork.
	st.AppendMessage(svc.ctx, src.ID, "user", "", "post-fork-only-in-source", "")
	st.AppendMessage(svc.ctx, fork.ID, "agent", "", "own", "")

	msgs, err := svc.LoadMessagesPage(fork.ID, 0, 30)
	if err != nil {
		t.Fatal(err)
	}
	joined := ""
	for _, m := range msgs {
		joined += m.Content
	}
	if joined != "beforereplyown" {
		t.Fatalf("fork view = %q, want %q (post-fork source messages must be excluded)", joined, "beforereplyown")
	}
}

// TestNonForkSessionsUnaffected: sessions without lineage take the plain path.
func TestNonForkSessionsUnaffected(t *testing.T) {
	svc, st := newLineageSvc(t)
	proj, err := st.CreateProject(svc.ctx, "p", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	se, err := st.CreateSession(svc.ctx, proj.ID, "plain", "", "omp")
	if err != nil {
		t.Fatal(err)
	}
	st.AppendMessage(svc.ctx, se.ID, "user", "", "hello", "")
	msgs, err := svc.LoadMessagesPage(se.ID, 0, 10)
	if err != nil || len(msgs) != 1 || msgs[0].Content != "hello" || msgs[0].Seq != 1 {
		t.Fatalf("plain session paging changed: %+v err=%v", msgs, err)
	}
}

// TestForkLineagePageWalkNoDupNoGap pins the #197 pagination contract on the
// user-reported shape: a fork with 3 own messages on top of a 50-message
// source prefix (watermark 50), limit 20 — the walk crosses the merged page
// boundary (base tail + own rows in ONE page), pages deep into the base, and
// must terminate at the base top. Page-by-page assertions: seqs strictly
// continuous (no duplicate, no gap), hasMore bits correct, final page exactly
// the remainder (no +1). This empirically pins the backend half of the #197
// fix: the cursor algebra itself is sound — the defect was the frontend's
// missing-cursor fallback (App.tsx loadMoreMessages `|| 0`), which re-asked
// for the newest merged page forever instead of continuing older.
func TestForkLineagePageWalkNoDupNoGap(t *testing.T) {
	svc, st := newLineageSvc(t)
	proj, err := st.CreateProject(svc.ctx, "p", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	src, err := st.CreateSession(svc.ctx, proj.ID, "src", "", "omp")
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 50; i++ {
		if _, err := st.AppendMessage(svc.ctx, src.ID, "agent", "", fmt.Sprintf("src-%d", i), ""); err != nil {
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
	if err := st.SetSessionForkBaseSeq(svc.ctx, fork.ID, 50); err != nil {
		t.Fatal(err)
	}
	ownRoles := []string{"user", "agent", "agent"}
	for i := 1; i <= 3; i++ {
		if _, err := st.AppendMessage(svc.ctx, fork.ID, ownRoles[i-1], "", fmt.Sprintf("own-%d", i), ""); err != nil {
			t.Fatal(err)
		}
	}

	const limit = 20
	// First-pull contract: beforeSeq<=0 fetches the NEWEST merged page as a
	// limit+1 probe window. The frontend's first pull AND its missing-cursor
	// recovery both rely on this — cursor 0 must never mean "continue older".
	first, err := svc.LoadMessagesPage(fork.ID, 0, limit)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != limit+1 {
		t.Fatalf("first pull = %d rows, want %d (limit+1 probe window)", len(first), limit+1)
	}
	if first[0].Seq != -18 || first[len(first)-1].Seq != 3 {
		t.Fatalf("first pull window = [%d..%d], want [-18..3]", first[0].Seq, first[len(first)-1].Seq)
	}

	// Walk upward exactly as App.tsx does: the probe row is msgs[0]; slice it
	// off; the next cursor is the NEW first (displayed-oldest) row.
	type page struct {
		seqs    []int64
		hasMore bool
	}
	var pages []page
	before := int64(0)
	for {
		msgs, err := svc.LoadMessagesPage(fork.ID, before, limit)
		if err != nil {
			t.Fatal(err)
		}
		hasMore := len(msgs) > limit
		if hasMore {
			msgs = msgs[1:]
		}
		if len(msgs) == 0 {
			t.Fatal("empty page mid-walk")
		}
		seqs := make([]int64, 0, len(msgs))
		for _, m := range msgs {
			seqs = append(seqs, m.Seq)
		}
		pages = append(pages, page{seqs, hasMore})
		before = msgs[0].Seq
		if !hasMore {
			break
		}
		if len(pages) > 10 {
			t.Fatal("pagination walk did not terminate")
		}
	}

	// Page shapes: merged boundary page, pure base middle page, base top page.
	if len(pages) != 3 {
		t.Fatalf("walk = %d pages, want 3 (boundary, base middle, base top)", len(pages))
	}
	wantHasMore := []bool{true, true, false}
	for i, p := range pages {
		if p.hasMore != wantHasMore[i] {
			t.Fatalf("pages[%d].hasMore = %v, want %v", i, p.hasMore, wantHasMore[i])
		}
		for j := 1; j < len(p.seqs); j++ {
			if p.seqs[j] <= p.seqs[j-1] {
				t.Fatalf("pages[%d] not strictly ascending at %d: %d then %d", i, j, p.seqs[j-1], p.seqs[j])
			}
		}
	}
	// Merged boundary page: base tail (negative offsets) and own rows in one page.
	boundary := pages[0].seqs
	if boundary[0] != -17 || boundary[len(boundary)-1] != 3 {
		t.Fatalf("boundary page = [%d..%d], want [-17..3]", boundary[0], boundary[len(boundary)-1])
	}
	// Final page: exactly the 13 remaining base-head rows — no +1 probe leaked.
	if len(pages[2].seqs) != 13 {
		t.Fatalf("final page = %d rows, want exactly 13", len(pages[2].seqs))
	}
	if pages[2].seqs[0] != -50 {
		t.Fatalf("final page starts at %d, want -50 (source seq 1 — base top reached)", pages[2].seqs[0])
	}
	// Assembled walk (pages prepended oldest-last) = the full transcript:
	// [-50..-1] ∪ [1..3] — no duplicate, no gap, one seam at -1 → 1.
	var flat []int64
	for i := len(pages) - 1; i >= 0; i-- {
		flat = append(flat, pages[i].seqs...)
	}
	if len(flat) != 53 {
		t.Fatalf("assembled walk = %d rows, want 53", len(flat))
	}
	for i := 1; i < len(flat); i++ {
		if flat[i]-flat[i-1] != 1 && !(flat[i-1] == -1 && flat[i] == 1) {
			t.Fatalf("assembled walk not continuous at %d: %d → %d", i, flat[i-1], flat[i])
		}
	}
}
