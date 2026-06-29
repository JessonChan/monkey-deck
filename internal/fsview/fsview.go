// Package fsview 提供受限工作目录内的文件浏览 / 管理。
//
// 路径钉在 session 的 cwd(git 项目的 worktree 或非 git 项目目录),前端只传相对路径,
// 后端 safeJoin 解析并校验「结果仍落在 root 内」,防 ../ 越界与符号链接逃逸。
//
// 供右侧「文件」面板:列目录(懒加载,git 仓库尊重 .gitignore)、读文件、增删改。
package fsview

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// FileNode 树节点(一层):目录或文件。
type FileNode struct {
	Name  string `json:"name"`
	Path  string `json:"path"`  // 相对 root 的路径(用 / 分隔,前端原样回传用于展开/操作)
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size,omitempty"` // 文件字节数
}

// 读文件大小上限(超过则不返回内容,仅提示)。
const maxReadSize = 2 * 1024 * 1024 // 2MB

// ErrEscapesRoot 路径越界(试图跳出 root)。
var ErrEscapesRoot = errors.New("path escapes workspace root")

// safeJoin 把相对路径 rel 解析进 root,确保解析(含符号链接)后仍落在 root 内。
// 前端只允许传相对路径;此函数是唯一的越界防线。
func safeJoin(root, rel string) (string, error) {
	rel = filepath.ToSlash(strings.TrimSpace(rel))
	rel = strings.TrimPrefix(rel, "/")
	if rel == "" || rel == "." {
		return root, nil
	}
	joined := filepath.Join(root, filepath.FromSlash(rel)) // Join 已清洗 ../
	abs, err := filepath.Abs(joined)
	if err != nil {
		return "", err
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	// root 与目标都解析符号链接(到最近存在祖先),保证在同一基准下比较。
	// 否则 macOS 的 /var → /private/var 会让未解析的目标被误判越界。
	abs = resolveExisting(abs)
	rootAbs = resolveExisting(rootAbs)
	r, err := filepath.Rel(rootAbs, abs)
	if err != nil {
		return "", err
	}
	if relOut(r) {
		return "", ErrEscapesRoot
	}
	return abs, nil
}

// resolveExisting 解析路径的符号链接;路径本身不存在时,解析到最近的存在祖先,
// 再把不存在的尾部拼回。保证根与目标用同一基准做 Rel 比较。
func resolveExisting(p string) string {
	cur := p
	for {
		if real, err := filepath.EvalSymlinks(cur); err == nil {
			if cur == p {
				return real
			}
			tail := strings.TrimPrefix(strings.TrimPrefix(p, cur), string(filepath.Separator))
			if tail == "" {
				return real
			}
			return filepath.Join(real, tail)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return p // 到根都不存在,放弃解析
		}
		cur = parent
	}
}

// relOut 报告 Rel 的结果是否表示「跑出了 root」。
func relOut(r string) bool {
	if r == ".." {
		return true
	}
	return strings.HasPrefix(r, ".."+string(filepath.Separator))
}

// ListDir 列出 root/rel 的直接子项(一层,懒加载):目录在前,文件在后,均按字母序。
// git 仓库下尊重 .gitignore(用 git ls-files 拿到可见集合);非 git 目录降级为 os.ReadDir。
func ListDir(root, rel string) ([]FileNode, error) {
	target, err := safeJoin(root, rel)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(target)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("不是目录: %s", rel)
	}
	if isGitRoot(root) {
		return listGit(root, filepath.ToSlash(rel))
	}
	return listPlain(target, filepath.ToSlash(rel))
}

// isGitRoot root 下存在 .git(目录或 worktree 的 .git 文件)即视为 git 仓库。
func isGitRoot(root string) bool {
	_, err := os.Stat(filepath.Join(root, ".git"))
	return err == nil
}

// listGit 用 git ls-files 取得可见(非忽略)文件集合,据此构造直接子项。
// dirSet 汇总含文件的子目录,fileSet 收集本层文件;目录与文件分别排序。
func listGit(root, rel string) ([]FileNode, error) {
	args := []string{"-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "--full-name"}
	if rel != "" {
		args = append(args, "--", rel)
	}
	out, err := gitRaw(root, args...)
	if err != nil {
		// git 不可用 / 异常时降级为普通目录列举,保证可用。
		return listPlain(filepath.Join(root, rel), rel)
	}
	prefix := ""
	if rel != "" {
		prefix = strings.TrimSuffix(rel, "/") + "/"
	}
	dirSet := map[string]struct{}{}
	fileSet := map[string]struct{}{}
	for _, line := range strings.Split(out, "\n") {
		line = filepath.ToSlash(strings.TrimSpace(line))
		if line == "" {
			continue
		}
		rest := line
		if prefix != "" {
			if !strings.HasPrefix(line, prefix) {
				continue
			}
			rest = strings.TrimPrefix(line, prefix)
		}
		if i := strings.IndexByte(rest, '/'); i >= 0 {
			dirSet[rest[:i]] = struct{}{}
		} else if rest != "" {
			fileSet[rest] = struct{}{}
		}
	}
	nodes := make([]FileNode, 0, len(dirSet)+len(fileSet))
	for _, d := range sortedKeys(dirSet) {
		nodes = append(nodes, FileNode{Name: d, Path: joinRel(rel, d), IsDir: true})
	}
	for _, f := range sortedKeys(fileSet) {
		p := joinRel(rel, f)
		nodes = append(nodes, FileNode{Name: f, Path: p, IsDir: false, Size: fileSize(filepath.Join(root, p))})
	}
	return nodes, nil
}

// listPlain 非 git 目录:os.ReadDir 直接读,隐藏 .git。
func listPlain(dir, rel string) ([]FileNode, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	nodes := make([]FileNode, 0, len(entries))
	for _, e := range entries {
		if e.Name() == ".git" {
			continue
		}
		p := joinRel(rel, e.Name())
		sz := int64(0)
		if info, err := e.Info(); err == nil {
			sz = info.Size()
		}
		nodes = append(nodes, FileNode{Name: e.Name(), Path: p, IsDir: e.IsDir(), Size: sz})
	}
	sortNodes(nodes)
	return nodes, nil
}

// sortNodes 目录优先,再按名字(大小写不敏感)字母序。
func sortNodes(nodes []FileNode) {
	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].IsDir != nodes[j].IsDir {
			return nodes[i].IsDir
		}
		return strings.ToLower(nodes[i].Name) < strings.ToLower(nodes[j].Name)
	})
}

func sortedKeys(m map[string]struct{}) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Slice(ks, func(i, j int) bool { return strings.ToLower(ks[i]) < strings.ToLower(ks[j]) })
	return ks
}

// joinRel 拼接相对路径(始终用 / 分隔,供前端回传)。
func joinRel(rel, name string) string {
	if rel == "" {
		return name
	}
	return strings.TrimSuffix(rel, "/") + "/" + name
}

func fileSize(p string) int64 {
	if info, err := os.Stat(p); err == nil {
		return info.Size()
	}
	return 0
}

// ReadFile 读取 root/rel 的文本内容。过大或二进制不返回内容,只给提示。
func ReadFile(root, rel string) (string, error) {
	target, err := safeJoin(root, rel)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(target)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("是目录: %s", rel)
	}
	if info.Size() > maxReadSize {
		return fmt.Sprintf("文件过大(%d 字节),不预览。", info.Size()), nil
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return "", err
	}
	if isBinary(data) {
		return "二进制文件,不预览。", nil
	}
	return string(data), nil
}

// isBinary 前 8000 字节含 NUL 视为二进制。
func isBinary(data []byte) bool {
	n := len(data)
	if n > 8000 {
		n = 8000
	}
	for i := 0; i < n; i++ {
		if data[i] == 0 {
			return true
		}
	}
	return false
}

// CreateFile 新建文件(含内容)。父目录自动创建;已存在则报错。
func CreateFile(root, rel, content string) error {
	target, err := safeJoin(root, rel)
	if err != nil {
		return err
	}
	if _, err := os.Stat(target); err == nil {
		return fmt.Errorf("已存在: %s", rel)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	return os.WriteFile(target, []byte(content), 0o644)
}

// CreateDir 新建目录(含父级)。
func CreateDir(root, rel string) error {
	target, err := safeJoin(root, rel)
	if err != nil {
		return err
	}
	return os.MkdirAll(target, 0o755)
}

// DeletePath 删除文件或目录(递归)。
func DeletePath(root, rel string) error {
	target, err := safeJoin(root, rel)
	if err != nil {
		return err
	}
	if target == root {
		return ErrEscapesRoot // 禁止删根
	}
	return os.RemoveAll(target)
}

// RenamePath 把 root/rel 改名为 newName(仅叶子名,不含路径)。
// 返回新的相对路径。非法名(含路径分隔符 / . / ..)拒绝。
func RenamePath(root, rel, newName string) (string, error) {
	newName = strings.TrimSpace(newName)
	if newName == "" || newName == "." || newName == ".." || strings.ContainsAny(newName, `/\`) {
		return "", fmt.Errorf("非法名称: %s", newName)
	}
	newRel := joinRel(filepath.ToSlash(filepath.Dir(rel)), newName)
	if _, err := safeJoin(root, newRel); err != nil {
		return "", err
	}
	from, err := safeJoin(root, rel)
	if err != nil {
		return "", err
	}
	to, err := safeJoin(root, newRel)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(to); err == nil {
		return "", fmt.Errorf("目标已存在: %s", newRel)
	}
	if err := os.Rename(from, to); err != nil {
		return "", err
	}
	return newRel, nil
}

// gitRaw 在 root 下跑 git 子命令,返回原始输出(不 Trim,逐行格式需精确)。
func gitRaw(root string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	var out strings.Builder
	cmd.Stdout = &out
	err := cmd.Run()
	return out.String(), err
}
