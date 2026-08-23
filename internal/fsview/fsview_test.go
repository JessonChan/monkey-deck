package fsview

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/png"
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

// ReadFile: text content, binary / too-large flags, dir error, escape rejected.
func TestReadFile(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("hello"), 0o644))
	must(t, os.MkdirAll(filepath.Join(root, "d"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "bin"), []byte("a\x00b"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "big"), bytes.Repeat([]byte("x"), maxReadSize+1), 0o644))

	if fd, err := ReadFile(root, "a.txt"); err != nil || fd.Content != "hello" || fd.Binary || fd.TooLarge {
		t.Fatalf("read a.txt = %+v %v", fd, err)
	}
	if fd, err := ReadFile(root, "bin"); err != nil || !fd.Binary || fd.Content != "" {
		t.Fatalf("read bin = %+v %v", fd, err)
	}
	if fd, err := ReadFile(root, "big"); err != nil || !fd.TooLarge || fd.Content != "" {
		t.Fatalf("read big = %+v %v", fd, err)
	}
	if _, err := ReadFile(root, "d"); err == nil {
		t.Fatal("read dir should error")
	}
	if _, err := ReadFile(root, "../x"); err == nil {
		t.Fatal("read escape should error")
	}
}

// WriteFile: overwrite round-trip, parent auto-create on missing target,
// permission preservation, dir / escape / oversize rejection.
func TestWriteFile(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("old"), 0o600))
	must(t, os.MkdirAll(filepath.Join(root, "d"), 0o755))

	// Overwrite an existing file; content and permission bits are preserved.
	if err := WriteFile(root, "a.txt", "new"); err != nil {
		t.Fatalf("write a.txt: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "a.txt")); string(b) != "new" {
		t.Fatalf("a.txt = %q, want %q", b, "new")
	}
	if info, err := os.Stat(filepath.Join(root, "a.txt")); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("a.txt perm = %v %v, want 0600", info.Mode().Perm(), err)
	}

	// Missing parent dirs are created (save-after-delete mid-edit).
	if err := WriteFile(root, "x/y.txt", "hi"); err != nil {
		t.Fatalf("write x/y.txt: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "x", "y.txt")); string(b) != "hi" {
		t.Fatalf("x/y.txt = %q", b)
	}

	if err := WriteFile(root, "d", "z"); err == nil {
		t.Fatal("write dir should error")
	}
	if err := WriteFile(root, "../x", "z"); err == nil {
		t.Fatal("write escape should error")
	}
	if err := WriteFile(root, "big.txt", strings.Repeat("x", maxWriteSize+1)); err == nil {
		t.Fatal("write oversize should error")
	}
}

// encodePNG 生成 1x1 透明 PNG 字节,供 ReadImage 测试。
func encodePNG(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

// 验证读图(PNG,有扩展名):返回 dataURL 前缀正确 + 扩展名 png + 内容可解回原字节。
func TestReadImagePNGByExt(t *testing.T) {
	root := t.TempDir()
	pngBytes := encodePNG(t)
	must(t, os.WriteFile(filepath.Join(root, "a.png"), pngBytes, 0o644))

	img, err := ReadImage(root, "a.png")
	if err != nil {
		t.Fatalf("ReadImage a.png: %v", err)
	}
	if img.Extension != "png" {
		t.Fatalf("extension = %q, want png", img.Extension)
	}
	wantPrefix := "data:image/png;base64,"
	if !strings.HasPrefix(img.DataURL, wantPrefix) {
		t.Fatalf("dataURL prefix = %q, want %q", img.DataURL[:len(wantPrefix)], wantPrefix)
	}
	b64 := strings.TrimPrefix(img.DataURL, wantPrefix)
	got, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatalf("decode b64: %v", err)
	}
	if !bytes.Equal(got, pngBytes) {
		t.Fatalf("roundtrip mismatch: got %d bytes, want %d", len(got), len(pngBytes))
	}
}

// 验证扩展名优先:文件名 .jpg 但内容是 PNG → 按 .jpg 判定(image/jpeg)。
func TestReadImageExtBeatsSniff(t *testing.T) {
	root := t.TempDir()
	pngBytes := encodePNG(t)
	must(t, os.WriteFile(filepath.Join(root, "a.jpg"), pngBytes, 0o644))

	img, err := ReadImage(root, "a.jpg")
	if err != nil {
		t.Fatalf("ReadImage a.jpg: %v", err)
	}
	if !strings.HasPrefix(img.DataURL, "data:image/jpeg;base64,") {
		t.Fatalf("mime should be image/jpeg by ext, got %q", img.DataURL)
	}
	if img.Extension != "jpg" {
		t.Fatalf("extension = %q, want jpg", img.Extension)
	}
}

// 验证内容嗅探:无扩展名 / 未知扩展名,但内容是 PNG → 嗅探出 image/png + 反推扩展名 png。
func TestReadImageSniffFallback(t *testing.T) {
	root := t.TempDir()
	pngBytes := encodePNG(t)
	must(t, os.WriteFile(filepath.Join(root, "blob"), pngBytes, 0o644))

	img, err := ReadImage(root, "blob")
	if err != nil {
		t.Fatalf("ReadImage blob: %v", err)
	}
	if !strings.HasPrefix(img.DataURL, "data:image/png;base64,") {
		t.Fatalf("mime should sniff to image/png, got %q", img.DataURL)
	}
	if img.Extension != "png" {
		t.Fatalf("extension = %q, want png", img.Extension)
	}
}

// SVG 只能靠扩展名(文本格式无法嗅探):验证 .svg 命中 image/svg+xml。
func TestReadImageSVGByExt(t *testing.T) {
	root := t.TempDir()
	svg := []byte("<svg xmlns='http://www.w3.org/2000/svg'/>")
	must(t, os.WriteFile(filepath.Join(root, "i.svg"), svg, 0o644))

	img, err := ReadImage(root, "i.svg")
	if err != nil {
		t.Fatalf("ReadImage i.svg: %v", err)
	}
	if !strings.HasPrefix(img.DataURL, "data:image/svg+xml;base64,") {
		t.Fatalf("mime should be image/svg+xml, got %q", img.DataURL)
	}
	if img.Extension != "svg" {
		t.Fatalf("extension = %q, want svg", img.Extension)
	}
}

// 验证非图片(纯文本 + 未知扩展名)报错。
func TestReadImageNotImage(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("hello"), 0o644))
	if _, err := ReadImage(root, "a.txt"); err == nil {
		t.Fatal("read text as image should error")
	}
}

// 验证路径钉:目录、../、符号链接逃逸都被拒。
func TestReadImagePathGuard(t *testing.T) {
	root := t.TempDir()
	pngBytes := encodePNG(t)
	must(t, os.WriteFile(filepath.Join(root, "a.png"), pngBytes, 0o644))
	must(t, os.MkdirAll(filepath.Join(root, "d"), 0o755))

	if _, err := ReadImage(root, "d"); err == nil {
		t.Fatal("read dir should error")
	}
	if _, err := ReadImage(root, "../x.png"); err == nil {
		t.Fatal("read ../ escape should error")
	}

	outside := t.TempDir()
	outPNG := encodePNG(t)
	must(t, os.WriteFile(filepath.Join(outside, "secret.png"), outPNG, 0o644))
	must(t, os.Symlink(outside, filepath.Join(root, "escape")))
	if _, err := ReadImage(root, "escape/secret.png"); err == nil {
		t.Fatal("symlink escape should be rejected")
	}
}

// 验证过大文件报错(不 base64 灌进 webview)。
func TestReadImageTooLarge(t *testing.T) {
	root := t.TempDir()
	// 造一个 maxImageSize+1 的文件(用 truncate,不真写内容)。
	p := filepath.Join(root, "big.png")
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(maxImageSize + 1); err != nil {
		f.Close()
		t.Fatal(err)
	}
	f.Close()
	if _, err := ReadImage(root, "big.png"); err == nil {
		t.Fatal("oversized image should error")
	}
}

// 验证不存在 / 空 rel(指向根,是目录)报错。
func TestReadImageMissing(t *testing.T) {
	root := t.TempDir()
	if _, err := ReadImage(root, "nope.png"); err == nil {
		t.Fatal("missing file should error")
	}
	if _, err := ReadImage(root, ""); err == nil {
		t.Fatal("empty rel (root is dir) should error")
	}
}

// 验证两张 mime 映射表的反向一致性不变量:extToImageMime 的每个 value 都必须是
// imageMimeToExt 的 key。否则某扩展名的「内容嗅探兜底」会反推不出扩展名,该格式
// 在「无扩展名 / 改名」场景下静默失败。锚定不变量,防未来给一张表加项漏改另一张。
func TestImageMimeMapsReverseConsistent(t *testing.T) {
	for ext, mime := range extToImageMime {
		if _, ok := imageMimeToExt[mime]; !ok {
			t.Errorf("extToImageMime[%q]=%q 缺反向映射(imageMimeToExt 无该 key)", ext, mime)
		}
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

// nodePaths 收集节点的 Path 字段。
func nodePaths(nodes []FileNode) []string {
	out := make([]string, len(nodes))
	for i, n := range nodes {
		out[i] = n.Path
	}
	return out
}

// 验证 git 仓库的模糊匹配:尊重 .gitignore、子串命中、按路径排序、limit 截断、大小写不敏感。
// 文件与目录都参与匹配;此处所用 query 都不含目录名,故命中均为文件。
func TestFuzzyFindGit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(root, "src", "sub"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "src", "a.go"), []byte("a"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "src", "sub", "b.go"), []byte("b"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "README.md"), []byte("r"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, ".gitignore"), []byte("*.log\nnode_modules/\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "ignored.log"), []byte("x"), 0o644))
	must(t, os.MkdirAll(filepath.Join(root, "node_modules", "pkg"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "node_modules", "pkg", "index.js"), []byte("1"), 0o644))
	mustGit(t, root, "init", "-q")
	mustGit(t, root, "add", ".")
	mustGit(t, root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")

	// ".go" 命中两个 .go 文件(按路径序),无目录含 ".go";不应有 ignored.log / node_modules
	got, err := FuzzyFind(root, "", ".go", 0)
	if err != nil {
		t.Fatalf("FuzzyFind .go: %v", err)
	}
	paths := nodePaths(got)
	if len(paths) != 2 || paths[0] != "src/a.go" || paths[1] != "src/sub/b.go" {
		t.Fatalf("FuzzyFind .go = %+v, want [src/a.go src/sub/b.go]", paths)
	}
	for _, n := range got {
		if n.Name != filepath.Base(n.Path) {
			t.Fatalf("Name mismatch: %q vs %q", n.Name, filepath.Base(n.Path))
		}
	}

	// "sub/b" 子串(含目录段)命中嵌套文件
	got, err = FuzzyFind(root, "", "sub/b", 0)
	if err != nil {
		t.Fatalf("FuzzyFind sub/b: %v", err)
	}
	if len(got) != 1 || got[0].Path != "src/sub/b.go" {
		t.Fatalf("FuzzyFind sub/b = %+v, want [src/sub/b.go]", nodePaths(got))
	}

	// 大小写不敏感:大写 "README" 命中 "README.md"
	got, err = FuzzyFind(root, "", "README", 0)
	if err != nil {
		t.Fatalf("FuzzyFind README: %v", err)
	}
	if len(got) != 1 || got[0].Path != "README.md" {
		t.Fatalf("FuzzyFind README = %+v, want [README.md]", nodePaths(got))
	}

	// limit 截断:limit=1 取路径序首个
	got, err = FuzzyFind(root, "", ".go", 1)
	if err != nil {
		t.Fatalf("FuzzyFind .go limit=1: %v", err)
	}
	if len(got) != 1 || got[0].Path != "src/a.go" {
		t.Fatalf("FuzzyFind .go limit=1 = %+v, want [src/a.go]", nodePaths(got))
	}

	// 无命中返回空
	got, err = FuzzyFind(root, "", "zzznotfound", 0)
	if err != nil {
		t.Fatalf("FuzzyFind nope: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("FuzzyFind zzznotfound = %+v, want empty", nodePaths(got))
	}
}

// 验证空 query 返回根的直接子项(含目录):picker 初始态。
// 等价 ListDir —— 目录优先 + 字母序 + .gitignore 尊重。
func TestFuzzyFindEmptyQueryReturnsRootChildren(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(root, "src"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "src", "s.go"), []byte("s"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "a.go"), []byte("a"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "README.md"), []byte("r"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, ".gitignore"), []byte("*.log\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "ignored.log"), []byte("x"), 0o644))
	mustGit(t, root, "init", "-q")
	mustGit(t, root, "add", ".")
	mustGit(t, root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")

	// 空与纯空白 query 都应返回根子项(含目录 src)
	for _, q := range []string{"", "   "} {
		got, err := FuzzyFind(root, "", q, 10)
		if err != nil {
			t.Fatalf("FuzzyFind(%q): %v", q, err)
		}
		names := nodeNames(got)
		if !contains(names, "src") || !contains(names, "a.go") || !contains(names, "README.md") {
			t.Fatalf("FuzzyFind(%q) missing root children: %+v", q, names)
		}
		// 含目录:src 应是目录
		var srcNode *FileNode
		for i := range got {
			if got[i].Name == "src" {
				srcNode = &got[i]
				break
			}
		}
		if srcNode == nil || !srcNode.IsDir {
			t.Fatalf("FuzzyFind(%q) src should be a dir: %+v", q, got)
		}
		// .gitignore 尊重:ignored.log 不出现
		if contains(names, "ignored.log") {
			t.Fatalf("FuzzyFind(%q) should respect .gitignore: %+v", q, names)
		}
		// 目录优先:src 排在文件前
		if indexOf(names, "src") > indexOf(names, "a.go") {
			t.Fatalf("dirs should come first (ListDir semantics): %+v", names)
		}
	}
}

// 验证空 query + scope 返回 scope 子树的直接子项(含目录)。
func TestFuzzyFindEmptyQueryScoped(t *testing.T) {
	root := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(root, "sub", "deep"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "sub", "a.txt"), []byte("1"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "sub", "deep", "b.txt"), []byte("2"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "outside.txt"), []byte("3"), 0o644))

	got, err := FuzzyFind(root, "sub", "", 0)
	if err != nil {
		t.Fatalf("FuzzyFind scope=sub empty: %v", err)
	}
	names := nodeNames(got)
	// sub 的直接子项:a.txt + deep(目录);不含 outside.txt、不含 deep/b.txt(深层)
	if !contains(names, "a.txt") || !contains(names, "deep") {
		t.Fatalf("scope=sub children wrong: %+v", names)
	}
	if contains(names, "outside.txt") {
		t.Fatalf("scope=sub should not include root-level outside.txt: %+v", names)
	}
	// 返回的 Path 仍是 root-相对
	paths := nodePaths(got)
	if !contains(paths, "sub/a.txt") || !contains(paths, "sub/deep") {
		t.Fatalf("paths should be root-relative: %+v", paths)
	}
}

// 验证 fuzzy 匹配含目录:query 命中目录名时,目录出现在结果里(与文件混合按路径序)。
func TestFuzzyFindIncludesDirs(t *testing.T) {
	root := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(root, "src", "sub"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "src", "a.go"), []byte("a"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "src", "sub", "b.go"), []byte("b"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "keep.txt"), []byte("k"), 0o644))

	// "sub" 命中目录 src/sub + 文件 src/sub/b.go(路径含 sub)
	got, err := FuzzyFind(root, "", "sub", 0)
	if err != nil {
		t.Fatalf("FuzzyFind sub: %v", err)
	}
	paths := nodePaths(got)
	// 期望 src/sub(目录)与 src/sub/b.go(文件),按路径序:src/sub < src/sub/b.go(前缀)
	if len(paths) != 2 || paths[0] != "src/sub" || paths[1] != "src/sub/b.go" {
		t.Fatalf("FuzzyFind sub = %+v, want [src/sub src/sub/b.go]", paths)
	}
	if !got[0].IsDir || got[1].IsDir {
		t.Fatalf("IsDir mismatch: %+v", got)
	}

	// "src" 命中目录 src + 其下所有路径含 src/ 的条目(目录 src、src/sub,文件 src/a.go、src/sub/b.go)
	got, err = FuzzyFind(root, "", "src", 0)
	if err != nil {
		t.Fatalf("FuzzyFind src: %v", err)
	}
	paths = nodePaths(got)
	want := []string{"src", "src/a.go", "src/sub", "src/sub/b.go"}
	if len(paths) != len(want) {
		t.Fatalf("FuzzyFind src = %+v, want %+v", paths, want)
	}
	for i, w := range want {
		if paths[i] != w {
			t.Fatalf("FuzzyFind src[%d] = %q, want %q (got %+v)", i, paths[i], w, paths)
		}
	}
}

// 验证 scope 参数限定搜索子树:只在 scope 子树内匹配,scope 外的同名条目不出现。
// git 仓库与非 git 目录两路数据源都验证。
func TestFuzzyFindScope(t *testing.T) {
	// 非 git 目录
	root := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(root, "a", "deep"), 0o755))
	must(t, os.MkdirAll(filepath.Join(root, "b", "deep"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "a", "x.txt"), []byte("1"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "a", "deep", "y.txt"), []byte("2"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "b", "x.txt"), []byte("3"), 0o644))

	// scope="a",query=".txt":只命中 a/x.txt + a/deep/y.txt,不含 b/x.txt
	got, err := FuzzyFind(root, "a", ".txt", 0)
	if err != nil {
		t.Fatalf("FuzzyFind scope=a .txt: %v", err)
	}
	paths := nodePaths(got)
	if len(paths) != 2 {
		t.Fatalf("FuzzyFind scope=a .txt = %+v, want 2 hits", paths)
	}
	for _, p := range paths {
		if !strings.HasPrefix(p, "a/") {
			t.Fatalf("scope=a leaked out-of-scope path %q", p)
		}
	}
	// scope="a",query="deep":命中目录 a/deep + 文件 a/deep/y.txt(路径含 deep),均在 scope 内
	got, err = FuzzyFind(root, "a", "deep", 0)
	if err != nil {
		t.Fatalf("FuzzyFind scope=a deep: %v", err)
	}
	paths = nodePaths(got)
	if len(paths) != 2 || paths[0] != "a/deep" || paths[1] != "a/deep/y.txt" {
		t.Fatalf("FuzzyFind scope=a deep = %+v, want [a/deep a/deep/y.txt]", paths)
	}
	if !got[0].IsDir {
		t.Fatalf("a/deep should be dir: %+v", got[0])
	}

	// scope 越界拒绝
	if _, err := FuzzyFind(root, "../x", ".txt", 0); err == nil {
		t.Fatal("FuzzyFind scope=../x should be rejected")
	}
}

// 验证 git 仓库下 scope 限定 + 目录参与匹配(git 路径推导目录)。
func TestFuzzyFindScopeGit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(root, "src", "sub"), 0o755))
	must(t, os.MkdirAll(filepath.Join(root, "lib"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "src", "a.go"), []byte("a"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "src", "sub", "b.go"), []byte("b"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "lib", "c.go"), []byte("c"), 0o644))
	mustGit(t, root, "init", "-q")
	mustGit(t, root, "add", ".")
	mustGit(t, root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")

	// scope="src",query=".go":只命中 src/a.go + src/sub/b.go,不含 lib/c.go
	got, err := FuzzyFind(root, "src", ".go", 0)
	if err != nil {
		t.Fatalf("FuzzyFind scope=src .go: %v", err)
	}
	paths := nodePaths(got)
	if len(paths) != 2 || paths[0] != "src/a.go" || paths[1] != "src/sub/b.go" {
		t.Fatalf("FuzzyFind scope=src .go = %+v, want [src/a.go src/sub/b.go]", paths)
	}

	// scope="src",query="sub":命中目录 src/sub(从 src/sub/b.go 隐式推导,scope 内)
	got, err = FuzzyFind(root, "src", "sub", 0)
	if err != nil {
		t.Fatalf("FuzzyFind scope=src sub: %v", err)
	}
	paths = nodePaths(got)
	if len(paths) != 2 || paths[0] != "src/sub" || paths[1] != "src/sub/b.go" {
		t.Fatalf("FuzzyFind scope=src sub = %+v, want [src/sub src/sub/b.go]", paths)
	}
	if !got[0].IsDir {
		t.Fatalf("src/sub should be dir: %+v", got[0])
	}
}

// 验证非 git 目录:WalkDir 跳过 .git / node_modules 等大目录,子串匹配、limit 截断、字母序。
func TestFuzzyFindPlain(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "keep.txt"), []byte("1"), 0o644))
	must(t, os.MkdirAll(filepath.Join(root, "deep", "nested"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "deep", "nested", "file.txt"), []byte("2"), 0o644))
	// 大目录:内容不应进结果
	must(t, os.MkdirAll(filepath.Join(root, "node_modules", "pkg"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "node_modules", "pkg", "index.js"), []byte("3"), 0o644))
	must(t, os.MkdirAll(filepath.Join(root, ".git"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, ".git", "config"), []byte("4"), 0o644))

	// "file" 只命中 deep/nested/file.txt(无目录名含 file)
	got, err := FuzzyFind(root, "", "file", 0)
	if err != nil {
		t.Fatalf("FuzzyFind plain file: %v", err)
	}
	paths := nodePaths(got)
	if len(paths) != 1 || paths[0] != "deep/nested/file.txt" {
		t.Fatalf("FuzzyFind plain file = %+v, want [deep/nested/file.txt]", paths)
	}

	// ".txt" 命中 keep.txt + deep/nested/file.txt(字母序:deep/... 在 keep 前)
	got, err = FuzzyFind(root, "", ".txt", 0)
	if err != nil {
		t.Fatalf("FuzzyFind plain .txt: %v", err)
	}
	paths = nodePaths(got)
	if len(paths) != 2 || paths[0] != "deep/nested/file.txt" || paths[1] != "keep.txt" {
		t.Fatalf("FuzzyFind plain .txt = %+v, want [deep/nested/file.txt keep.txt]", paths)
	}

	// 大目录内容被过滤:node_modules/index.js、.git/config 都不含……即便 query 命中也不该出现
	got, err = FuzzyFind(root, "", "index", 0)
	if err != nil {
		t.Fatalf("FuzzyFind plain index: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("node_modules should be skipped, got %+v", nodePaths(got))
	}
	got, err = FuzzyFind(root, "", "config", 0)
	if err != nil {
		t.Fatalf("FuzzyFind plain config: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf(".git should be skipped, got %+v", nodePaths(got))
	}

	// limit 截断
	got, err = FuzzyFind(root, "", ".txt", 1)
	if err != nil {
		t.Fatalf("FuzzyFind plain .txt limit=1: %v", err)
	}
	if len(got) != 1 || got[0].Path != "deep/nested/file.txt" {
		t.Fatalf("FuzzyFind plain .txt limit=1 = %+v", nodePaths(got))
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
