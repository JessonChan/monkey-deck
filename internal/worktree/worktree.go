// Package worktree 管理 git worktree:为每个 session 创建独立工作树 + 分支,
// 实现并行隔离(参考 orca 的 parallel worktree 模型)。
// 项目 = 主 repo;session = 主 repo 的一个 worktree(独立分支 + 独立工作目录)。
// opencode 仍走 ACP,只是 cwd 指向 worktree(不违反 §1.1 纯 ACP)。
package worktree

import (
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// FileChange 一个文件的变更状态(VS Code 风格)。
type FileChange struct {
	Path   string `json:"path"`
	Status string `json:"status"` // M=修改 A=新增 D=删除 U=未跟踪 R=重命名
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

// MergeBranch 把 branch 合并进 repoPath 的当前 HEAD,返回 git 合并输出(含变更统计)。
// 冲突时返回 error(含 git 冲突信息)。
func MergeBranch(repoPath, branch string) (string, error) {
	out, err := git(repoPath, "merge", "--no-edit", branch)
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

// StatusFiles 返回 worktreePath 里所有变更的文件列表(VS Code 风格:逐文件 + 状态)。
// 用 git status --porcelain 解析,包含 staged/unstaged/untracked。
func StatusFiles(worktreePath string) ([]FileChange, error) {
	out, err := git(worktreePath, "status", "--porcelain")
	if err != nil {
		return nil, err
	}
	var files []FileChange
	for _, line := range strings.Split(out, "\n") {
		if len(line) < 3 {
			continue
		}
		code := strings.TrimSpace(line[:2])
		path := strings.TrimSpace(line[3:])
		st := "M"
		switch {
		case strings.Contains(code, "A"):
			st = "A"
		case strings.Contains(code, "D"):
			st = "D"
		case strings.Contains(code, "R"):
			st = "R"
		case strings.Contains(code, "?"):
			st = "U"
		case strings.Contains(code, "M"):
			st = "M"
		}
		files = append(files, FileChange{Path: path, Status: st})
	}
	return files, nil
}

// HasChanges 报告 worktreePath 是否有未提交的改动(含 untracked)。
func HasChanges(worktreePath string) bool {
	out, err := git(worktreePath, "status", "--porcelain")
	return err == nil && strings.TrimSpace(out) != ""
}

// AutoCommit 在 worktreePath 里 git add . + git commit(若有改动)。无改动则跳过。
// message 为提交信息。用 -c 设置身份(不依赖全局 git config)。
func AutoCommit(worktreePath, message string) error {
	if !HasChanges(worktreePath) {
		return nil
	}
	if _, err := git(worktreePath, "add", "."); err != nil {
		return err
	}
	if _, err := git(worktreePath, "-c", "user.email=monkey-deck@local", "-c", "user.name=Monkey Deck", "commit", "-qm", message); err != nil {
		return err
	}
	return nil
}

// BranchExists 报告 branch 是否存在于 repoPath。
func BranchExists(repoPath, branch string) bool {
	_, err := git(repoPath, "rev-parse", "--verify", "refs/heads/"+branch)
	return err == nil
}
