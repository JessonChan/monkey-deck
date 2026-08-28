package chat

import (
	"context"
	"reflect"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/acp"
)

// Service-side contract for the slash command cache (#152): the exact production
// callback body (persistCommandsCache, as wired in startLive) must land the full
// table in SQLite — an EMPTY table overwriting a populated one included — and
// GetSessionCachedCommands must hand the column states to the frontend as:
// never seeded → nil (no advertisement yet), valid JSON → parsed table,
// seeded-empty → empty non-nil table, corrupt → nil (degrade, never fail).

func TestPersistCommandsCacheRoundTrip(t *testing.T) {
	svc, sessionID, _ := newTestService(t)
	ctx := context.Background()

	// Never seeded: no advertisement yet → nil, nil.
	got, err := svc.GetSessionCachedCommands(sessionID)
	if err != nil || got != nil {
		t.Fatalf("never-seeded = %v, %v; want nil, nil", got, err)
	}

	// Populated table lands parsed and identical.
	seeded := []acp.SlashCommand{
		{Name: "model", Description: "Show model", InputHint: "[on|off]"},
		{Name: "test", Description: "Run tests"},
	}
	svc.persistCommandsCache(sessionID, seeded)
	got, err = svc.GetSessionCachedCommands(sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, seeded) {
		t.Fatalf("round trip = %+v, want %+v", got, seeded)
	}

	// Empty table OVERWRITES (a harness clearing its commands is legitimate):
	// seeded-empty state survives as an empty non-nil slice, not nil.
	svc.persistCommandsCache(sessionID, nil)
	got, err = svc.GetSessionCachedCommands(sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || len(got) != 0 {
		t.Fatalf("after empty overwrite = %v, want empty non-nil", got)
	}

	// Cache maintenance must not move updated_at (not content activity; a
	// mid-turn re-advertisement must not churn the sidebar secondary sort).
	se, err := svc.st.GetSession(ctx, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	svc.persistCommandsCache(sessionID, seeded)
	after, err := svc.st.GetSession(ctx, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if after.UpdatedAt != se.UpdatedAt {
		t.Fatalf("updated_at moved on cache write: %d → %d", se.UpdatedAt, after.UpdatedAt)
	}
}

// TestGetSessionCachedCommandsCorruptDegrade: a hand-broken cache row must
// degrade to nil, nil — never fail the read (the next advertisement re-seeds).
func TestGetSessionCachedCommandsCorruptDegrade(t *testing.T) {
	svc, sessionID, _ := newTestService(t)
	ctx := context.Background()
	svc.persistCommandsCache(sessionID, []acp.SlashCommand{{Name: "model", Description: "Show model"}})

	for _, bad := range []string{`not json`, `{"a":1}`, `[1,2]`, `null`} {
		// UpdateSessionCommandsCache is a verbatim passthrough (raw JSON in, raw
		// JSON out) — writing a corrupt value through it is equivalent to
		// hand-editing the row, and is the only cross-package way to plant one.
		if err := svc.st.UpdateSessionCommandsCache(ctx, sessionID, bad); err != nil {
			t.Fatal(err)
		}
		got, err := svc.GetSessionCachedCommands(sessionID)
		if err != nil {
			t.Fatalf("GetSessionCachedCommands with %q: %v", bad, err)
		}
		if got != nil {
			t.Fatalf("corrupt row %q decoded to %+v, want nil", bad, got)
		}
	}
}
