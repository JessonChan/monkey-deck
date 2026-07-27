// Package fsview 提供受限工作目录内的文件浏览 / 管理。
//
// 路径钉在 session 的 cwd(git 项目的 worktree 或非 git 项目目录),前端只传相对路径,
// 后端 safeJoin 解析并校验「结果仍落在 root 内」,防 ../ 越界与符号链接逃逸。
//
// 供右侧「文件」面板:列目录(懒加载,git 仓库尊重 .gitignore)、读文件、增删改。
package fsview

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
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

// gitVisibleFiles 用 git ls-files 取得 root 下可见(非 gitignore 忽略)文件的相对路径(递归)。
// 复用于 listGit(按层拆成直接子项)与 FuzzyFind(全量子串匹配);rel 为空取全部,非空仅取该子树。
// 输出按路径字母序(git ls-files 默认排序),始终用 / 分隔。
func gitVisibleFiles(root, rel string) ([]string, error) {
	args := []string{"-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "--full-name"}
	if rel != "" {
		args = append(args, "--", rel)
	}
	out, err := gitRaw(root, args...)
	if err != nil {
		return nil, err
	}
	var files []string
	for _, line := range strings.Split(out, "\n") {
		line = filepath.ToSlash(strings.TrimSpace(line))
		if line != "" {
			files = append(files, line)
		}
	}
	return files, nil
}

// listGit 用 git ls-files 取得可见(非忽略)文件集合,据此构造直接子项。
// dirSet 汇总含文件的子目录,fileSet 收集本层文件;目录与文件分别排序。
func listGit(root, rel string) ([]FileNode, error) {
	files, err := gitVisibleFiles(root, rel)
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
	for _, line := range files {
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

// heavyDirs 是非 git 目录 WalkDir 时整棵跳过的「大目录 / 噪声目录」黑名单。
// git 仓库由 git ls-files --exclude-standard(尊重 .gitignore)负责过滤,不走这里;
// 此处只兜底非 git 项目(没有 .gitignore 的场景),避免把 node_modules / vendor 等灌进结果。
var heavyDirs = map[string]struct{}{
	".git":              {},
	"node_modules":      {},
	"bower_components":  {},
	"vendor":            {},
	"dist":              {},
	"build":             {},
	".next":             {},
	".nuxt":             {},
	".sveltekit":        {},
	".turbo":            {},
	"target":            {},
	"__pycache__":       {},
	".venv":             {},
	"venv":              {},
	".cache":            {},
}

// defaultFuzzyLimit 是 limit<=0 时采用的结果上限。
const defaultFuzzyLimit = 100

// FuzzyFind 在 root 的 scope 子树下按 query 子串模糊匹配路径,返回最多 limit 个命中
// (文件与目录都参与匹配)。
//
// scope 限定搜索范围(相对 root 的路径,空表示整棵 root 树);先经 safeJoin 校验防越界。
//
// query 行为:
//   - 空 / 纯空白:返回 scope 的直接子项(含目录,等价 ListDir),作为 picker 初始态
//     —— 用户打开查找器还没输入时直接看到顶层可选项。
//   - 非空:在 scope 子树内按整条相对路径(含目录段)子串匹配,大小写不敏感,命中含目录。
//     例如 "sub/b" 命中 "src/sub/b.go","go" 命中所有 .go 文件与名为 xxxgo 的目录。
//
// 数据源分两条:
//   - git 仓库:复用 gitVisibleFiles(尊重 .gitignore);目录从文件路径隐式推导
//     (git 不跟踪目录,但含文件的目录必然存在)。
//   - 非 git 目录:filepath.WalkDir 跳过 heavyDirs(.git / node_modules 等)整棵子树。
//
// 返回路径始终相对 root(与 ListDir 一致,前端原样回传)。limit<=0 取 defaultFuzzyLimit。
// 结果按路径字母序(大小写不敏感),目录与文件混合排序(fuzzy finder 语义,非 ListDir 的目录优先)。
func FuzzyFind(root, scope, query string, limit int) ([]FileNode, error) {
	if _, err := safeJoin(root, scope); err != nil {
		return nil, err
	}
	query = strings.ToLower(strings.TrimSpace(query))
	if limit <= 0 {
		limit = defaultFuzzyLimit
	}
	// 空 query:返 scope 直接子项(含目录),picker 初始态。
	if query == "" {
		return ListDir(root, scope)
	}
	if isGitRoot(root) {
		return fuzzyGit(root, scope, query, limit)
	}
	return fuzzyWalk(root, scope, query, limit)
}

// fuzzyCand 是 FuzzyFind 内部候选条目:相对 root 的路径 + 是否目录。
type fuzzyCand struct {
	path  string
	isDir bool
}

// matchAndLimit 把候选集按 query 子串过滤(大小写不敏感,匹配整条 root-相对路径)、
// 按路径字母序(大小写不敏感)排序、截断到 limit,构造 FileNode 列表。
// fuzzyGit / fuzzyWalk 共用此收尾逻辑,保证两路数据源的结果形状一致。
func matchAndLimit(root string, cands []fuzzyCand, query string, limit int) []FileNode {
	sort.Slice(cands, func(i, j int) bool {
		return strings.ToLower(cands[i].path) < strings.ToLower(cands[j].path)
	})
	out := make([]FileNode, 0, limit)
	for _, c := range cands {
		if len(out) >= limit {
			break
		}
		if !strings.Contains(strings.ToLower(c.path), query) {
			continue
		}
		n := FileNode{Name: filepath.Base(c.path), Path: c.path, IsDir: c.isDir}
		if !c.isDir {
			n.Size = fileSize(filepath.Join(root, c.path))
		}
		out = append(out, n)
	}
	return out
}

// collectGitCands 从 git 文件列表构造候选集(文件 + 从路径隐式推导的目录)。
// 推导出的目录限于 scope 子树内(不含 scope 本身,scope 是搜索根不是候选)。
// 例:scope="src"、文件 "src/sub/b.go" 推导出目录 "src/sub";scope="" 同文件推导出 "src" + "src/sub"。
// 结果未排序(matchAndLimit 统一排序)。
func collectGitCands(files []string, scope string) []fuzzyCand {
	dirSet := map[string]struct{}{}
	for _, f := range files {
		// 逐级向上取祖先目录,遇 scope 或越出 scope 即止。
		dir := f
		for {
			i := strings.LastIndexByte(dir, '/')
			if i < 0 {
				break
			}
			dir = dir[:i]
			if dir == scope {
				break // scope 本身不作为候选
			}
			if scope == "" || strings.HasPrefix(dir, scope+"/") {
				dirSet[dir] = struct{}{}
			} else {
				break // 越出 scope(理论不会出现,gitVisibleFiles 已按 scope 过滤)
			}
		}
	}
	cands := make([]fuzzyCand, 0, len(files)+len(dirSet))
	for d := range dirSet {
		cands = append(cands, fuzzyCand{d, true})
	}
	for _, f := range files {
		cands = append(cands, fuzzyCand{f, false})
	}
	return cands
}

// fuzzyGit 在 git 仓库里匹配:复用 gitVisibleFiles(尊重 .gitignore),文件 + 隐式推导的目录都参与。
// git ls-files 失败时降级 fuzzyWalk,保证可用。
func fuzzyGit(root, scope, query string, limit int) ([]FileNode, error) {
	files, err := gitVisibleFiles(root, scope)
	if err != nil {
		return fuzzyWalk(root, scope, query, limit)
	}
	return matchAndLimit(root, collectGitCands(files, scope), query, limit), nil
}

// fuzzyWalk 在非 git 目录里匹配:WalkDir 从 scope 起遍历,跳过 heavyDirs 子树,
// 文件与目录都参与。scope 越界由 FuzzyFind 先前的 safeJoin 拦下;此处直接 Join
// (不解析符号链接)以保持 walk 产生的 p 与 root 在同一路径命名空间,filepath.Rel 才能算出干净的相对路径
// (macOS 上 root=/var/... 与 safeJoin 解析出的 /private/var/... 混用会让 Rel 产生 ../ 串)。
func fuzzyWalk(root, scope, query string, limit int) ([]FileNode, error) {
	scopeAbs := filepath.Join(root, filepath.FromSlash(scope))
	var cands []fuzzyCand
	werr := filepath.WalkDir(scopeAbs, func(p string, d fs.DirEntry, werr error) error {
		if werr != nil {
			return nil // 跳过不可读项
		}
		if p == scopeAbs {
			return nil // 跳过 scope 根本身
		}
		if d.IsDir() {
			if _, skip := heavyDirs[d.Name()]; skip {
				return filepath.SkipDir
			}
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil {
			rel = d.Name()
		}
		cands = append(cands, fuzzyCand{filepath.ToSlash(rel), d.IsDir()})
		return nil
	})
	if werr != nil {
		return nil, werr
	}
	return matchAndLimit(root, cands, query, limit), nil
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

// maxImageSize 读图大小上限(超出报错;避免把大文件 base64 灌进 webview)。
const maxImageSize = 8 * 1024 * 1024

// extToImageMime 常见图片扩展名 → mime。优先按扩展名判定,覆盖 SVG 等无法靠内容嗅探的文本格式。
var extToImageMime = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".bmp":  "image/bmp",
	".svg":  "image/svg+xml",
	".ico":  "image/x-icon",
}

// imageMimeToExt mime → 扩展名(不含点)。内容嗅探命中后反推扩展名用。
var imageMimeToExt = map[string]string{
	"image/png":     "png",
	"image/jpeg":    "jpg",
	"image/gif":     "gif",
	"image/webp":    "webp",
	"image/bmp":     "bmp",
	"image/svg+xml": "svg",
	"image/x-icon":  "ico",
}

// ImageData 是 ReadImage 的返回:dataURL 可直接喂 <img src>,扩展名供前端下载名 / 分类。
type ImageData struct {
	DataURL   string `json:"dataUrl"`   // data:<mime>;base64,<b64>
	Extension string `json:"extension"` // 不含点,如 "png"
}

// ReadImage 读取 root/rel 的图片,返回 dataURL(data:<mime>;base64,<b64>)与扩展名。
// 路径钉在 root(safeJoin 防 ../ 与符号链接越界);过大或非图片报错。
//
// mime 推断:先按扩展名(覆盖 SVG 等文本格式),扩展名缺失/未知时按内容嗅探
// (http.DetectContentType);二者都拿不到 image/* 视为非图片。
func ReadImage(root, rel string) (ImageData, error) {
	target, err := safeJoin(root, rel)
	if err != nil {
		return ImageData{}, err
	}
	info, err := os.Stat(target)
	if err != nil {
		return ImageData{}, err
	}
	if info.IsDir() {
		return ImageData{}, fmt.Errorf("是目录: %s", rel)
	}
	if info.Size() > maxImageSize {
		return ImageData{}, fmt.Errorf("图片过大(%d 字节),不读取", info.Size())
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return ImageData{}, err
	}
	mime, ext, ok := inferImage(rel, data)
	if !ok {
		return ImageData{}, fmt.Errorf("不是图片: %s", rel)
	}
	return ImageData{
		DataURL:   "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data),
		Extension: ext,
	}, nil
}

// inferImage 推断图片 mime 与扩展名。先按扩展名;扩展名缺失/未在白名单时按内容嗅探并反推扩展名。
// 返回 ok=false 表示非图片。
func inferImage(rel string, data []byte) (mime, ext string, ok bool) {
	if e := strings.ToLower(filepath.Ext(rel)); e != "" {
		if m, hit := extToImageMime[e]; hit {
			return m, strings.TrimPrefix(e, "."), true
		}
	}
	sniffed := http.DetectContentType(data)
	// DetectContentType 可能带 "; charset=utf-8",取分号前。
	if i := strings.IndexByte(sniffed, ';'); i >= 0 {
		sniffed = strings.TrimSpace(sniffed[:i])
	}
	if e, hit := imageMimeToExt[sniffed]; hit {
		return sniffed, e, true
	}
	return "", "", false
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
