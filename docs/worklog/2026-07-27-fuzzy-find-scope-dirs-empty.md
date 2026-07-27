# 2026-07-27 后端 FuzzyFind 三件套:空 query 返根子项(含目录)+ fuzzy 含目录 + scope 参数

**类型**:feat(backend)

## 起因

Task #23448。当前 `fsview.FuzzyFind` / `ChatService.SessionFuzzyFind`(Task #23071 落地)有三个体验缺口,阻碍前端做更完整的「快速打开 / 文件选择器」:

1. **空 query 返回 nil**:用户打开查找器还没开始打字时看不到任何东西。期望像 IDE quick-open:空输入直接展示项目顶层(根的直接子项),用户既可以挑、也可以往下钻。
2. **fuzzy 仅返文件**:`IsDir` 恒 false,目录完全不参与匹配。但用户找路径时常会输目录名(如 `src`、`sub`),命不中目录 = 体验残缺。
3. **无 scope 参数**:整棵 cwd 树全搜,没法把搜索范围限定到某个子树(如「只在 `frontend/src` 下找」)。前端 picker 若要做「在当前目录内搜索」就缺这个旋钮。

## 设计

签名由 `FuzzyFind(root, query, limit)` 改为 `FuzzyFind(root, scope, query, limit)`;`SessionFuzzyFind` 同步 `(sessionID, scope, query, limit)` 透传。

### scope 语义

- `scope` 是相对 root 的路径,空 = 整棵 root 树;先经 `safeJoin` 校验防越界(`../` / 符号链接逃逸都拦下)。
- 限定的子树 = `root/scope`。命中结果的 `Path` 字段**仍是 root-相对**(与 `ListDir` 一致,前端原样回传不歧义),scope 只收窄候选集、不改 Path 基准。

### query 行为

- **空 / 纯空白**:委托 `ListDir(root, scope)` 返 scope 的直接子项(含目录、目录优先、字母序、git 仓库尊重 .gitignore)—— picker 初始态。
- **非空**:在 scope 子树内按整条 root-相对路径(含目录段)子串匹配,大小写不敏感,**文件与目录都参与**。例:`"sub/b"` 命中 `src/sub/b.go`;`"src"` 命中目录 `src` + 其下所有路径含 `src/` 的条目。
- **limit<=0** 取 `defaultFuzzyLimit=100`;结果按路径字母序(大小写不敏感),**目录与文件混合排序**(fuzzy finder 语义,非 ListDir 的目录优先)。

### 两路数据源如何纳入目录

- **git 仓库**(`fuzzyGit`):`git ls-files` 只跟踪文件不跟踪目录,但「含文件的目录必然存在」,所以从文件路径**隐式推导目录** —— 对每条文件路径逐级向上取祖先目录,遇 scope(不含 scope 本身,scope 是搜索根不是候选)或越出 scope 即止。推导出的目录 + 原始文件合成候选集。
- **非 git 目录**(`fuzzyWalk`):`WalkDir` 本来就遍历目录,原实现只是 `return nil` 跳过;改为把目录也收进候选集(`heavyDirs` 子树仍整棵 `SkipDir`)。

两路收尾共用 `matchAndLimit(root, cands, query, limit)`:候选集 → 按 Path 大小写不敏感排序 → 子串过滤 → 截断 limit → 构造 `FileNode`(文件才填 `Size`,目录不填)。

### 踩坑:macOS 符号链接命名空间与 filepath.Rel

`fuzzyWalk` 原 v1 用 `safeJoin(root, scope)` 解析符号链接得到 `scopeAbs`,但 `filepath.Rel(root, p)` 用的 `root` 是调用方传入的**未解析**路径。macOS 上 `/var/folders/...` → 解析为 `/private/var/folders/...`,两个命名空间混用 → `Rel` 算出 `../../../../private/var/.../y.txt` 这种 `../` 串,作为 `Path` 回传给前端完全错乱。

**修法**:`fuzzyWalk` 改用 `filepath.Join(root, filepath.FromSlash(scope))`(不解析符号链接)作 walk 根,保证 walk 产生的 `p` 与 `root` 在同一名义空间,`Rel` 才能算出干净的相对路径。安全性不损失 —— `FuzzyFind` 入口的 `safeJoin(root, scope)` 已拦下越界,`fuzzyWalk` 信任调用方传入的已校验 scope。这与原 `fuzzyWalk` 直接 `WalkDir(root, ...)`(用原始 root,不解析)的做法一致,只是多了 scope 这层 Join。

## 改了哪些文件

- `internal/fsview/fsview.go`
  - `FuzzyFind` 签名加 `scope`;空 query 委托 `ListDir`;非空分流 `fuzzyGit`/`fuzzyWalk`(都带 scope)。
  - 新增 `fuzzyCand` 结构、`matchAndLimit`(共用收尾:排序 + 过滤 + 截断 + 构造 FileNode)、`collectGitCands`(从 git 文件列表推导文件 + 隐式目录候选)。
  - `fuzzyGit` 改为 `gitVisibleFiles(root, scope)`(原取全树)+ `collectGitCands` + `matchAndLimit`,目录参与匹配。
  - `fuzzyWalk` 从 `WalkDir(scopeAbs)` 收集文件 + 目录候选(跳 heavyDirs 子树),用 `filepath.Join` 而非 `safeJoin` 作 walk 根(避符号链接命名空间错配),收尾走 `matchAndLimit`。
- `internal/chat/chat.go`:`SessionFuzzyFind` 签名加 `scope`,透传 `fsview.FuzzyFind`。
- `internal/fsview/fsview_test.go`:
  - 现有用例(`TestFuzzyFindGit` / `TestFuzzyFindPlain`)补 scope 参数(`""`)与注释(原「仅文件」断言改为「此 query 无目录命中」的精确描述)。
  - 新增 `TestFuzzyFindEmptyQueryReturnsRootChildren`(空 query 返根子项含目录、目录优先、尊重 .gitignore)、`TestFuzzyFindEmptyQueryScoped`(空 query + scope 返 scope 子树子项、Path 仍 root-相对)、`TestFuzzyFindIncludesDirs`(query 命中目录名 → 目录出现在结果里、按路径序与文件混合)、`TestFuzzyFindScope`(非 git scope 限定 + 越界拒绝)、`TestFuzzyFindScopeGit`(git scope 限定 + 隐式目录推导)。

## 验证

- `go build ./internal/...` / `go vet ./internal/...`:全过。
- `go test ./internal/fsview/...`:全过(含 6 个 FuzzyFind 用例)。
- `go test ./internal/...`:全过(全包回归无影响)。
- 全仓 `go build ./...` 的失败是**预存环境问题**(`main.go` embed `frontend/dist` 缺前端构建产物),与本次后端改动无关。

## 下一步

- **前端适配(后续 frontend task)**:`SessionFuzzyFind` 签名变了(加 scope),前端 Composer / 文件 picker 需 `wails3 gen bindings` 后更新调用(`SessionFuzzyFind(sessionId, scope, query, limit)`)。Composer 的 @ mention 仍传 `scope=""`(全项目搜索);文件面板若做「在当前目录内搜索」可传当前展开目录。
- 若需更强匹配(离散字符 fuzzy / 文件名加权 / 最近打开置顶),迭代 `matchAndLimit` 的排序与评分(当前是路径字母序 + 子串,够用)。
