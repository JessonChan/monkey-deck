package chat

import (
	"context"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// TestCreateSessionWorktreeUnderCachesDir 验证 CreateSession(useWorktree=true) 把
// git worktree 创建在 cfg.CachesDir/worktrees/<proj>/<session> 下(而非 DataDir)。
// 不变量:worktree 是可再生缓存,必须落在 CachesDir,不污染 Application Support / Time Machine。
func TestCreateSessionWorktreeUnderCachesDir(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	// 1. 临时主仓库
	root := t.TempDir()
	mustRunGit(t, root, "init", "-q", root)
	mustWrite(t, filepath.Join(root, "a.txt"), "a")
	mustRunGit(t, root, "add", ".")
	mustRunGit(t, root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")

	// 2. 用分离的 dataDir / cachesDir 建 svc
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

	// 3. 建项目 + 建 session(带 worktree)
	proj, err := st.CreateProject(svc.ctx, "p", root, "")
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	se, err := svc.CreateSession(proj.ID, "test", "", true)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if se.WorktreePath == "" {
		t.Fatal("WorktreePath empty; worktree creation failed (fallback to project dir)")
	}
	// 核心:worktree 必须在 cachesDir 之下
	if !filepath.HasPrefix(se.WorktreePath, cachesDir) {
		t.Fatalf("WorktreePath %q not under CachesDir %q", se.WorktreePath, cachesDir)
	}
	wantPrefix := filepath.Join(cachesDir, "worktrees", proj.ID)
	if !filepath.HasPrefix(se.WorktreePath, wantPrefix) {
		t.Fatalf("WorktreePath %q not under expected %q", se.WorktreePath, wantPrefix)
	}
}
