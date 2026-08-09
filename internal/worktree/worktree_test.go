package worktree

import (
	"errors"
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

	// 3. merge worktree 分支进主仓库(--no-ff -m 强制用指定 message 生成 merge commit)
	msg := "Merge md/test: 测试合并信息"
	if _, err := MergeBranch(root, branch, msg); err != nil {
		t.Fatalf("MergeBranch: %v", err)
	}
	b, _ = os.ReadFile(filepath.Join(root, "a.txt"))
	if string(b) != "a-changed-by-agent" {
		t.Fatalf("merge did not apply: %q", b)
	}
	// --no-ff -m 应生成一条 merge commit,其信息等于传入的 message
	got, _ := git(root, "log", "-1", "--pretty=%s")
	if got != msg {
		t.Fatalf("merge commit message = %q, want %q", got, msg)
	}

	// 4. remove worktree + branch
	if err := Remove(root, wt, branch); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if BranchExists(root, branch) {
		t.Fatal("branch still exists after Remove")
	}
}

// 冲突时 MergeBranch 必须 git merge --abort 把主仓库回滚到合并前,
// 返回 *MergeConflictError 列出冲突文件。主仓库绝不卡在半合并状态
// (复现并锁守:此前冲突会留 MERGE_HEAD + 冲突标记,应用内无解,只能终端救场)。
func TestMergeBranchConflictAborts(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	must(t, runGit(root, "init", "-q", root))
	must(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("base"), 0o644))
	must(t, runGit(root, "add", "."))
	must(t, runGit(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init"))

	// 分支侧:在 worktree 改 a.txt 同一行并提交
	wt := filepath.Join(t.TempDir(), "wt-conflict")
	branch := "md/conflict"
	must(t, Create(root, branch, wt, ""))
	must(t, os.WriteFile(filepath.Join(wt, "a.txt"), []byte("agent-side"), 0o644))
	must(t, runGit(wt, "add", "."))
	must(t, runGit(wt, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "agent"))

	// 主仓库侧:也改 a.txt 同一行并提交 → 合并必冲突
	must(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("main-side"), 0o644))
	must(t, runGit(root, "add", "."))
	must(t, runGit(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "main"))

	headBefore, _ := git(root, "rev-parse", "HEAD")

	_, err := MergeBranch(root, branch, "Merge "+branch+": 冲突测试")
	if err == nil {
		t.Fatal("MergeBranch should fail on conflict")
	}
	var ce *MergeConflictError
	if !errors.As(err, &ce) {
		t.Fatalf("want *MergeConflictError, got %T: %v", err, err)
	}
	if len(ce.Files) != 1 || ce.Files[0] != "a.txt" {
		t.Fatalf("conflict files = %v, want [a.txt]", ce.Files)
	}

	// 主仓库必须回到合并前:无 MERGE_HEAD、a.txt 是主仓库版本(无冲突标记)、HEAD 未动、工作区干净。
	if _, e := git(root, "rev-parse", "--verify", "-q", "MERGE_HEAD"); e == nil {
		t.Fatal("MERGE_HEAD still present — repo stuck in merge state")
	}
	b, _ := os.ReadFile(filepath.Join(root, "a.txt"))
	if string(b) != "main-side" {
		t.Fatalf("a.txt = %q after abort, want %q (rolled back, no conflict markers)", b, "main-side")
	}
	headAfter, _ := git(root, "rev-parse", "HEAD")
	if headAfter != headBefore {
		t.Fatalf("HEAD moved: %s -> %s", headBefore, headAfter)
	}
	if files, _ := StatusFiles(root); len(files) != 0 {
		t.Fatalf("working tree not clean after abort: %+v", files)
	}
}

func TestIsRepoNegative(t *testing.T) {
	if IsRepo(t.TempDir()) {
		t.Fatal("empty dir reported as repo")
	}
}

// TestFindSubRepo_FindsImmediateChild:project 目录本身非 repo,但直接子目录是 repo → 返回该子目录。
func TestFindSubRepo_FindsImmediateChild(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir() // 非 git 的 project 目录
	sub := filepath.Join(root, "actual-repo")
	must(t, os.MkdirAll(sub, 0o755))
	must(t, runGit(sub, "init", "-q", sub))
	must(t, os.WriteFile(filepath.Join(sub, "a.txt"), []byte("a"), 0o644))
	must(t, runGit(sub, "add", "."))
	must(t, runGit(sub, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init"))

	got := FindSubRepo(root)
	if normalizePath(got) != normalizePath(sub) {
		t.Fatalf("FindSubRepo = %q, want %q", got, sub)
	}
	// 反向:子目录自己调,root 自身不是候选 → 返回空。
	if FindSubRepo(sub) != "" {
		t.Fatalf("FindSubRepo on a leaf repo should return empty, got %q", FindSubRepo(sub))
	}
}

// TestFindSubRepo_FindsNestedChild:子 repo 在第二层(root/x/nested/.git)→ 仍能找到(默认 depth=2)。
func TestFindSubRepo_FindsNestedChild(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	nested := filepath.Join(root, "wrapper", "inner-repo")
	must(t, os.MkdirAll(nested, 0o755))
	must(t, runGit(nested, "init", "-q", nested))
	must(t, os.WriteFile(filepath.Join(nested, "a.txt"), []byte("a"), 0o644))
	must(t, runGit(nested, "add", "."))
	must(t, runGit(nested, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init"))

	got := FindSubRepo(root)
	if normalizePath(got) != normalizePath(nested) {
		t.Fatalf("FindSubRepo = %q, want %q", got, nested)
	}
}

// TestFindSubRepo_DepthLimitExceeded:子 repo 在第三层(超过默认 depth=2)→ 找不到,返回空。
func TestFindSubRepo_DepthLimitExceeded(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	deep := filepath.Join(root, "a", "b", "deep-repo") // 第 3 层
	must(t, os.MkdirAll(deep, 0o755))
	must(t, runGit(deep, "init", "-q", deep))
	must(t, os.WriteFile(filepath.Join(deep, "a.txt"), []byte("a"), 0o644))
	must(t, runGit(deep, "add", "."))
	must(t, runGit(deep, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init"))

	if got := FindSubRepo(root); got != "" {
		t.Fatalf("FindSubRepo should not find depth-3 repo (max depth=2), got %q", got)
	}
}

// TestFindSubRepo_PrunesDependencyDirs:node_modules / vendor 等依赖目录里的 .git 应被跳过。
// 当唯一含 .git 的是 node_modules 下的 vendored repo 时,FindSubRepo 应返回空(避免假阳性)。
func TestFindSubRepo_PrunesDependencyDirs(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	// 一个 vendored repo 在 node_modules 下(应被剪枝跳过)
	vendored := filepath.Join(root, "node_modules", "some-pkg")
	must(t, os.MkdirAll(vendored, 0o755))
	must(t, runGit(vendored, "init", "-q", vendored))
	must(t, os.WriteFile(filepath.Join(vendored, "a.txt"), []byte("a"), 0o644))
	must(t, runGit(vendored, "add", "."))
	must(t, runGit(vendored, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "v"))

	if got := FindSubRepo(root); got != "" {
		t.Fatalf("FindSubRepo should skip node_modules vendored repo, got %q", got)
	}
	// 同理验证 vendor(Go vendoring 常含上游 .git)
	vendored2 := filepath.Join(root, "vendor", "github.com", "x", "y")
	must(t, os.MkdirAll(vendored2, 0o755))
	must(t, runGit(vendored2, "init", "-q", vendored2))
	must(t, os.WriteFile(filepath.Join(vendored2, "a.txt"), []byte("a"), 0o644))
	must(t, runGit(vendored2, "add", "."))
	must(t, runGit(vendored2, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "v"))
	if got := FindSubRepo(root); got != "" {
		t.Fatalf("FindSubRepo should skip vendor dir, got %q", got)
	}
}

// TestFindSubRepo_PrefersNonDependencyRepo:同时存在 node_modules 假 repo 与真实子 repo,
// 应跳过依赖目录返回真实子 repo。
func TestFindSubRepo_PrefersNonDependencyRepo(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	// 依赖目录下的假阳性
	vendored := filepath.Join(root, "node_modules", "z-pkg") // 名字排序靠后,确保不是因为排序跳过
	must(t, os.MkdirAll(vendored, 0o755))
	must(t, runGit(vendored, "init", "-q", vendored))
	must(t, os.WriteFile(filepath.Join(vendored, "a.txt"), []byte("a"), 0o644))
	must(t, runGit(vendored, "add", "."))
	must(t, runGit(vendored, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "v"))
	// 真实子 repo
	real := filepath.Join(root, "src-repo")
	must(t, os.MkdirAll(real, 0o755))
	must(t, runGit(real, "init", "-q", real))
	must(t, os.WriteFile(filepath.Join(real, "a.txt"), []byte("a"), 0o644))
	must(t, runGit(real, "add", "."))
	must(t, runGit(real, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "r"))

	got := FindSubRepo(root)
	if normalizePath(got) != normalizePath(real) {
		t.Fatalf("FindSubRepo = %q, want real repo %q", got, real)
	}
}

// TestFindSubRepo_EmptyOrMissingDir:空目录 / 不存在的目录 → 返回空,不 panic。
func TestFindSubRepo_EmptyOrMissingDir(t *testing.T) {
	if got := FindSubRepo(t.TempDir()); got != "" {
		t.Fatalf("FindSubRepo on empty dir should return empty, got %q", got)
	}
	if got := FindSubRepo(filepath.Join(t.TempDir(), "does-not-exist")); got != "" {
		t.Fatalf("FindSubRepo on missing dir should return empty, got %q", got)
	}
}

// TestFindSubRepo_FirstBySortedOrder:多个子 repo 时返回名字排序最前者(结果稳定可复现)。
func TestFindSubRepo_FirstBySortedOrder(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	for _, name := range []string{"zebra", "alpha", "mango"} {
		sub := filepath.Join(root, name)
		must(t, os.MkdirAll(sub, 0o755))
		must(t, runGit(sub, "init", "-q", sub))
		must(t, os.WriteFile(filepath.Join(sub, "a.txt"), []byte("a"), 0o644))
		must(t, runGit(sub, "add", "."))
		must(t, runGit(sub, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init"))
	}
	got := FindSubRepo(root)
	want := filepath.Join(root, "alpha")
	if normalizePath(got) != normalizePath(want) {
		t.Fatalf("FindSubRepo = %q, want %q (sorted first)", got, want)
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

// initRepoWithBranch 初始化临时仓库,在指定分支名上做首次提交,返回仓库根路径。
func initRepoWithBranch(t *testing.T, branch string) string {
	t.Helper()
	root := t.TempDir()
	// -b 指定初始分支名(新版 git 支持;旧版回退 init + checkout)。
	if err := runGit(root, "init", "-q", "-b", branch, root); err != nil {
		must(t, runGit(root, "init", "-q", root))
		must(t, runGit(root, "checkout", "-q", "-b", branch))
	}
	must(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("a"), 0o644))
	must(t, runGit(root, "add", "."))
	must(t, runGit(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init"))
	return root
}

// headBranch 返回仓库当前 HEAD 分支短名(detached 返回空)。
func headBranch(t *testing.T, root string) string {
	t.Helper()
	out, err := exec.Command("git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD").Output()
	must(t, err)
	return strings.TrimSpace(string(out))
}

// TestResolveDefaultBaseRef 探测默认基线分支:main / master 都能命中,无 main/master 的空仓库报 ErrNoBaseRef。
func TestResolveDefaultBaseRef(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	for _, name := range []string{"main", "master"} {
		t.Run(name, func(t *testing.T) {
			root := initRepoWithBranch(t, name)
			got, err := ResolveDefaultBaseRef(root)
			if err != nil {
				t.Fatalf("ResolveDefaultBaseRef: %v", err)
			}
			if got != name {
				t.Fatalf("got %q, want %q", got, name)
			}
		})
	}
	// 空仓库(无 main/master,只有 develop)→ ErrNoBaseRef(Route A strict 不回退 HEAD)。
	t.Run("no_main_master", func(t *testing.T) {
		root := initRepoWithBranch(t, "develop")
		_, err := ResolveDefaultBaseRef(root)
		if !errors.Is(err, ErrNoBaseRef) {
			t.Fatalf("got err=%v, want ErrNoBaseRef", err)
		}
	})
}

// TestResolveAddBaseRef 消歧:纯名→refs/heads;含/→先 refs/remotes 再 refs/heads;refs/ 前缀原样;不存在回退原串。
func TestResolveAddBaseRef(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := initRepoWithBranch(t, "main")
	// 建一个本地分支 develop。
	must(t, runGit(root, "branch", "develop"))

	// 纯名 main → refs/heads/main(存在)
	if got := ResolveAddBaseRef(root, "main"); got != "refs/heads/main" {
		t.Fatalf("pure name: got %q", got)
	}
	// 不存在的纯名 → 回退原串
	if got := ResolveAddBaseRef(root, "nope"); got != "nope" {
		t.Fatalf("missing name: got %q", got)
	}
	// refs/ 前缀 → 原样
	if got := ResolveAddBaseRef(root, "refs/heads/main"); got != "refs/heads/main" {
		t.Fatalf("refs prefix: got %q", got)
	}
	// 含 / 的远程跟踪形式(本地无 origin/main)→ 回退到 refs/heads(origin/main 不存在,refs/heads/origin/main 也不存在)
	// 这里主要验证不 panic 且有合理返回。
	_ = ResolveAddBaseRef(root, "origin/main")
}

// TestListBranches 列出本地+远程分支,排除 */HEAD。
func TestListBranches(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := initRepoWithBranch(t, "main")
	must(t, runGit(root, "branch", "develop"))
	must(t, runGit(root, "branch", "feature/x"))

	got, err := ListBranches(root)
	must(t, err)
	names := map[string]bool{}
	for _, b := range got {
		if strings.HasSuffix(b.Name, "/HEAD") {
			t.Fatalf("HEAD pseudo-ref not excluded: %+v", b)
		}
		names[b.Name] = true
	}
	for _, want := range []string{"main", "develop", "feature/x"} {
		if !names[want] {
			t.Fatalf("branch %q not listed: %+v", want, got)
		}
	}
}

// TestMergeBranchInto_MainOnTarget 主仓库就在 target 分支且干净 → 直接 merge。
func TestMergeBranchInto_MainOnTarget(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := initRepoWithBranch(t, "main")
	target := headBranch(t, root) // = main

	// 建 worktree 分支并提交改动
	wt := filepath.Join(t.TempDir(), "wt")
	branch := "md/sess1"
	must(t, Create(root, branch, wt, "main"))
	must(t, os.WriteFile(filepath.Join(wt, "a.txt"), []byte("changed"), 0o644))
	must(t, runGit(wt, "add", "."))
	must(t, runGit(wt, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "change"))

	// 主仓库当前在 main 且干净 → merge 直接进主仓库
	out, err := MergeBranchInto(root, branch, target, "merge test")
	must(t, err)
	if !strings.Contains(out, "changed") && out != "" {
		// merge 输出可能含文件名统计;只要没报错且 a.txt 更新即成功
	}
	b, _ := os.ReadFile(filepath.Join(root, "a.txt"))
	if string(b) != "changed" {
		t.Fatalf("merge into main(target) did not apply: %q", b)
	}
}

// TestMergeBranchInto_TempWorktree 主仓库在别的分支(target 空闲)→ 建临时 worktree merge,主仓库不动。
// 这是 review 点名的最复杂路径:验证合并生效 + 临时 worktree 被清理。
func TestMergeBranchInto_TempWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := initRepoWithBranch(t, "main")
	target := "main"

	// 建 worktree 分支并提交改动
	wt := filepath.Join(t.TempDir(), "wt")
	branch := "md/sess2"
	must(t, Create(root, branch, wt, target))
	must(t, os.WriteFile(filepath.Join(wt, "a.txt"), []byte("changed-in-temp"), 0o644))
	must(t, runGit(wt, "add", "."))
	must(t, runGit(wt, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "change"))

	// 主仓库切到别的分支(target=main 空闲)
	must(t, runGit(root, "checkout", "-q", "-b", "other-work"))

	// 合并:target=main 空闲 → 走临时 worktree 路径
	_, err := MergeBranchInto(root, branch, target, "merge via temp worktree")
	must(t, err)

	// main 分支应已包含改动。checkout main 验证。
	must(t, runGit(root, "checkout", "-q", "main"))
	b, _ := os.ReadFile(filepath.Join(root, "a.txt"))
	if string(b) != "changed-in-temp" {
		t.Fatalf("temp-worktree merge did not apply to main: %q", b)
	}

	// 临时 worktree 必被清理(review 重点):worktree list 不应残留 md-merge-* 临时项。
	listOut, err := exec.Command("git", "-C", root, "worktree", "list", "--porcelain").Output()
	must(t, err)
	if strings.Contains(string(listOut), "md-merge-") {
		t.Fatalf("temp worktree not cleaned up:\n%s", listOut)
	}
}

// TestMergeBranchInto_ConflictCleansTempWorktree review 重点:merge 冲突时临时 worktree 也必须被清理。
func TestMergeBranchInto_ConflictCleansTempWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := initRepoWithBranch(t, "main")
	target := "main"
	// 先建 session worktree,基于【原始 main = "a"】(此时 main 还没前进)。
	// 两边都从 "a" 岔出改同一文件 → 才会真冲突。
	wt := filepath.Join(t.TempDir(), "wt")
	branch := "md/sess3"
	must(t, Create(root, branch, wt, target))
	must(t, os.WriteFile(filepath.Join(wt, "a.txt"), []byte("sess-version"), 0o644))
	must(t, runGit(wt, "add", "."))
	must(t, runGit(wt, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "sess change"))

	// 再让 main 前进:在主仓库 checkout main,改同一文件为不同内容 → 两边发散。
	must(t, runGit(root, "checkout", "-q", "main"))
	must(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("main-version"), 0o644))
	must(t, runGit(root, "add", "."))
	must(t, runGit(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "main change"))
	// 切到别的分支使 main 空闲 → MergeBranchInto 走临时 worktree 路径。
	must(t, runGit(root, "checkout", "-q", "-b", "other"))


	_, err := MergeBranchInto(root, branch, target, "conflict merge")
	if err == nil {
		t.Fatal("expected conflict error, got nil")
	}
	// 应是 MergeConflictError
	var ce *MergeConflictError
	if !errors.As(err, &ce) {
		t.Fatalf("expected MergeConflictError, got %T: %v", err, err)
	}
	if len(ce.Files) == 0 {
		t.Fatal("conflict error has no files")
	}

	// review 核心:即使冲突,临时 worktree 也必须被清理
	listOut, err := exec.Command("git", "-C", root, "worktree", "list", "--porcelain").Output()
	must(t, err)
	if strings.Contains(string(listOut), "md-merge-") {
		t.Fatalf("temp worktree leaked after conflict:\n%s", listOut)
	}
}

// TestPreflightMerge_NoConflict 无冲突:ok=true, conflicts=nil。
func TestPreflightMerge_NoConflict(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := initRepoWithBranch(t, "main")
	// session 分支加个新文件(不与 main 冲突)
	wt := filepath.Join(t.TempDir(), "wt")
	must(t, Create(root, "md/pf1", wt, "main"))
	must(t, os.WriteFile(filepath.Join(wt, "new.txt"), []byte("x"), 0o644))
	must(t, runGit(wt, "add", "."))
	must(t, runGit(wt, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "add"))

	conflicts, ok, err := PreflightMerge(root, "main", "md/pf1")
	must(t, err)
	if !ok {
		t.Skip("git < 2.38, --write-tree not supported")
	}
	if len(conflicts) != 0 {
		t.Fatalf("expected no conflicts, got %v", conflicts)
	}
}

// TestPreflightMerge_HasConflict 有冲突:ok=true, conflicts 含冲突文件(去重)。
func TestPreflightMerge_HasConflict(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := initRepoWithBranch(t, "main")
	// session 分支基于 main 改 a.txt
	wt := filepath.Join(t.TempDir(), "wt")
	must(t, Create(root, "md/pf2", wt, "main"))
	must(t, os.WriteFile(filepath.Join(wt, "a.txt"), []byte("sess-version"), 0o644))
	must(t, runGit(wt, "add", "."))
	must(t, runGit(wt, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "sess"))
	// main 前进:改同一文件不同内容 → 冲突
	must(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("main-version"), 0o644))
	must(t, runGit(root, "add", "."))
	must(t, runGit(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "main"))

	conflicts, ok, err := PreflightMerge(root, "main", "md/pf2")
	must(t, err)
	if !ok {
		t.Skip("git < 2.38, --write-tree not supported")
	}
	if len(conflicts) == 0 {
		t.Fatal("expected conflicts, got none")
	}
	found := false
	for _, f := range conflicts {
		if f == "a.txt" {
			found = true
		}
	}
	if !found {
		t.Fatalf("a.txt not in conflicts: %v", conflicts)
	}
	// 去重验证:一个文件冲突,conflicts 不应重复 a.txt
	count := 0
	for _, f := range conflicts {
		if f == "a.txt" {
			count++
		}
	}
	if count > 1 {
		t.Fatalf("a.txt duplicated in conflicts: %v", conflicts)
	}
}

// TestPreflightMerge_IntegrationWithMergeBranchInto 预检挡住冲突:MergeBranchInto 有冲突时
// 不发起合并(返回 MergeConflictError),临时 worktree 不被创建。
func TestPreflightMerge_IntegrationWithMergeBranchInto(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := initRepoWithBranch(t, "main")
	target := "main"
	// 主仓库切走使 main 空闲(走临时 worktree 路径,验证预检挡在它之前)
	must(t, runGit(root, "checkout", "-q", "-b", "other"))
	// session 分支改 a.txt
	wt := filepath.Join(t.TempDir(), "wt")
	branch := "md/pf3"
	must(t, Create(root, branch, wt, target))
	must(t, os.WriteFile(filepath.Join(wt, "a.txt"), []byte("sess"), 0o644))
	must(t, runGit(wt, "add", "."))
	must(t, runGit(wt, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "sess"))
	// main 前进改同文件 → 冲突(checkout main 改完切回 other)
	must(t, runGit(root, "checkout", "-q", "main"))
	must(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("main"), 0o644))
	must(t, runGit(root, "add", "."))
	must(t, runGit(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "main"))
	must(t, runGit(root, "checkout", "-q", "other"))

	_, err := MergeBranchInto(root, branch, target, "should not merge")
	if err == nil {
		t.Fatal("expected conflict error, got nil")
	}
	var ce *MergeConflictError
	if !errors.As(err, &ce) {
		t.Fatalf("expected MergeConflictError, got %T: %v", err, err)
	}
	// 预检挡住:不应创建临时 worktree(md-merge-*)。
	listOut, _ := exec.Command("git", "-C", root, "worktree", "list", "--porcelain").Output()
	if strings.Contains(string(listOut), "md-merge-") {
		t.Fatalf("preflight should prevent temp worktree creation:\n%s", listOut)
	}
}

// TestMergeBranchInto_TargetOccupiedByWorktree 基线分支被另一个 worktree 检出时,
// 直接在该 worktree 里 merge(不再报错挡住)。场景:session B 基线 = session A 的 md/ 分支。
func TestMergeBranchInto_TargetOccupiedByWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := initRepoWithBranch(t, "main")
	// session A:建在 main 上,分支 md/aaa(worktree 占用 md/aaa)
	wtA := filepath.Join(t.TempDir(), "wtA")
	must(t, Create(root, "md/aaa", wtA, "main"))
	// 在 md/aaa 上提交改动(成为后续 session B 的基线内容)
	must(t, os.WriteFile(filepath.Join(wtA, "shared.txt"), []byte("from-aaa"), 0o644))
	must(t, runGit(wtA, "add", "."))
	must(t, runGit(wtA, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "aaa work"))
	// session B:基线 = md/aaa(用户在新建对话的基线选择器里选了 md/aaa)。
	// worktree B 检出 md/bbb,基于 md/aaa 建。
	wtB := filepath.Join(t.TempDir(), "wtB")
	must(t, Create(root, "md/bbb", wtB, "md/aaa"))
	must(t, os.WriteFile(filepath.Join(wtB, "shared.txt"), []byte("from-aaa"), 0o644)) // 不冲突:同内容
	must(t, os.WriteFile(filepath.Join(wtB, "b-only.txt"), []byte("b"), 0o644))
	must(t, runGit(wtB, "add", "."))
	must(t, runGit(wtB, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "bbb work"))

	// 把 md/bbb 合进 md/aaa:md/aaa 正被 wtA 检出。
	// 旧逻辑:报错挡住。新逻辑:wtA 已 checkout md/aaa 且干净 → 直接在 wtA 里 merge。
	out, err := MergeBranchInto(root, "md/bbb", "md/aaa", "merge bbb into aaa")
	must(t, err)
	_ = out // merge 输出(含统计),非空即可
	// md/aaa(wtA)应已包含 md/bbb 的改动:b-only.txt 出现在 wtA。
	if _, err := os.Stat(filepath.Join(wtA, "b-only.txt")); err != nil {
		t.Fatalf("merge into occupied worktree did not apply: b-only.txt missing in wtA: %v", err)
	}
}

// TestMergeBranchInto_TargetOccupiedDirty 报错路径:基线 worktree 脏 → 必须拒绝。
func TestMergeBranchInto_TargetOccupiedDirty(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := initRepoWithBranch(t, "main")
	wtA := filepath.Join(t.TempDir(), "wtA")
	must(t, Create(root, "md/aaa", wtA, "main"))
	// wtA 工作区脏(未提交改动)
	must(t, os.WriteFile(filepath.Join(wtA, "dirty.txt"), []byte("dirty"), 0o644))
	wtB := filepath.Join(t.TempDir(), "wtB")
	must(t, Create(root, "md/bbb", wtB, "md/aaa"))

	_, err := MergeBranchInto(root, "md/bbb", "md/aaa", "should fail")
	if err == nil {
		t.Fatal("expected error on dirty occupied target, got nil")
	}
	if !strings.Contains(err.Error(), "不干净") {
		t.Fatalf("expected dirty error, got: %v", err)
	}
}

// TestListWorktrees 列出主 + linked worktree,IsMain 推导正确,linked 带 md/ 分支。
func TestListWorktrees(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	must(t, runGit(root, "init", "-q", root))
	must(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("a"), 0o644))
	must(t, runGit(root, "add", "."))
	must(t, runGit(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init"))

	wt := filepath.Join(t.TempDir(), "wt-a")
	must(t, Create(root, "md/sess-a", wt, ""))

	wts, err := ListWorktrees(root)
	must(t, err)
	if len(wts) != 2 {
		t.Fatalf("want 2 worktrees, got %d: %+v", len(wts), wts)
	}
	// main 排第一且 IsMain=true、路径 == root。
	if !wts[0].IsMain {
		t.Fatalf("first worktree should be main: %+v", wts[0])
	}
	if normalizePath(wts[0].Path) != normalizePath(root) {
		t.Fatalf("main path mismatch: got %s want %s", wts[0].Path, root)
	}
	// linked:IsMain=false、分支 md/sess-a、路径 == wt。
	if wts[1].IsMain {
		t.Fatalf("second worktree should not be main: %+v", wts[1])
	}
	if wts[1].Branch != "md/sess-a" {
		t.Fatalf("linked branch = %q, want md/sess-a", wts[1].Branch)
	}
	if normalizePath(wts[1].Path) != normalizePath(wt) {
		t.Fatalf("linked path mismatch: got %s want %s", wts[1].Path, wt)
	}
	// Date = HEAD 的 committerdate,init 提交后应 > 0(供前端「最近 worktree」快捷项排序)。
	if wts[0].Date <= 0 || wts[1].Date <= 0 {
		t.Fatalf("worktree Date should be > 0: %+v", wts)
	}
}

// TestRemove_Guardrails 锁四道护栏:主工作树拒删 / 非 md 分支拒删 / 非 linked 路径拒删 / 正常 linked+md 放行。
// 任一护栏失守 = 可能删客户真实代码,这是整个 owner/guest 模型的安全底线。
func TestRemove_Guardrails(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	must(t, runGit(root, "init", "-q", root))
	must(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("a"), 0o644))
	must(t, runGit(root, "add", "."))
	must(t, runGit(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init"))

	wt := filepath.Join(t.TempDir(), "wt-a")
	must(t, Create(root, "md/sess-a", wt, ""))

	// 护栏 1:目标 == 主工作树 → 拒(绝不删项目目录)。
	if err := Remove(root, root, "md/sess-a"); err == nil {
		t.Fatal("Remove main worktree must fail")
	}
	// 护栏 2:非 md/ 分支 → 拒(main / feature 等真实分支一律不删)。
	if err := Remove(root, wt, "main"); err == nil {
		t.Fatal("Remove non-md branch must fail")
	}
	// 护栏 3:不是现存 linked worktree 的路径 → 拒。
	if err := Remove(root, filepath.Join(t.TempDir(), "nope"), "md/sess-a"); err == nil {
		t.Fatal("Remove non-existent worktree must fail")
	}
	// 被拒三次后 worktree + 分支应仍在(护栏是「什么也不动」)。
	if !BranchExists(root, "md/sess-a") {
		t.Fatal("branch vanished after a refused Remove")
	}
	// 正常:linked worktree + md/ 分支 → 放行删除。
	if err := Remove(root, wt, "md/sess-a"); err != nil {
		t.Fatalf("Remove valid linked worktree: %v", err)
	}
	if BranchExists(root, "md/sess-a") {
		t.Fatal("branch still exists after Remove")
	}
}
