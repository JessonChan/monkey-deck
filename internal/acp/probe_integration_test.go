//go:build integration

package acp

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/harness"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// TestProbeAllHarnesses runs ProbeHarness — including the resume/cancel/set_config
// conformance probes — against every harness the running app knows: built-ins plus
// user-added harnesses loaded from the live SQLite store.
//
// Token cost is minimal: set_config_option and resume probes send NO prompt; the
// cancel probe fires a 1-token "hi" and cancels within 200ms (near-zero output);
// only the main "Reply OK" prompt runs to end_turn. Uninstalled harnesses fail at
// spawn (zero tokens). Run manually:
//
//	go test -tags integration -run TestProbeAllHarnesses -v ./internal/acp/ -timeout 30m
func TestProbeAllHarnesses(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Minute)
	defer cancel()

	type hc struct{ id, command string }
	var all []hc
	// 1. Built-in harnesses.
	for _, h := range harness.Supported {
		all = append(all, hc{h.ID, h.Command})
	}
	// 2. User-added harnesses from the app's live DB ("Monkey Deck" data dir).
	if dir, err := os.UserConfigDir(); err == nil {
		dbPath := filepath.Join(dir, "Monkey Deck", "monkey-deck.db")
		if st, err := store.New(dbPath); err == nil {
			if users, err := st.ListUserHarnesses(ctx); err == nil {
				for _, u := range users {
					all = append(all, hc{u.Name, u.Command})
				}
			} else {
				t.Logf("ListUserHarnesses: %v", err)
			}
			_ = st.Close()
		} else {
			t.Logf("open store %s: %v (skipping user harnesses)", dbPath, err)
		}
	}
	t.Logf("probing %d harnesses: %v", len(all), func() []string {
		out := make([]string, len(all))
		for i, h := range all {
			out[i] = h.id
		}
		return out
	}())

	for _, h := range all {
		h := h
		t.Run(h.id, func(t *testing.T) {
			rep := ProbeHarness(ctx, h.command)
			t.Log("\n" + rep.Summary())
			t.Logf("behavioral probes: resumeReplays=%v cancelHonored=%v setConfigWorks=%v",
				rep.ResumeReplays, rep.CancelHonored, rep.SetConfigWorks)
			t.Logf("fork(#172): declared=%v class=%q force=%q | newId=%s alive=%s list=%s resume=%s echo=%s cwd=%s chain=%s conc=%s err=%q",
				rep.Fork.Declared, rep.Fork.ForceClass, rep.Fork.Force,
				rep.Fork.NewID.Note, rep.Fork.SourceAlive.Note, rep.Fork.InList.Note,
				rep.Fork.Resumable.Note, rep.Fork.Echo.Note, rep.Fork.Cwd.Note,
				rep.Fork.Chain.Note, rep.Fork.Concurrent.Note, rep.Fork.Error)
			t.Logf("busy-fork(#191): ①fork=%+v\n②snap=%+v\n③src=%+v\n④use=%+v err=%q",
				rep.Fork.BusyFork, rep.Fork.BusySnap, rep.Fork.BusySrcOK, rep.Fork.BusyForkUse, rep.Fork.Error)
			if rep.Error != "" {
				t.Logf("probe self-error: %s", rep.Error)
				return
			}
			// Non-blocking conformance flags (informational warnings, not failures).
			if rep.ResumeReplays {
				t.Logf("⚠ %s: session/resume replays history (violates session-resume.mdx MUST NOT replay)", h.id)
			}
			if rep.PromptTurn.Pass && !rep.CancelHonored {
				t.Logf("⚠ %s: session/cancel not honored (expected stopReason=cancelled)", h.id)
			}
			if rep.HasModelOption && !rep.SetConfigWorks {
				t.Logf("⚠ %s: session/set_config_option round-trip failed", h.id)
			}
		})
	}
}

// TestProbeBusyForkHarness — #191: focused busy-fork measurement against ONE
// harness command (no user-DB enumeration). Default "omp acp"; override with
// MD_PROBE_CMD. Prints the full report + the four busy-fork rows so the raw
// notes (含失败原文) can be transcribed into the worklog verbatim.
//
//	go test -tags integration -run TestProbeBusyForkHarness -v ./internal/acp/ -timeout 20m
func TestProbeBusyForkHarness(t *testing.T) {
	cmd := os.Getenv("MD_PROBE_CMD")
	if cmd == "" {
		cmd = "omp acp"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	rep := ProbeHarness(ctx, cmd)
	t.Log("\n" + rep.Summary())
	t.Logf("busy-fork(#191): declared=%v\n①fork=%+v\n②snap=%+v\n③src=%+v\n④use=%+v err=%q",
		rep.Fork.Declared, rep.Fork.BusyFork, rep.Fork.BusySnap, rep.Fork.BusySrcOK, rep.Fork.BusyForkUse, rep.Fork.Error)
	if rep.Error != "" {
		t.Logf("probe self-error: %s", rep.Error)
	}
}
