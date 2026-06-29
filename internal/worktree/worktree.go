// Package worktree 管理 git worktree:为每个 session 创建独立工作树 + 分支,
// 实现并行隔离(参考 orca 的 parallel worktree 模型)。
// 项目 = 主 repo;session = 主 repo 的一个 worktree(独立分支 + 独立工作目录)。
// opencode 仍走 ACP,只是 cwd 指向 worktree(不违反 §1.1 纯 ACP)。
package worktree

import (
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
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
func Create(repoPath, branch, targetPath, baseRef string) error {
	args := []string{"worktree", "add", "-b", branch, targetPath}
	if baseRef != "" {
		args = append(args, baseRef)
	} else {
		args = append(args, "HEAD")
	}
	_, err := git(repoPath, args...)
	return err
}

// Remove 删除工作树 targetPath 与其分支 branch(worktree remove + branch -D)。
// 容错:worktree 已不在/分支已删不报错。
func Remove(repoPath, targetPath, branch string) error {
	if _, err := git(repoPath, "worktree", "remove", "--force", targetPath); err != nil {
		// 兜底:prune 掉失效登记
		_, _ = git(repoPath, "worktree", "prune")
	}
	if branch != "" {
		_, _ = git(repoPath, "branch", "-D", branch) // 强删会话分支(已 merge 的也删)
	}
	return nil
}

// MergeBranch 把 branch 合并进 repoPath 的当前 HEAD,用 message 作为合并提交信息,
// 返回 git 合并输出(含变更统计)。--no-ff 强制生成 merge commit(即使可快进),
// 使指定的 message 生效并保留分支历史。冲突时返回 error(含 git 冲突信息)。
func MergeBranch(repoPath, branch, message string) (string, error) {
	out, err := git(repoPath, "merge", "--no-ff", "-m", message, branch)
	if err != nil {
		return "", err
	}
	return out, nil
}

// DiffStat 返回 branch 相对 repoPath 当前 HEAD 的变更摘要(git diff --stat)。
// 格式如 "3 files changed, 15 insertions(+), 5 deletions(-)"。无变更返回空串。
func DiffStat(repoPath, branch string) (string, error) {
	// 先找 merge-base(分支与当前 HEAD 的共同祖先),只看 branch 的增量
	base, err := git(repoPath, "merge-base", "HEAD", branch)
	if err != nil {
		return "", err
	}
	out, err := git(repoPath, "diff", "--stat", base, branch)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// BranchLog 返回 branch 相对 base 的 commit 列表(一行一条),供"这个分支干了什么"展示。
func BranchLog(repoPath, branch string) (string, error) {
	base, err := git(repoPath, "merge-base", "HEAD", branch)
	if err != nil {
		return "", err
	}
	out, err := git(repoPath, "log", "--oneline", base+".."+branch)
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
