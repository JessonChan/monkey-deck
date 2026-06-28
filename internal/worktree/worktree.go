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

// MergeBranch 把 branch 合并进 repoPath 的当前 HEAD(标准 git merge,非 FF 由 git 决定)。
// 冲突时返回 error(含 git 的冲突信息),由上层提示用户。
func MergeBranch(repoPath, branch string) error {
	_, err := git(repoPath, "merge", "--no-edit", branch)
	return err
}

// BranchExists 报告 branch 是否存在于 repoPath。
func BranchExists(repoPath, branch string) bool {
	_, err := git(repoPath, "rev-parse", "--verify", "refs/heads/"+branch)
	return err == nil
}
