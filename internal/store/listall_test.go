package store

import (
	"context"
	"testing"
)

// TestListAllSessionsMatchesPerProject pins the bulk listing contract
// (request-storm fix step 3): per-project arrays deep-equal ListSessions,
// every project has a key, and 0-session projects map to an empty non-nil
// slice (nil would marshal to JSON null and break the frontend invariant).
func TestListAllSessionsMatchesPerProject(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	pa, err := s.CreateProject(ctx, "a", "/tmp/a", "m")
	if err != nil {
		t.Fatal(err)
	}
	pb, err := s.CreateProject(ctx, "b", "/tmp/b", "m") // stays session-less
	if err != nil {
		t.Fatal(err)
	}
	pc, err := s.CreateProject(ctx, "c", "/tmp/c", "m")
	if err != nil {
		t.Fatal(err)
	}

	mustCreate := func(pid, title string) string {
		t.Helper()
		sess, err := s.CreateSession(ctx, pid, title, "m", "omp")
		if err != nil {
			t.Fatal(err)
		}
		return sess.ID
	}
	a1 := mustCreate(pa.ID, "plain")
	a2 := mustCreate(pa.ID, "pinned")
	if err := s.SetSessionPinned(ctx, a2, true); err != nil {
		t.Fatal(err)
	}
	c1 := mustCreate(pc.ID, "only")

	got, err := s.ListAllSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}

	// Key set == project set; 0-session project has an empty NON-nil slice.
	if len(got) != 3 {
		t.Fatalf("key count = %d, want 3", len(got))
	}
	for _, pid := range []string{pa.ID, pb.ID, pc.ID} {
		if _, ok := got[pid]; !ok {
			t.Fatalf("missing key for project %s", pid)
		}
	}
	if got[pb.ID] == nil || len(got[pb.ID]) != 0 {
		t.Fatalf("0-session project value = %#v, want empty non-nil slice", got[pb.ID])
	}

	// Per-project deep equality with ListSessions (id order pinned-first).
	if ids :=  bulkSessionIDs(got[pa.ID]); len(ids) != 2 || ids[0] != a2 || ids[1] != a1 {
		t.Fatalf("project a order = %v, want [pinned %s, plain %s]", ids, a2, a1)
	}
	if ids :=  bulkSessionIDs(got[pc.ID]); len(ids) != 1 || ids[0] != c1 {
		t.Fatalf("project c = %v, want [%s]", ids, c1)
	}
	for _, pid := range []string{pa.ID, pb.ID, pc.ID} {
		per, err := s.ListSessions(ctx, pid)
		if err != nil {
			t.Fatal(err)
		}
		if len(per) != len(got[pid]) {
			t.Fatalf("project %s: bulk %d vs per-project %d", pid, len(got[pid]), len(per))
		}
		for i := range per {
			if per[i].ID != got[pid][i].ID {
				t.Fatalf("project %s[%d]: bulk %s vs per-project %s", pid, i, got[pid][i].ID, per[i].ID)
			}
		}
	}
}

func  bulkSessionIDs(list []Session) []string {
	out := make([]string, len(list))
	for i, se := range list {
		out[i] = se.ID
	}
	return out
}
