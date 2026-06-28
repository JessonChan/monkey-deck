package worktree

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// 用临时 git 仓库验证 create / merge / remove 全流程。
func TestCreateMergeRemove(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	must(t, runGit(root, "init", "-q", root))
	must(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("a"), 0o644))
	must(t, runGit(root, "add", "."))
	must(t, runGit(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init"))

	if !IsRepo(root) {
		t.Fatal("IsRepo=false on a fresh repo")
	}
	base, err := HeadShort(root)
	if err != nil || base == "" {
		t.Fatalf("HeadShort: %v %q", err, base)
	}

	// 1. create worktree on a new branch
	wt := filepath.Join(t.TempDir(), "wt-a")
	branch := "md/sess-a"
	if err := Create(root, branch, wt, ""); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := os.Stat(filepath.Join(wt, "a.txt")); err != nil {
		t.Fatalf("worktree missing a.txt: %v", err)
	}
	if !BranchExists(root, branch) {
		t.Fatal("branch not created")
	}

	// 2. 在 worktree 里改文件并提交(模拟 agent 干活)
	must(t, os.WriteFile(filepath.Join(wt, "a.txt"), []byte("a-changed-by-agent"), 0o644))
	must(t, runGit(wt, "add", "."))
	must(t, runGit(wt, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "agent change"))

	// 主仓库的 a.txt 应仍是 "a"(隔离)
	b, _ := os.ReadFile(filepath.Join(root, "a.txt"))
	if string(b) != "a" {
		t.Fatalf("isolation broken: main repo changed before merge: %q", b)
	}

	// 3. merge worktree 分支进主仓库
	if err := MergeBranch(root, branch); err != nil {
		t.Fatalf("MergeBranch: %v", err)
	}
	b, _ = os.ReadFile(filepath.Join(root, "a.txt"))
	if string(b) != "a-changed-by-agent" {
		t.Fatalf("merge did not apply: %q", b)
	}

	// 4. remove worktree + branch
	if err := Remove(root, wt, branch); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if BranchExists(root, branch) {
		t.Fatal("branch still exists after Remove")
	}
}

func TestIsRepoNegative(t *testing.T) {
	if IsRepo(t.TempDir()) {
		t.Fatal("empty dir reported as repo")
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func runGit(dir string, args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	return cmd.Run()
}
