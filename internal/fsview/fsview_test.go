package fsview

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// 验证路径越界防护:../ 与符号链接逃逸都被拒绝。
func TestSafeJoinEscapesRoot(t *testing.T) {
	root := t.TempDir()
	for _, rel := range []string{"../x", "../../etc", "a/../../../b"} {
		if _, err := safeJoin(root, rel); err == nil {
			t.Fatalf("safeJoin(%q) should escape root", rel)
		}
	}
	// 合法相对路径应通过
	if p, err := safeJoin(root, "a/b.txt"); err != nil {
		t.Fatalf("safeJoin legit failed: %v", err)
	} else if !strings.HasSuffix(filepath.ToSlash(p), "a/b.txt") {
		t.Fatalf("unexpected path: %s", p)
	}
	// 空 / 根 / 点 → root 本身
	for _, rel := range []string{"", ".", "/"} {
		if _, err := safeJoin(root, rel); err != nil {
			t.Fatalf("safeJoin(%q) root should pass: %v", rel, err)
		}
	}
}

// 验证符号链接逃逸被拒:root 内一软链指向 root 外,读它应被拒。
func TestSafeJoinSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if _, err := safeJoin(root, "escape/secret"); err == nil {
		t.Fatal("symlink escaping root must be rejected")
	}
}

// 验证列目录:目录优先 + 字母序 + .gitignore 尊重(git 仓库)。
func TestListDirGit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	mustGit(t, root, "init", "-q")
	// 建结构:src/a.go src/sub/b.go .gitignore(忽略 *.log) ignored.log README.md node_modules/x
	for _, p := range []string{"src", "src/sub"} {
		must(t, os.MkdirAll(filepath.Join(root, p), 0o755))
	}
	must(t, os.WriteFile(filepath.Join(root, "src", "a.go"), []byte("a"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "src", "sub", "b.go"), []byte("b"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "README.md"), []byte("r"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, ".gitignore"), []byte("*.log\nnode_modules/\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "ignored.log"), []byte("x"), 0o644))
	must(t, os.MkdirAll(filepath.Join(root, "node_modules", "pkg"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "node_modules", "pkg", "index.js"), []byte("1"), 0o644))
	mustGit(t, root, "add", ".")
	mustGit(t, root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")

	// 根层:应有 README.md + src(目录),不应有 ignored.log / node_modules(.gitignore)
	nodes, err := ListDir(root, "")
	if err != nil {
		t.Fatalf("ListDir root: %v", err)
	}
	names := nodeNames(nodes)
	if !contains(names, "src") || !contains(names, "README.md") {
		t.Fatalf("root missing src/README.md: %+v", names)
	}
	if contains(names, "ignored.log") || contains(names, "node_modules") {
		t.Fatalf(".gitignore not respected: %+v", names)
	}
	// 目录优先:src 排在 README.md 前
	if indexOf(names, "src") > indexOf(names, "README.md") {
		t.Fatalf("dirs should come first: %+v", names)
	}

	// 进 src:有 a.go + sub(目录)
	nodes, err = ListDir(root, "src")
	if err != nil {
		t.Fatalf("ListDir src: %v", err)
	}
	names = nodeNames(nodes)
	if !contains(names, "a.go") || !contains(names, "sub") {
		t.Fatalf("src listing wrong: %+v", names)
	}
	// 进 src/sub:有 b.go
	nodes, err = ListDir(root, "src/sub")
	if err != nil {
		t.Fatalf("ListDir src/sub: %v", err)
	}
	if len(nodes) != 1 || nodes[0].Name != "b.go" || nodes[0].IsDir {
		t.Fatalf("src/sub wrong: %+v", nodes)
	}
}

// 验证读文件:文本正常返回、二进制给提示、目录报错、越界拒绝。
func TestReadFile(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("hello"), 0o644))
	must(t, os.MkdirAll(filepath.Join(root, "d"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "bin"), []byte("a\x00b"), 0o644))

	if c, err := ReadFile(root, "a.txt"); err != nil || c != "hello" {
		t.Fatalf("read a.txt = %q %v", c, err)
	}
	if c, err := ReadFile(root, "bin"); err != nil || c != "二进制文件,不预览。" {
		t.Fatalf("read bin = %q %v", c, err)
	}
	if _, err := ReadFile(root, "d"); err == nil {
		t.Fatal("read dir should error")
	}
	if _, err := ReadFile(root, "../x"); err == nil {
		t.Fatal("read escape should error")
	}
}

// 验证增删改:新建文件/目录、改名、删除。
func TestManage(t *testing.T) {
	root := t.TempDir()
	must(t, CreateFile(root, "a/b.txt", "hi"))
	if b, _ := os.ReadFile(filepath.Join(root, "a", "b.txt")); string(b) != "hi" {
		t.Fatalf("create file content wrong: %q", b)
	}
	if err := CreateFile(root, "a/b.txt", "x"); err == nil {
		t.Fatal("create existing should error")
	}
	must(t, CreateDir(root, "d/e"))
	if _, err := os.Stat(filepath.Join(root, "d", "e")); err != nil {
		t.Fatalf("create dir failed: %v", err)
	}
	// 改名
	newRel, err := RenamePath(root, "a/b.txt", "c.txt")
	if err != nil || newRel != "a/c.txt" {
		t.Fatalf("rename: %v %q", err, newRel)
	}
	if _, err := os.Stat(filepath.Join(root, "a", "b.txt")); err == nil {
		t.Fatal("old name should be gone after rename")
	}
	// 非法名
	if _, err := RenamePath(root, "a/c.txt", "../evil"); err == nil {
		t.Fatal("rename to ../ should be rejected")
	}
	// 删除
	if err := DeletePath(root, "a"); err != nil {
		t.Fatalf("delete dir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "a")); err == nil {
		t.Fatal("a should be removed")
	}
	// 禁删根
	if err := DeletePath(root, ""); err == nil {
		t.Fatal("delete root must be rejected")
	}
}

// 验证非 git 目录列举(隐藏 .git)。
func TestListDirPlain(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "z.txt"), []byte("1"), 0o644))
	must(t, os.MkdirAll(filepath.Join(root, "Adir"), 0o755))
	must(t, os.MkdirAll(filepath.Join(root, ".git"), 0o755))
	nodes, err := ListDir(root, "")
	if err != nil {
		t.Fatalf("ListDir plain: %v", err)
	}
	names := nodeNames(nodes)
	if contains(names, ".git") {
		t.Fatal(".git should be hidden in plain listing")
	}
	if !contains(names, "Adir") || !contains(names, "z.txt") {
		t.Fatalf("plain listing wrong: %+v", names)
	}
	if indexOf(names, "Adir") > indexOf(names, "z.txt") {
		t.Fatalf("dirs first: %+v", names)
	}
}

func nodeNames(nodes []FileNode) []string {
	out := make([]string, len(nodes))
	for i, n := range nodes {
		out[i] = n.Name
	}
	return out
}
func contains(s []string, v string) bool { return indexOf(s, v) >= 0 }
func indexOf(s []string, v string) int {
	for i, x := range s {
		if x == v {
			return i
		}
	}
	return -1
}
func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func mustGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if err := cmd.Run(); err != nil {
		t.Fatalf("git %s: %v", strings.Join(args, " "), err)
	}
}
