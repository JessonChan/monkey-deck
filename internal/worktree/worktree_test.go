package worktree

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
	if _, err := MergeBranch(root, branch); err != nil {
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

// 验证 StatusFiles 的暂存/工作区两组分离,以及 Stage/Unstage/Discard/Commit 全流程。
func TestStageUnstageCommitDiscard(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	repo := t.TempDir()
	must(t, runGit(repo, "init", "-q", repo))
	must(t, os.WriteFile(filepath.Join(repo, "a.txt"), []byte("a"), 0o644))
	must(t, os.WriteFile(filepath.Join(repo, "b.txt"), []byte("b"), 0o644))
	must(t, runGit(repo, "add", "."))
	must(t, runGit(repo, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init"))

	// 制造三类工作区改动:修改已跟踪 a、删除已跟踪 b、新增未跟踪 c
	must(t, os.WriteFile(filepath.Join(repo, "a.txt"), []byte("a-mod"), 0o644))
	must(t, os.Remove(filepath.Join(repo, "b.txt")))
	must(t, os.WriteFile(filepath.Join(repo, "c.txt"), []byte("c-new"), 0o644))

	// 全部应出现在工作区组(Staged=false)
	got, err := StatusFiles(repo)
	must(t, err)
	if !hasChange(got, "a.txt", "M", false) || !hasChange(got, "b.txt", "D", false) || !hasChange(got, "c.txt", "U", false) {
		t.Fatalf("initial status wrong: %+v", got)
	}
	if hasStaged(got) {
		t.Fatalf("expected no staged entries yet: %+v", got)
	}

	// 暂存 a.txt → 应进暂存组
	must(t, Stage(repo, "a.txt"))
	got, _ = StatusFiles(repo)
	if !hasChange(got, "a.txt", "M", true) {
		t.Fatalf("a.txt not staged: %+v", got)
	}

	// 取消暂存 a.txt → 回到工作区组
	must(t, Unstage(repo, "a.txt"))
	got, _ = StatusFiles(repo)
	if hasStaged(got) {
		t.Fatalf("expected no staged after unstage: %+v", got)
	}
	if !hasChange(got, "a.txt", "M", false) {
		t.Fatalf("a.txt not back to worktree group: %+v", got)
	}

	// Stage 全部 + 提交(只 commit index)→ 工作区干净
	must(t, Stage(repo)) // 空 paths = add -A
	must(t, Commit(repo, "stage and commit"))
	got, _ = StatusFiles(repo)
	if len(got) != 0 {
		t.Fatalf("expected clean tree after commit, got %+v", got)
	}

	// Commit 无暂存改动应报错(nothing to commit)
	if err := Commit(repo, "empty"); err == nil {
		t.Fatal("Commit on nothing-staged should error")
	}

	// 制造新改动后测 Discard:未跟踪文件被删除、已跟踪修改被还原
	must(t, os.WriteFile(filepath.Join(repo, "a.txt"), []byte("dirty"), 0o644))
	must(t, os.WriteFile(filepath.Join(repo, "d.txt"), []byte("d-new"), 0o644))
	must(t, Discard(repo, "a.txt", "d.txt"))
	got, _ = StatusFiles(repo)
	if len(got) != 0 {
		t.Fatalf("expected clean after discard, got %+v", got)
	}
	b, _ := os.ReadFile(filepath.Join(repo, "a.txt"))
	if string(b) != "a-mod" { // 提交过的内容是 a-mod
		t.Fatalf("tracked file not restored by Discard: %q", b)
	}
	if _, err := os.Stat(filepath.Join(repo, "d.txt")); err == nil {
		t.Fatal("untracked file not removed by Discard")
	}
}

func hasChange(got []FileChange, path, status string, staged bool) bool {
	for _, f := range got {
		if f.Path == path && f.Status == status && f.Staged == staged {
			return true
		}
	}
	return false
}

func hasStaged(got []FileChange) bool {
	for _, f := range got {
		if f.Staged {
			return true
		}
	}
	return false
}

// 验证 StatusFiles 正确解析重命名(R -> new)、含空格路径(去引号),以及 FileDiff 三场景。
func TestStatusRenameSpacesAndDiff(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	repo := t.TempDir()
	must(t, runGit(repo, "init", "-q", repo))
	must(t, os.WriteFile(filepath.Join(repo, "a.txt"), []byte("a"), 0o644))
	must(t, os.WriteFile(filepath.Join(repo, "b.txt"), []byte("b"), 0o644))
	must(t, runGit(repo, "add", "."))
	must(t, runGit(repo, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init"))

	// 重命名 a.txt -> renamed.txt(git mv 暂存为 R)
	must(t, runGit(repo, "mv", "a.txt", "renamed.txt"))
	// 含空格路径的新文件(未跟踪)
	must(t, os.WriteFile(filepath.Join(repo, "my file.txt"), []byte("new"), 0o644))
	// 另一个独立的未跟踪文件(专供 untracked diff 测试,不会被 stage)
	must(t, os.WriteFile(filepath.Join(repo, "brand-new.txt"), []byte("fresh"), 0o644))
	// 已跟踪 b.txt 改动(工作区,供 diff)
	must(t, os.WriteFile(filepath.Join(repo, "b.txt"), []byte("b-mod"), 0o644))

	got, err := StatusFiles(repo)
	must(t, err)
	// 重命名:解析出新名 + R + 暂存(核心 B:旧实现会把 "a.txt -> renamed.txt" 整串当 path)
	if !hasChange(got, "renamed.txt", "R", true) {
		t.Fatalf("rename not parsed (expected renamed.txt R staged): %+v", got)
	}
	// 含空格路径:引号去掉(核心 C:旧实现会保留 \"my file.txt\" 带引号)
	if !hasChange(got, "my file.txt", "U", false) {
		t.Fatalf("spaces path not parsed: %+v", got)
	}
	// 去引号后的路径必须可被 Stage 命中(端到端验证 C)
	must(t, Stage(repo, "my file.txt"))
	got, _ = StatusFiles(repo)
	if !hasChange(got, "my file.txt", "A", true) {
		t.Fatalf("spaces path not staged (add failed?): %+v", got)
	}

	// FileDiff:工作区已跟踪改动
	d, err := FileDiff(repo, "b.txt", false)
	must(t, err)
	if !strings.Contains(d, "+b-mod") {
		t.Fatalf("FileDiff unstaged wrong:\n%s", d)
	}
	// FileDiff:未跟踪文件展示为纯新增(用独立的 brand-new.txt,确保未被 stage)
	d2, err := FileDiff(repo, "brand-new.txt", false)
	must(t, err)
	if !strings.Contains(d2, "+fresh") {
		t.Fatalf("FileDiff untracked wrong:\n%s", d2)
	}
	// FileDiff:暂存后 staged=true 取 index 相对 HEAD
	must(t, Stage(repo, "b.txt"))
	d3, err := FileDiff(repo, "b.txt", true)
	must(t, err)
	if !strings.Contains(d3, "+b-mod") {
		t.Fatalf("FileDiff staged wrong:\n%s", d3)
	}
}
