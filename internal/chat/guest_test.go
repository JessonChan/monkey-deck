package chat

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// guest_test.go: owner/guest worktree model (enter existing worktree).
//
// Locks the invariants of the "enter existing worktree" feature:
//   - WorktreeKind derives project/owner/guest from session fields (no DB column).
//   - CreateGuestSession pins a session to an existing linked worktree (guest), sharing the
//     owner's branch resolved from git truth.
//   - DeleteSession is chat-only (never removes the worktree — that's DeleteWorktree).
//   - DeleteWorktree is owner-only (guest/project refused).
//   - DetachWorktreeGuests clears guest refs (→ project dir) while keeping history.
//   - SessionMergeable is false for guests even when their branch has commits ahead.

// setupGuestService builds a ChatService on a temp git repo (root) + temp store, mirroring
// worktree_path_test.go. Returns service, project, repo root.
func setupGuestService(t *testing.T) (*ChatService, *store.Project, string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	mustRunGit(t, root, "init", "-q", root)
	mustWrite(t, filepath.Join(root, "a.txt"), "a")
	mustRunGit(t, root, "add", ".")
	mustRunGit(t, root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")

	dataDir := t.TempDir()
	cachesDir := t.TempDir()
	dbPath := filepath.Join(dataDir, "test.db")
	st, err := store.New(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	cfg := &config.Config{DataDir: dataDir, CachesDir: cachesDir, DBPath: dbPath}
	svc := NewChatService(cfg)
	svc.ctx = context.Background()
	svc.st = st
	proj, err := st.CreateProject(svc.ctx, "p", root, "")
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	return svc, proj, root
}

func TestWorktreeKind_OwnerGuestProject(t *testing.T) {
	svc, proj, _ := setupGuestService(t)

	projSe, err := svc.CreateSession(proj.ID, "proj", "", false, "", nil)
	if err != nil {
		t.Fatalf("CreateSession project: %v", err)
	}
	if k, _ := svc.WorktreeKind(projSe.ID); k != "project" {
		t.Fatalf("project kind = %q, want project", k)
	}

	owner, err := svc.CreateSession(proj.ID, "owner", "", true, "", nil)
	if err != nil {
		t.Fatalf("CreateSession owner: %v", err)
	}
	if k, _ := svc.WorktreeKind(owner.ID); k != "owner" {
		t.Fatalf("owner kind = %q, want owner", k)
	}

	guest, err := svc.CreateGuestSession(proj.ID, "guest", "", owner.WorktreePath, nil)
	if err != nil {
		t.Fatalf("CreateGuestSession: %v", err)
	}
	if k, _ := svc.WorktreeKind(guest.ID); k != "guest" {
		t.Fatalf("guest kind = %q, want guest", k)
	}
	// Guest shares the owner's worktree + branch (branch resolved from git, single source).
	if guest.WorktreePath != owner.WorktreePath {
		t.Fatalf("guest worktreePath = %q, want %q", guest.WorktreePath, owner.WorktreePath)
	}
	if guest.Branch != owner.Branch {
		t.Fatalf("guest branch = %q, want %q", guest.Branch, owner.Branch)
	}

	guests, err := svc.WorktreeGuests(owner.ID)
	if err != nil {
		t.Fatalf("WorktreeGuests: %v", err)
	}
	if len(guests) != 1 || guests[0].ID != guest.ID {
		t.Fatalf("WorktreeGuests = %+v, want [%s]", guests, guest.ID)
	}
}

func TestDeleteSession_KeepsWorktree(t *testing.T) {
	svc, proj, _ := setupGuestService(t)
	owner, err := svc.CreateSession(proj.ID, "owner", "", true, "", nil)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	wtPath := owner.WorktreePath
	if wtPath == "" {
		t.Fatal("no worktree created")
	}
	// DeleteSession is chat-only now: the worktree directory must survive (worktree deletion
	// is a separate atomic op, DeleteWorktree). OLD code removed it here → this test fails.
	if err := svc.DeleteSession(owner.ID); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	if _, err := os.Stat(wtPath); err != nil {
		t.Fatalf("worktree dir gone after DeleteSession (must survive): %v", err)
	}
}

func TestDeleteWorktree_OwnerOnly(t *testing.T) {
	svc, proj, root := setupGuestService(t)
	owner, err := svc.CreateSession(proj.ID, "owner", "", true, "", nil)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	guest, err := svc.CreateGuestSession(proj.ID, "guest", "", owner.WorktreePath, nil)
	if err != nil {
		t.Fatalf("CreateGuestSession: %v", err)
	}
	wtPath := owner.WorktreePath

	// Guest must NOT be able to delete the owner's worktree.
	if err := svc.DeleteWorktree(guest.ID, false); err == nil {
		t.Fatal("DeleteWorktree on a guest must fail")
	}
	// Remove the guest chat first (the frontend's job in the real flow): with no live
	// guests left, the unforced owner delete passes the #199 guard and removes it.
	if err := svc.DeleteSession(guest.ID); err != nil {
		t.Fatalf("DeleteSession guest: %v", err)
	}
	if err := svc.DeleteWorktree(owner.ID, false); err != nil {
		t.Fatalf("DeleteWorktree owner: %v", err)
	}
	if _, err := os.Stat(wtPath); !os.IsNotExist(err) {
		t.Fatalf("worktree dir still exists after owner DeleteWorktree: %v", err)
	}
	if gitSucceeds(t, root, "rev-parse", "--verify", owner.Branch) {
		t.Fatalf("branch %s still exists after owner DeleteWorktree", owner.Branch)
	}
}

// TestDeleteWorktree_GuestGuard locks #199 fix 1: an unforced DeleteWorktree with a LIVE
// guest on the worktree is refused, the worktree directory AND branch survive untouched,
// and the error carries the guest count (surfaced verbatim in the UI toast, §4.4).
func TestDeleteWorktree_GuestGuard(t *testing.T) {
	svc, proj, root := setupGuestService(t)
	owner, err := svc.CreateSession(proj.ID, "owner", "", true, "", nil)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, err := svc.CreateGuestSession(proj.ID, "guest", "", owner.WorktreePath, nil); err != nil {
		t.Fatalf("CreateGuestSession: %v", err)
	}
	wtPath := owner.WorktreePath

	err = svc.DeleteWorktree(owner.ID, false)
	if err == nil {
		t.Fatal("unforced DeleteWorktree with a live guest must be refused")
	}
	if !strings.Contains(err.Error(), "1 chats still use this worktree") {
		t.Fatalf("error must carry the guest count, got: %v", err)
	}
	// Rejected = atomic no-op: directory and branch both survive.
	if _, err := os.Stat(wtPath); err != nil {
		t.Fatalf("worktree dir must survive a refused delete: %v", err)
	}
	if !gitSucceeds(t, root, "rev-parse", "--verify", owner.Branch) {
		t.Fatalf("branch %s must survive a refused delete", owner.Branch)
	}
}

// TestDeleteWorktree_ForceBypassesGuestGuard locks the force escape hatch (#199): force=true
// removes the worktree + branch even with live guests (the dialog's "delete all" option —
// the user already confirmed). Current semantics: only worktree+branch go; guest ROWS are
// the frontend's job (it deletes them via DeleteSession before calling with force).
func TestDeleteWorktree_ForceBypassesGuestGuard(t *testing.T) {
	svc, proj, root := setupGuestService(t)
	owner, err := svc.CreateSession(proj.ID, "owner", "", true, "", nil)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	guest, err := svc.CreateGuestSession(proj.ID, "guest", "", owner.WorktreePath, nil)
	if err != nil {
		t.Fatalf("CreateGuestSession: %v", err)
	}

	if err := svc.DeleteWorktree(owner.ID, true); err != nil {
		t.Fatalf("forced DeleteWorktree with a live guest must pass: %v", err)
	}
	if _, err := os.Stat(owner.WorktreePath); !os.IsNotExist(err) {
		t.Fatalf("worktree dir still exists after forced DeleteWorktree: %v", err)
	}
	if gitSucceeds(t, root, "rev-parse", "--verify", owner.Branch) {
		t.Fatalf("branch %s still exists after forced DeleteWorktree", owner.Branch)
	}
	// Guest row survives with a dangling ref — document current semantics.
	se, err := svc.st.GetSession(svc.ctx, guest.ID)
	if err != nil || se == nil {
		t.Fatalf("guest row must survive a forced worktree delete: %v", err)
	}
}

// gitSucceeds reports whether the git command exits 0 (test ⑤ helper: branch
// existence probes must not fatal on the "gone" expectation).
func gitSucceeds(t *testing.T, dir string, args ...string) bool {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	return cmd.Run() == nil
}

func TestDetachWorktreeGuests(t *testing.T) {
	svc, proj, _ := setupGuestService(t)
	owner, err := svc.CreateSession(proj.ID, "owner", "", true, "", nil)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	g1, err := svc.CreateGuestSession(proj.ID, "g1", "", owner.WorktreePath, nil)
	if err != nil {
		t.Fatalf("CreateGuestSession g1: %v", err)
	}
	g2, err := svc.CreateGuestSession(proj.ID, "g2", "", owner.WorktreePath, nil)
	if err != nil {
		t.Fatalf("CreateGuestSession g2: %v", err)
	}

	// Detach: guests' worktree refs cleared (→ fall back to project dir, history kept);
	// owner keeps its ref (cleared by its own DeleteSession elsewhere).
	if err := svc.DetachWorktreeGuests(owner.ID); err != nil {
		t.Fatalf("DetachWorktreeGuests: %v", err)
	}
	for _, gid := range []string{g1.ID, g2.ID} {
		se, _ := svc.st.GetSession(svc.ctx, gid)
		if se == nil || se.WorktreePath != "" || se.Branch != "" {
			t.Fatalf("guest %s not detached: %+v", gid, se)
		}
	}
	if k, _ := svc.WorktreeKind(owner.ID); k != "owner" {
		t.Fatalf("owner kind changed after detach: %q", k)
	}
}

func TestSessionMergeable_GuestFalse(t *testing.T) {
	svc, proj, _ := setupGuestService(t)
	owner, err := svc.CreateSession(proj.ID, "owner", "", true, "", nil)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	// Commit in the owner worktree → branch ahead of base → owner IS mergeable.
	mustWrite(t, filepath.Join(owner.WorktreePath, "a.txt"), "changed")
	mustRunGit(t, owner.WorktreePath, "add", ".")
	mustRunGit(t, owner.WorktreePath, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "wip")
	if ok, _ := svc.SessionMergeable(owner.ID); !ok {
		t.Fatal("owner should be mergeable (branch ahead of base)")
	}
	// Guest shares the same ahead branch but must NOT be mergeable (guest guard short-circuits).
	guest, err := svc.CreateGuestSession(proj.ID, "guest", "", owner.WorktreePath, nil)
	if err != nil {
		t.Fatalf("CreateGuestSession: %v", err)
	}
	if ok, _ := svc.SessionMergeable(guest.ID); ok {
		t.Fatal("guest must not be mergeable")
	}
}
