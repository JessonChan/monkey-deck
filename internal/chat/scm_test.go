package chat

// scm_test.go:源码管理绑定的端到端测试(真实 git worktree,不启 opencode)。
// SCM 操作(SessionStage/Unstage/Discard/Commit/Changes)只碰 store + worktree,不碰 ACP,
// 故用临时 git 仓库 + 临时 store 覆盖「store 查找 session → worktree 操作」整条链。

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
	"github.com/jessonchan/monkey-deck/internal/worktree"
)

// newSCMService 建一个临时 store + 临时 git 仓库 + 一个挂在 worktree 上的 session。
func newSCMService(t *testing.T) (svc *ChatService, sessionID, wtPath string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	// 1. 临时主仓库
	root := t.TempDir()
	mustRunGit(t, root, "init", "-q", root)
	mustWrite(t, filepath.Join(root, "a.txt"), "a")
	mustWrite(t, filepath.Join(root, "b.txt"), "b")
	mustRunGit(t, root, "add", ".")
	mustRunGit(t, root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
	// 2. worktree + 分支
	wt := filepath.Join(t.TempDir(), "wt")
	branch := "md/scmtest"
	if err := worktree.Create(root, branch, wt, ""); err != nil {
		t.Fatalf("worktree.Create: %v", err)
	}
	// 3. 临时 store + session 指向 worktree
	dbPath := filepath.Join(t.TempDir(), "test.db")
	st, err := store.New(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc = NewChatService(&config.Config{DataDir: t.TempDir(), DBPath: dbPath, HarnessCmd: "opencode acp"})
	svc.ctx = context.Background()
	svc.st = st
	proj, err := st.CreateProject(svc.ctx, "p", root, "")
	if err != nil {
		t.Fatal(err)
	}
	se, err := st.CreateSession(svc.ctx, proj.ID, "scm", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetSessionWorktree(svc.ctx, se.ID, wt, branch); err != nil {
		t.Fatal(err)
	}
	return svc, se.ID, wt
}

func TestSCMBindings(t *testing.T) {
	svc, sid, wt := newSCMService(t)

	// 制造工作区改动:改 a、新增 c
	mustWrite(t, filepath.Join(wt, "a.txt"), "a-mod")
	mustWrite(t, filepath.Join(wt, "c.txt"), "c-new")

	// 初始:都在「更改」组(Staged=false),无暂存项
	got, err := svc.SessionChanges(sid)
	if err != nil {
		t.Fatal(err)
	}
	if stagedCount(got) != 0 || !hasFile(got, "a.txt", false) || !hasFile(got, "c.txt", false) {
		t.Fatalf("initial changes wrong: %+v", got)
	}

	// 暂存 a.txt → 进暂存组
	if err := svc.SessionStage(sid, []string{"a.txt"}); err != nil {
		t.Fatalf("SessionStage: %v", err)
	}
	got, _ = svc.SessionChanges(sid)
	if stagedCount(got) != 1 || !hasFile(got, "a.txt", true) {
		t.Fatalf("a.txt not staged: %+v", got)
	}

	// 取消暂存 → 回工作区组
	if err := svc.SessionUnstage(sid, []string{"a.txt"}); err != nil {
		t.Fatalf("SessionUnstage: %v", err)
	}
	got, _ = svc.SessionChanges(sid)
	if stagedCount(got) != 0 {
		t.Fatalf("expected no staged after unstage: %+v", got)
	}

	// 暂存全部 + 提交 → 工作区干净
	if err := svc.SessionStage(sid, nil); err != nil {
		t.Fatalf("SessionStage all: %v", err)
	}
	if err := svc.SessionCommit(sid, "scm commit"); err != nil {
		t.Fatalf("SessionCommit: %v", err)
	}
	got, _ = svc.SessionChanges(sid)
	if len(got) != 0 {
		t.Fatalf("expected clean after commit, got %+v", got)
	}

	// 提交无暂存改动应报错
	if err := svc.SessionCommit(sid, "empty"); err == nil {
		t.Fatal("SessionCommit on nothing-staged should error")
	}

	// Discard:改 a、新增 d → 丢弃 → 干净(a 还原到上次提交的 a-mod)
	mustWrite(t, filepath.Join(wt, "a.txt"), "dirty")
	mustWrite(t, filepath.Join(wt, "d.txt"), "d-new")
	if err := svc.SessionDiscard(sid, []string{"a.txt", "d.txt"}); err != nil {
		t.Fatalf("SessionDiscard: %v", err)
	}
	got, _ = svc.SessionChanges(sid)
	if len(got) != 0 {
		t.Fatalf("expected clean after discard, got %+v", got)
	}
	if b, _ := os.ReadFile(filepath.Join(wt, "a.txt")); string(b) != "a-mod" {
		t.Fatalf("a.txt not restored by discard: %q", b)
	}
}

// 无 worktree 的 session,所有 SCM 操作应返回错误(非 git 项目)。
func TestSCMNoWorktree(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")
	st, err := store.New(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc := NewChatService(&config.Config{DataDir: t.TempDir(), DBPath: dbPath})
	svc.ctx = context.Background()
	svc.st = st
	proj, _ := st.CreateProject(svc.ctx, "p", t.TempDir(), "")
	se, _ := st.CreateSession(svc.ctx, proj.ID, "", "")
	for name, fn := range map[string]func() error{
		"Stage":   func() error { return svc.SessionStage(se.ID, nil) },
		"Unstage": func() error { return svc.SessionUnstage(se.ID, nil) },
		"Discard": func() error { return svc.SessionDiscard(se.ID, []string{"x"}) },
		"Commit":  func() error { return svc.SessionCommit(se.ID, "m") },
	} {
		if err := fn(); err == nil {
			t.Fatalf("%s on no-worktree session should error", name)
		}
	}
}

// A:MergeSession 不再 auto-commit —— 已提交的内容被合并,未提交的改动不进主仓库且结果给出提示。
func TestMergeSessionNoAutoCommit(t *testing.T) {
	svc, sid, wt := newSCMService(t)
	ctx := context.Background()
	ses, _ := svc.st.GetSession(ctx, sid)
	proj, _ := svc.st.GetProject(ctx, ses.ProjectID)
	root := proj.Path

	// 在 worktree 改 a.txt 并提交(这部分应被合并)
	mustWrite(t, filepath.Join(wt, "a.txt"), "committed-change")
	mustRunGit(t, wt, "add", ".")
	mustRunGit(t, wt, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "real commit")
	// 再制造一个未提交改动(不应被合并)
	mustWrite(t, filepath.Join(wt, "uncommitted.txt"), "left-out")

	result, err := svc.MergeSession(sid)
	if err != nil {
		t.Fatalf("MergeSession: %v", err)
	}
	// 已提交的 a.txt 进了主仓库
	if b, _ := os.ReadFile(filepath.Join(root, "a.txt")); string(b) != "committed-change" {
		t.Fatalf("committed change not merged: %q", b)
	}
	// 未提交的文件没进主仓库
	if _, err := os.Stat(filepath.Join(root, "uncommitted.txt")); !os.IsNotExist(err) {
		t.Fatalf("uncommitted file should NOT be merged")
	}
	// 结果含未提交提示
	if !strings.Contains(result, "未提交") {
		t.Fatalf("result should warn about uncommitted: %q", result)
	}
}

// E:turn 进行中(busy)时,源代码管理写操作应被拒绝;读操作(SessionChanges)不受影响。
func TestSCMBusyGuard(t *testing.T) {
	svc, sid, _ := newSCMService(t)

	// 注入一个 busy 的 liveSession(模拟一轮 Prompt 进行中)
	ls := &liveSession{}
	ls.mu.Lock()
	ls.busy = true
	ls.mu.Unlock()
	svc.mu.Lock()
	svc.active[sid] = ls
	svc.mu.Unlock()

	for name, fn := range map[string]func() error{
		"Stage":   func() error { return svc.SessionStage(sid, nil) },
		"Unstage": func() error { return svc.SessionUnstage(sid, nil) },
		"Discard": func() error { return svc.SessionDiscard(sid, []string{"x"}) },
		"Commit":  func() error { return svc.SessionCommit(sid, "m") },
		"Merge":   func() error { _, e := svc.MergeSession(sid); return e },
	} {
		if err := fn(); err == nil {
			t.Fatalf("%s should be rejected while busy", name)
		}
	}
	// 读操作不被拒(随时可刷新状态)
	if _, err := svc.SessionChanges(sid); err != nil {
		t.Fatalf("SessionChanges should work while busy: %v", err)
	}
}

func stagedCount(got []worktree.FileChange) int {
	n := 0
	for _, f := range got {
		if f.Staged {
			n++
		}
	}
	return n
}

func hasFile(got []worktree.FileChange, path string, staged bool) bool {
	for _, f := range got {
		if f.Path == path && f.Staged == staged {
			return true
		}
	}
	return false
}

func mustRunGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s in %s: %v\n%s", args, dir, err, out)
	}
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
