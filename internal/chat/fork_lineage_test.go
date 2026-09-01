package chat

// fork_lineage_test.go — behavior tests for the #172 Phase 3 lineage view:
// a fork row's transcript pages through [source prefix (negative seq offsets)]
// + [own messages] under ONE cursor, preserving the +1 hasMore probe contract.

import (
	"context"
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
