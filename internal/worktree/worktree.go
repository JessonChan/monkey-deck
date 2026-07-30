// Package worktree 管理 git worktree:为每个 session 创建独立工作树 + 分支,
// 实现并行隔离(参考 orca 的 parallel worktree 模型)。
// 项目 = 主 repo;session = 主 repo 的一个 worktree(独立分支 + 独立工作目录)。
// opencode 仍走 ACP,只是 cwd 指向 worktree(不违反 §1.1 纯 ACP)。
package worktree

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// FileChange 一个文件的变更状态(VS Code 风格)。
type FileChange struct {
	Path   string `json:"path"`
	Status string `json:"status"` // M=修改 A=新增 D=删除 U=未跟踪 R=重命名
	// Staged=true 表示已进暂存区(index 有改动);false 表示工作区改动。
	// 一个文件可能同时出现在两组(如 MM:已暂存后又有新改动),参考 VS Code 的 Changes / Staged Changes 两组。
	Staged bool `json:"staged"`
}

// ErrNotARepo 路径不是 git 仓库。
var ErrNotARepo = errors.New("not a git repository")

// git 在 repoPath 下跑命令,返回输出;失败时 stderr 进 error。
func git(repoPath string, args ...string) (string, error) {
	full := append([]string{"-C", repoPath}, args...)
	out, err := exec.Command("git", full...).Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), strings.TrimSpace(string(ee.Stderr)))
		}
		return "", fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return strings.TrimSpace(string(out)), nil
}

// gitRaw 同 git 但不对输出做 TrimSpace。porcelain 输出每行前两位是状态列(可能是空格),
// 整体 TrimSpace 会吞掉首行前导空格,破坏 XY 列解析。StatusFiles 等需逐行精确格式的场景用它。
func gitRaw(repoPath string, args ...string) (string, error) {
	full := append([]string{"-C", repoPath}, args...)
	out, err := exec.Command("git", full...).Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), strings.TrimSpace(string(ee.Stderr)))
		}
		return "", fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return string(out), nil
}

// normalizePath 归一化绝对路径用于比对:EvalSymlinks 解软链(失败回退 Clean)。
// 防软链 / 尾斜杠 / 大小写差异导致「是不是主 worktree」误判(Remove 护栏 + ListWorktrees IsMain 都靠它)。
func normalizePath(p string) string {
	if p == "" {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(p); err == nil {
		return filepath.Clean(resolved)
	}
	return filepath.Clean(p)
}

// gitDiff 跑 git diff 并返回输出。git diff 的退出码语义特殊:1 = 有差异(正常结果),
// 仅其它非零才报错。故不走 git()(它把任意非零当 error)。
func gitDiff(repoPath string, args ...string) (string, error) {
	full := append([]string{"-C", repoPath}, args...)
	out, err := exec.Command("git", full...).Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			if ee.ExitCode() == 1 { // diff 有差异:正常,取 stdout
				return string(out), nil
			}
			return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), strings.TrimSpace(string(ee.Stderr)))
		}
		return "", fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return string(out), nil
}

// IsRepo 报告 path 是否在一个 git 工作树内。
func IsRepo(path string) bool {
	_, err := git(path, "rev-parse", "--is-inside-work-tree")
	return err == nil
}

// HeadShort 返回当前 HEAD 的短引用(分支名或 commit 前 7 位)。
func HeadShort(repoPath string) (string, error) {
	out, err := git(repoPath, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return "", err
	}
	if out == "HEAD" { // detached
		out, _ = git(repoPath, "rev-parse", "--short", "HEAD")
	}
	return out, nil
}

// Create 在 repoPath 的 baseRef 基础上,新建分支 branch 并检出工作树到 targetPath。
// baseRef 为空则用 HEAD。targetPath 不能已存在。
// --no-track:避免新建分支自动配置 upstream 跟踪,首次 push 前 git status 误报 "behind by N"(§1.4)。
func Create(repoPath, branch, targetPath, baseRef string) error {
	args := []string{"worktree", "add", "--no-track", "-b", branch, targetPath}
	if baseRef != "" {
		args = append(args, baseRef)
	} else {
		args = append(args, "HEAD")
	}
	_, err := git(repoPath, args...)
	return err
}

// MDPrefix is the prefix of app-created session branches (§1.4: md/<session-id-8>).
// Remove only deletes branches with this prefix; chat.worktreeKindOf uses it to tell owner
// from guest. Exported so the md/<id8> convention has a single source of truth.
const MDPrefix = "md/"

// Remove 删除 linked worktree targetPath 与其分支 branch。owner-only 的原子操作。
//
// 四道护栏(defense in depth —— 绝不删主工作树 / 客户真实代码):
//  1. targetPath 归一化后 ≠ 主工作树(repoPath);
//  2. branch 必须以 md/ 开头(只删 app 自建会话分支;main / develop / feature 等真实分支一律拒);
//  3. targetPath 必须仍是 git 登记中的 linked worktree(已 prune / 已被手动删 → 拒,避免误伤);
//  4. git 自身拒删主工作树(兜底)。
//
// 任一护栏不满足 → 返回 error,worktree 与 branch 都不动(宁可留孤儿 md/ 分支,也不冒险删错)。
func Remove(repoPath, targetPath, branch string) error {
	target := normalizePath(targetPath)
	if target == "" || target == normalizePath(repoPath) {
		return fmt.Errorf("refuse to remove main worktree: %s", targetPath)
	}
	if !strings.HasPrefix(branch, MDPrefix) {
		return fmt.Errorf("refuse to delete non-app branch %q (only %s* allowed)", branch, MDPrefix)
	}
	linked, err := isLinkedWorktree(repoPath, target)
	if err != nil {
		return fmt.Errorf("check linked worktree: %w", err)
	}
	if !linked {
		return fmt.Errorf("not a linked worktree (gone or main): %s", targetPath)
	}
	if _, err := git(repoPath, "worktree", "remove", "--force", targetPath); err != nil {
		_, _ = git(repoPath, "worktree", "prune")
		return fmt.Errorf("git worktree remove: %w", err)
	}
	if _, err := git(repoPath, "branch", "-D", branch); err != nil {
		return fmt.Errorf("git branch -D %s: %w", branch, err)
	}
	return nil
}

// MergeConflictError 表示合并因冲突失败。Files 为冲突文件路径(相对仓库根)。
// MergeBranch 在冲突时会自动 git merge --abort,把主仓库回滚到合并前——主仓库是项目
// 所有 session 的共享根,绝不能卡在半合并状态(否则后续 worktree 创建 / diff / 同项目
// 其它 session 合并全部受影响,且应用内无冲突解决 UI,只能靠终端救场)。
type MergeConflictError struct {
	Files []string
}

func (e *MergeConflictError) Error() string {
	return "合并冲突: " + strings.Join(e.Files, ", ")
}

// MergeBranch 把 branch 合并进 repoPath 的当前 HEAD,用 message 作为合并提交信息,
// 返回 git 合并输出(含变更统计)。--no-ff 强制生成 merge commit(即使可快进),
// 使指定的 message 生效并保留分支历史。
//
// 失败(冲突或其它原因)时自动 git merge --abort 回滚主仓库到合并前,保证主仓库始终干净:
// 冲突返回 *MergeConflictError(含冲突文件);非冲突失败返回原始 git 错误。
func MergeBranch(repoPath, branch, message string) (string, error) {
	out, err := git(repoPath, "merge", "--no-ff", "-m", message, branch)
	if err != nil {
		// 必须先抓冲突文件再 abort:abort 后 index 就干净了,U 列清空。
		conflicted, _ := conflictedFiles(repoPath)
		_, _ = git(repoPath, "merge", "--abort") // 无 merge 进行中时是空操作,忽略错误
		if len(conflicted) > 0 {
			return "", &MergeConflictError{Files: conflicted}
		}
		return "", err
	}
	return out, nil
}

// conflictedFiles 返回当前未合并(conflicted)的文件路径(相对仓库根);无冲突返回 nil。
func conflictedFiles(repoPath string) ([]string, error) {
	out, err := git(repoPath, "diff", "--name-only", "--diff-filter=U")
	if err != nil {
		return nil, err
	}
	if out == "" {
		return nil, nil
	}
	return strings.Split(out, "\n"), nil
}

// DiffStat 返回 branch 相对 base 的变更摘要(git diff --stat)。
// base 为空则用主仓库 HEAD(旧行为:主仓库在基线分支时碰巧等价)。
// 有显式基线的 session 应传 se.BaseRef,避免主仓库 HEAD 飘走后增量算错(todo §13 review 补漏)。
// 格式如 "3 files changed, 15 insertions(+), 5 deletions(-)"。无变更返回空串。
func DiffStat(repoPath, branch, base string) (string, error) {
	baseRef := base
	if baseRef == "" {
		baseRef = "HEAD"
	}
	mb, err := git(repoPath, "merge-base", baseRef, branch)
	if err != nil {
		return "", err
	}
	out, err := git(repoPath, "diff", "--stat", mb, branch)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// BranchLog 返回 branch 相对 base 的 commit 列表(一行一条),供"这个分支干了什么"展示。
// base 为空则用主仓库 HEAD(旧行为)。有显式基线的 session 应传 se.BaseRef。
func BranchLog(repoPath, branch, base string) (string, error) {
	baseRef := base
	if baseRef == "" {
		baseRef = "HEAD"
	}
	mb, err := git(repoPath, "merge-base", baseRef, branch)
	if err != nil {
		return "", err
	}
	out, err := git(repoPath, "log", "--oneline", mb+".."+branch)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// UncommittedStat 返回 worktreePath 里未提交的改动摘要(staged + unstaged + untracked)。
// agent 改了文件但没 commit 时,DiffStat(已提交差异)看不到——这里补上。
func UncommittedStat(worktreePath string) (string, error) {
	out, err := git(worktreePath, "diff", "--stat", "HEAD")
	if err != nil {
		return "", err
	}
	// untracked 文件(diff HEAD 看不到)
	untracked, _ := git(worktreePath, "ls-files", "--others", "--exclude-standard")
	if untracked != "" {
		if out != "" {
			out += "\n"
		}
		for _, f := range strings.Split(untracked, "\n") {
			out += "新文件: " + f + "\n"
		}
	}
	return strings.TrimSpace(out), nil
}

// StatusFiles 返回 worktreePath 里的文件级变更(VS Code 风格:暂存 / 工作区两组)。
// 解析 git status --porcelain 的 XY 两列:X=index(暂存),Y=worktree(工作区)。
// 一个文件若同时被暂存又有工作区改动(如 MM),会返回两条:一条 Staged=true、一条 Staged=false。
func StatusFiles(worktreePath string) ([]FileChange, error) {
	out, err := gitRaw(worktreePath, "status", "--porcelain")
	if err != nil {
		return nil, err
	}
	var files []FileChange
	for _, line := range strings.Split(out, "\n") {
		if len(line) < 3 {
			continue
		}
		x, y := line[0], line[1]
		path := strings.TrimSpace(line[3:])
		if path == "" {
			continue
		}
		// porcelain 对重命名(R)/复制(C)输出 "old -> new",后续操作作用于新路径。
		if i := strings.Index(path, " -> "); i >= 0 {
			path = path[i+4:]
		}
		// 含空格/特殊字符的路径被双引号包裹,去掉外层引号(否则 git add/checkout 命中不了)。
		path = strings.Trim(path, `"`)
		if x == '?' && y == '?' { // 未跟踪:只进工作区组
			files = append(files, FileChange{Path: path, Status: "U", Staged: false})
			continue
		}
		if x != ' ' && x != '?' { // 暂存组(index 有改动)
			files = append(files, FileChange{Path: path, Status: statusLetter(x), Staged: true})
		}
		if y != ' ' && y != '?' { // 工作区组
			files = append(files, FileChange{Path: path, Status: statusLetter(y), Staged: false})
		}
	}
	return files, nil
}

// statusLetter 把 porcelain 单列状态码映射成对外展示字母。
func statusLetter(c byte) string {
	switch c {
	case 'M', 'T':
		return "M"
	case 'A':
		return "A"
	case 'D':
		return "D"
	case 'R', 'C':
		return "R" // 复制按重命名展示
	default:
		return "M"
	}
}

// HasChanges 报告 worktreePath 是否有未提交的改动(含 untracked)。
func HasChanges(worktreePath string) bool {
	out, err := git(worktreePath, "status", "--porcelain")
	return err == nil && strings.TrimSpace(out) != ""
}

// Stage 把 paths 加入暂存区。paths 为空表示暂存全部(git add -A)。
func Stage(worktreePath string, paths ...string) error {
	args := []string{"add", "-A"}
	if len(paths) > 0 {
		args = append([]string{"add", "--"}, paths...)
	}
	_, err := git(worktreePath, args...)
	return err
}

// Unstage 把 paths 移出暂存区(git restore --staged)。paths 为空表示移出全部。
func Unstage(worktreePath string, paths ...string) error {
	args := []string{"restore", "--staged", "."}
	if len(paths) > 0 {
		args = append([]string{"restore", "--staged", "--"}, paths...)
	}
	_, err := git(worktreePath, args...)
	return err
}

// Discard 丢弃工作区改动:已跟踪文件 checkout 还原,未跟踪文件 clean 删除。
// 只应用于工作区(Staged=false)的文件;暂存区改动用 Unstage。路径为空无操作。
func Discard(worktreePath string, paths ...string) error {
	if len(paths) == 0 {
		return nil
	}
	// 用 ls-files 区分已跟踪 / 未跟踪(在 index 里的算已跟踪)
	out, _ := git(worktreePath, append([]string{"ls-files", "--"}, paths...)...)
	tracked := make(map[string]bool)
	for _, p := range strings.Split(out, "\n") {
		if p = strings.TrimSpace(p); p != "" {
			tracked[p] = true
		}
	}
	var trackedP, untrackedP []string
	for _, p := range paths {
		if tracked[p] {
			trackedP = append(trackedP, p)
		} else {
			untrackedP = append(untrackedP, p)
		}
	}
	if len(trackedP) > 0 {
		if _, err := git(worktreePath, append([]string{"checkout", "--"}, trackedP...)...); err != nil {
			return err
		}
	}
	if len(untrackedP) > 0 {
		if _, err := git(worktreePath, append([]string{"clean", "-f", "--"}, untrackedP...)...); err != nil {
			return err
		}
	}
	return nil
}

// Commit 提交已暂存的改动(只 commit index,不自动 add;区别于 AutoCommit)。
// 无暂存改动时返回 git 的 "nothing to commit" 错误。
func Commit(worktreePath, message string) error {
	_, err := git(worktreePath, "-c", "user.email=monkey-deck@local", "-c", "user.name=Monkey Deck", "commit", "-qm", message)
	return err
}

// FileDiff 返回单个文件的 unified diff,供源代码管理面板点击文件查看改动(VSCode SCM 风格)。
//   - staged=true:index 相对 HEAD(git diff --cached)。
//   - staged=false:已跟踪文件取工作区相对 index(git diff);未跟踪文件无 index/HEAD 版本,
//     用 --no-index 对照 /dev/null 展示为纯新增。
func FileDiff(worktreePath, path string, staged bool) (string, error) {
	if staged {
		d, _ := gitDiff(worktreePath, "diff", "--cached", "--", path)
		return strings.TrimSpace(d), nil
	}
	// 未跟踪文件(ls-files 命中为空)用 --no-index 对照空内容。
	if out, _ := git(worktreePath, "ls-files", "--", path); strings.TrimSpace(out) == "" {
		abs := filepath.Join(worktreePath, path)
		d, err := gitDiff(worktreePath, "diff", "--no-index", "/dev/null", abs)
		return strings.TrimSpace(d), err
	}
	d, err := gitDiff(worktreePath, "diff", "--", path)
	return strings.TrimSpace(d), err
}

// BranchExists 报告 branch 是否存在于 repoPath。
func BranchExists(repoPath, branch string) bool {
	_, err := git(repoPath, "rev-parse", "--verify", "refs/heads/"+branch)
	return err == nil
}

// ErrNoBaseRef 探测不到默认基线分支(无 main/master 且无 origin/HEAD)。
// Route A strict:不回退 HEAD,由调用方强制用户显式选(todo/worktree-base-ref-selection.md §2)。
var ErrNoBaseRef = errors.New("no default base ref found")


// DefaultBaseRef 默认基线探测结果(BaseRef=短名,Ok=是否探测到)。供前端预选 + 星标。
type DefaultBaseRef struct {
	BaseRef string `json:"baseRef"`
	Ok      bool   `json:"ok"`
}

// revVerify 报告 ref 是否解析到一个 commit。用于探测分支是否存在。
func revVerify(repoPath, ref string) bool {
	_, err := git(repoPath, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	return err == nil
}

// RefExists 报告 ref 是否解析到一个 commit,尝试常见命名空间(heads/remotes/原样)。
// 接受短名(main)、远程跟踪名(origin/main)或完整 ref(refs/heads/main)。
// 供「记住上次选择」验证分支仍存在(分支可能被删后 setting 残留)。
func RefExists(repoPath, ref string) bool {
	if ref == "" {
		return false
	}
	cands := []string{ref}
	if !strings.HasPrefix(ref, "refs/") {
		cands = append(cands, "refs/heads/"+ref, "refs/remotes/"+ref)
	}
	for _, c := range cands {
		if revVerify(repoPath, c) {
			return true
		}
	}
	return false
}

// ResolveDefaultBaseRef 探测仓库的默认基线分支(返回本地分支短名,如 main)。
// 顺序(todo §3,本地优先):
//  1. git symbolic-ref refs/remotes/origin/HEAD → 得默认名(如 main)→ 本地 refs/heads/<name> 存在 → 返回。
//  2. 本地优先 probe list:refs/heads/main → master → refs/remotes/origin/main → origin/master,第一个存在的返回短名。
//  3. 全空 → ErrNoBaseRef(不回退 HEAD)。
//
// v1 写死 origin(绝大多数项目;fork/多 remote 让用户手选,文档标注限制)。
func ResolveDefaultBaseRef(repoPath string) (string, error) {
	// 1. origin/HEAD symbolic-ref(静默:不存在会非零,忽略错误)。
	if out, _ := git(repoPath, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"); out != "" {
		// out 形如 refs/remotes/origin/main,取最后一段作短名。
		name := out
		if i := strings.LastIndex(out, "/"); i >= 0 {
			name = out[i+1:]
		}
		if name != "" && revVerify(repoPath, "refs/heads/"+name) {
			return name, nil
		}
	}
	// 2. 本地优先 probe list。
	type probe struct{ full, short string }
	probes := []probe{
		{"refs/heads/main", "main"},
		{"refs/heads/master", "master"},
		{"refs/remotes/origin/main", "main"},
		{"refs/remotes/origin/master", "master"},
	}
	for _, p := range probes {
		if revVerify(repoPath, p.full) {
			return p.short, nil
		}
	}
	return "", ErrNoBaseRef
}

// ResolveAddBaseRef 把用户选的 baseRef 消歧成 git 能安全传给 worktree add 的 ref,
// 避免短名(如 main)被 git 解析成同名 tag。
//   - 以 refs/ 开头 → 原样用(已是完整 ref)。
//   - 含 / (如 origin/main)→ 先试 refs/remotes/<base>,再 refs/heads/<base>。
//   - 纯名(如 main / develop)→ 只试 refs/heads/<base>。
//
// 都不命中 → 回退原串(让 git 自己报错,透传 git 的诊断信息)。
func ResolveAddBaseRef(repoPath, baseRef string) string {
	if baseRef == "" {
		return ""
	}
	if strings.HasPrefix(baseRef, "refs/") {
		return baseRef
	}
	var cands []string
	if strings.Contains(baseRef, "/") {
		cands = []string{"refs/remotes/" + baseRef, "refs/heads/" + baseRef}
	} else {
		cands = []string{"refs/heads/" + baseRef}
	}
	for _, c := range cands {
		if revVerify(repoPath, c) {
			return c
		}
	}
	return baseRef
}

// BranchInfo 一条分支的信息(供选择器列表)。
type BranchInfo struct {
	Name string `json:"name"` // 短名(如 main / origin/main)
	Kind string `json:"kind"` // "local" | "remote"
	Date int64  `json:"date"` // committerdate unix 秒(供排序 + 前端按当前时区格式化:同年省年、带时分秒)
}

// ListBranches 列出仓库的本地 + 远程跟踪分支,排除 */HEAD 伪 ref,
// 按 committerdate 倒序封顶 200 条(供选择器一次性拉取 + 前端过滤,KISS)。
func ListBranches(repoPath string) ([]BranchInfo, error) {
	// --sort=-committerdate:最近优先。--count=200 封顶。
	// %(committerdate:unix):unix 秒,前端按本地时区 + 同年省年格式化(git 的 :short 只到日、无时分秒且不支持条件格式)。
	out, err := git(repoPath, "for-each-ref",
		"--sort=-committerdate",
		"--count=200",
		"--format=%(refname:short)%09%(committerdate:unix)%09%(refname)",
		"refs/heads/", "refs/remotes/",
	)
	if err != nil {
		return nil, err
	}
	var res []BranchInfo
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) < 2 {
			continue
		}
		short, dateStr := parts[0], parts[1]
		full := short
		if len(parts) == 3 {
			full = parts[2]
		}
		// 排除 */HEAD 伪 ref(origin/HEAD 等)。
		if strings.HasSuffix(full, "/HEAD") {
			continue
		}
		kind := "local"
		if strings.HasPrefix(full, "refs/remotes/") {
			kind = "remote"
		}
		var ts int64
		if n, err := strconv.ParseInt(dateStr, 10, 64); err == nil {
			ts = n
		}
		res = append(res, BranchInfo{Name: short, Kind: kind, Date: ts})
	}
	return res, nil
}

// WorktreeInfo 一条 worktree 信息(供 NewSessionModal「使用已有工作目录」选择器)。
type WorktreeInfo struct {
	Path   string `json:"path"`   // 工作目录绝对路径
	Branch string `json:"branch"` // 检出的分支短名(如 main / md/abc12345 / feat/x);detached HEAD 时为空
	IsMain bool   `json:"isMain"` // 是否主工作树(= 项目目录;true = 永不可删,Remove 护栏)
}

// ListWorktrees 列出仓库全部 worktree(主 + linked),主工作树(IsMain=true)排第一。
// 供「使用已有工作目录」选择器:进入已有 worktree(guest)或选项目主目录。detached 的 Branch 留空。
func ListWorktrees(repoPath string) ([]WorktreeInfo, error) {
	out, err := gitRaw(repoPath, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}
	mainNorm := normalizePath(repoPath)
	var res []WorktreeInfo
	for _, block := range strings.Split(out, "\n\n") {
		block = strings.TrimSpace(block)
		if block == "" {
			continue
		}
		var path, branch string
		for _, line := range strings.Split(block, "\n") {
			switch {
			case strings.HasPrefix(line, "worktree "):
				path = strings.TrimSpace(strings.TrimPrefix(line, "worktree "))
			case strings.HasPrefix(line, "branch "):
				ref := strings.TrimSpace(strings.TrimPrefix(line, "branch "))
				branch = strings.TrimPrefix(ref, "refs/heads/")
			}
		}
		if path == "" {
			continue
		}
		res = append(res, WorktreeInfo{
			Path:   path,
			Branch: branch,
			IsMain: normalizePath(path) == mainNorm,
		})
	}
	return res, nil
}

// ResolveWorktreeBranch reports whether target is a current linked worktree of repoPath
// (non-main); if so returns its checked-out branch short name (empty for detached HEAD).
// CreateGuestSession uses it to validate the entered path AND resolve its branch from git
// truth (the branch is not trusted from the caller — single source).
func ResolveWorktreeBranch(repoPath, target string) (branch string, ok bool, err error) {
	targetNorm := normalizePath(target)
	wts, err := ListWorktrees(repoPath)
	if err != nil {
		return "", false, err
	}
	for _, w := range wts {
		if !w.IsMain && normalizePath(w.Path) == targetNorm {
			return w.Branch, true, nil
		}
	}
	return "", false, nil
}

// isLinkedWorktree reports whether target is a current linked worktree (non-main) of repoPath.
// Remove guardrail 3: confirms the deletion target is a live linked worktree, not the main
// repo or a stale path.
func isLinkedWorktree(repoPath, target string) (bool, error) {
	_, ok, err := ResolveWorktreeBranch(repoPath, target)
	return ok, err
}

// mergeInDir 在 dir 所在的工作树里把 branch 合并进当前(已 checkout 在 target 的)HEAD,
// 返回合并输出或 *MergeConflictError(自动 merge --abort 回滚该工作树)。
// 与 MergeBranch 同语义,只是针对任意工作树目录而非固定主仓库。
func mergeInDir(dir, branch, message string) (string, error) {
	out, err := git(dir, "merge", "--no-ff", "-m", message, branch)
	if err != nil {
		conflicted, _ := conflictedFiles(dir)
		_, _ = git(dir, "merge", "--abort") // 无 merge 进行中时是空操作
		if len(conflicted) > 0 {
			return "", &MergeConflictError{Files: conflicted}
		}
		return "", err
	}
	return out, nil
}

// PreflightMerge 用 git merge-tree --write-tree 预演「branch 合并进 base」,不碰工作区/index。
// git ≥ 2.38 支持。返回:
//   - conflicts 非空 + ok=true:有冲突(已去重),调用方应直接报错不发起合并。
//   - nil + ok=true:无冲突,可安全合并。
//   - ok=false:git 不支持 --write-tree(<2.38),调用方走原「合并+abort」兜底路径。
//   - err!=nil:预演本身失败(非冲突),透传。
func PreflightMerge(repoPath, base, branch string) (conflicts []string, ok bool, err error) {
	// 直接 exec:需区分 exit 1(冲突,正常结果)与其它(不支持/真错误)。
	cmd := exec.Command("git", "-C", repoPath, "merge-tree", "--write-tree", base, branch)
	stdout, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			stderr := string(ee.Stderr)
			// exit 1 = 有冲突:stdout 含 stage 行,解析冲突文件。
			if ee.ExitCode() == 1 {
				return parseMergeTreeConflicts(string(stdout)), true, nil
			}
			// 旧版 git 不认 --write-tree:usage 错误(exit 129)或 stderr 含 unknown option。
			if ee.ExitCode() == 129 || strings.Contains(stderr, "unknown option") {
				return nil, false, nil
			}
			return nil, false, fmt.Errorf("git merge-tree: %s", strings.TrimSpace(stderr))
		}
		return nil, false, err
	}
	// exit 0 = 无冲突(stdout 第一行是合并后的 tree OID)。
	return nil, true, nil
}

// parseMergeTreeConflicts 从 merge-tree --write-tree 输出解析冲突文件路径。
// 冲突时输出行:<mode> <oid> <stage>\t<path>(stage 1/2/3 = base/ours/theirs,同一文件三行)。
// 按 tab 分割取 path(含空格路径不被拆),去重(stage 三行)。
func parseMergeTreeConflicts(out string) []string {
	seen := map[string]bool{}
	var files []string
	for _, line := range strings.Split(out, "\n") {
		tabIdx := strings.IndexByte(line, '\t')
		if tabIdx < 0 {
			continue
		}
		meta := strings.Fields(line[:tabIdx])
		path := line[tabIdx+1:]
		// meta 末段是 stage(1/2/3);前面是 mode + oid。只收冲突 stage。
		if len(meta) >= 3 && (meta[len(meta)-1] == "1" || meta[len(meta)-1] == "2" || meta[len(meta)-1] == "3") {
			if !seen[path] {
				seen[path] = true
				files = append(files, path)
			}
		}
	}
	return files
}

// MergeBranchInto 把 branch 合并进本地分支 target(用 message 作 merge commit 信息)。
// target = 该 session 的基线分支(从哪 checkout 就合回哪,对称)。
// 先用 worktree list --porcelain 定位 target 当前 checkout 在哪:
//   - 主仓库(repoPath)在 target 且干净 → 直接在主仓库 merge(现有语义)。
//   - 主仓库在 target 但脏 → 报错(脏工作区 merge 必爆)。
//   - target 空闲(主仓库在别的分支,且 target 未在别处被检出)→ 建 target 的临时 worktree,在其中 merge 后删除;主仓库不动。
//   - target 在主仓库之外被检出 → 报错。
//
// 临时 worktree 路径必 defer 删除(无论成功/冲突/失败),保证不留垃圾(todo §6.2)。
func MergeBranchInto(repoPath, branch, target, message string) (string, error) {
	// 0. 预检:git merge-tree 预演「branch→target」,有冲突直接返回,不发起合并(工作区零触碰)。
	//    git ≥ 2.38 支持;不支持则 ok=false 跳过,走下面实际 merge + 冲突 abort 兜底。
	if conflicts, ok, perr := PreflightMerge(repoPath, target, branch); perr == nil && ok && len(conflicts) > 0 {
		return "", &MergeConflictError{Files: conflicts}
	}
	// 1. 定位 target 在哪被 checkout(git worktree list --porcelain)。
	listOut, err := gitRaw(repoPath, "worktree", "list", "--porcelain")
	if err != nil {
		return "", err
	}
	type wt struct{ path, head string }
	var worktrees []wt
	var cur wt
	for _, line := range strings.Split(listOut, "\n") {
		if line == "" {
			if cur.path != "" {
				worktrees = append(worktrees, cur)
			}
			cur = wt{}
			continue
		}
		if strings.HasPrefix(line, "worktree ") {
			cur.path = strings.TrimPrefix(line, "worktree ")
		} else if strings.HasPrefix(line, "branch ") {
			cur.head = strings.TrimPrefix(line, "branch ")
		} else if strings.HasPrefix(line, "HEAD ") {
			// detached:记录 ref;非 detached 由 branch 行覆盖。这里取 short 形式比较。
			cur.head = strings.TrimPrefix(line, "HEAD ")
		}
	}
	if cur.path != "" {
		worktrees = append(worktrees, cur)
	}
	targetShort := target
	if i := strings.LastIndex(target, "/"); i >= 0 {
		targetShort = target[i+1:]
	}
	// 主仓库 = list 第一项(repoPath 自身)。比较 head 是否 == target(分支名或 short)。
	var mainDir string
	mainOnTarget := false
	if len(worktrees) > 0 {
		mainDir = worktrees[0].path
		mainOnTarget = worktrees[0].head == target || worktrees[0].head == "refs/heads/"+target ||
			worktrees[0].head == targetShort
	}
	// target 是否被其它 worktree 检出(主仓库之外)。
	occupiedBy := ""
	for _, w := range worktrees {
		if w.path == mainDir {
			continue
		}
		if w.head == target || w.head == "refs/heads/"+target || w.head == targetShort {
			occupiedBy = w.path
			break
		}
	}

	// 2a. 主仓库在 target → 直接 merge(检查干净)。
	if mainOnTarget {
		if HasChanges(mainDir) {
			return "", fmt.Errorf("主仓库工作区不干净(当前在 %s),先提交或丢弃改动后再合并", target)
		}
		return mergeInDir(mainDir, branch, message)
	}
	// 2b. target 被另一个 worktree 检出(如 session A 的基线是 session B 的 md/ 分支,
	// 而 session B 的 worktree 正 checkout 在该分支上)。该 worktree 本身就是合并目标所在,
	// 直接在它里面 merge(它已 checkout 在 target 上),无需建临时 worktree——只要它工作区干净。
	// 失败/冲突由 mergeInDir 的 abort 兜底,该 worktree 始终干净。
	if occupiedBy != "" {
		if HasChanges(occupiedBy) {
			return "", fmt.Errorf("基线分支 %s 的工作树不干净(%s),先提交或丢弃改动后再合并", target, occupiedBy)
		}
		return mergeInDir(occupiedBy, branch, message)
	}
	// 2c. target 空闲(主仓库在别的分支)→ 建 target 的临时 worktree,merge 后删除。
	tmpWt, err := os.MkdirTemp("", "md-merge-*")
	if err != nil {
		return "", err
	}
	// 提前删空目录,git worktree add 要求目标不存在。
	_ = os.Remove(tmpWt)
	// 检出 target 分支(非 detach):merge 在该工作树内会移动 target 分支指针。
	// 不能用 --detach:detached HEAD 下 merge 只移 HEAD 不移分支 ref,target 分支不会更新。
	// 前面的占用检查已保证 target 未在别处被检出,此处 worktree add 能成功。
	if _, err := git(repoPath, "worktree", "add", tmpWt, target); err != nil {
		return "", fmt.Errorf("建临时 worktree: %w", err)
	}
	defer func() {
		_ = gitQuiet(repoPath, "worktree", "remove", "--force", tmpWt)
	}()
	return mergeInDir(tmpWt, branch, message)
}

// gitQuiet 跑 git 命令,静默失败(返回 error 但不含 stderr 包装,用于临时操作)。
func gitQuiet(repoPath string, args ...string) error {
	full := append([]string{"-C", repoPath}, args...)
	_, err := exec.Command("git", full...).Output()
	return err
}
