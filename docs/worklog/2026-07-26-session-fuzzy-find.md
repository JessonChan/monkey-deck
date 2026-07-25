# 2026-07-26 后端 SessionFuzzyFind:session 工作目录文件模糊查找

**类型**:feat(backend)

## 起因

右侧「文件」面板目前只有逐层懒加载列目录(`fsview.ListDir`),无法跨整棵工作目录树快速跳到某个文件。需要一个后端能力:给定 query 子串,在 session 的 cwd 下递归模糊匹配文件路径,返回 limit 个命中,供前端做「Go to File / 快速打开」类体验。任务 #23071。

## 设计

数据源分两条,都钉在 session cwd(经 `cwdOf` 解析,git 项目 = worktree,非 git = 项目目录):

1. **git 仓库**:复用 `listGit` 的可见集来源 —— 把原本内联在 `listGit` 里的 `git ls-files --cached --others --exclude-standard --full-name` 抽成独立 helper `gitVisibleFiles(root, rel)`,`listGit`(按层拆直接子项)与新 `FuzzyFind`(全量子串匹配)共用。这样 `.gitignore`(含 node_modules / dist / build 等)由 git 自己负责过滤,零额外维护。
2. **非 git 目录**:降级 `filepath.WalkDir`,用黑名单 `heavyDirs`(.git / node_modules / vendor / dist / build / .next / .nuxt / .sveltekit / .turbo / target / __pycache__ / .venv / venv / .cache / bower_components)整棵 `SkipDir`。非 git 项目没有 .gitignore,这是必要兜底,否则一个大 node_modules 会把结果灌爆。

匹配规则(KISS,先做最直白的):
- **子串匹配**(contiguous),不是 fzf 式离散字符序;按整条相对路径(含目录段)匹配,所以 `sub/b` 能命中 `src/sub/b.go`。
- **大小写不敏感**(query 与 path 都 `ToLower`)。
- **仅文件**(`IsDir=false`)—— 文件查找器的典型语义;目录不是本任务目标。
- **结果按路径字母序**:git 路径靠 `git ls-files` 默认排序 + 顺序取前 limit;walk 路径靠 `WalkDir` 的字典序遍历。两个数据源天然有序,无需额外排序。
- **limit 截断**:git 路径 `break`、walk 路径返回 `fs.SkipAll` 提前停;`limit<=0` 取 `defaultFuzzyLimit=100`;空 query 直接返回 nil。

git 不可用 / `gitVisibleFiles` 失败时,git 路径降级 `fuzzyWalk`,保证可用(与 `listGit` 降级 `listPlain` 的策略一致)。

## 改了哪些文件

- `internal/fsview/fsview.go`
  - 抽出 `gitVisibleFiles(root, rel)`(原 `listGit` 内联的 git ls-files 逻辑),`listGit` 改为调用它(行为不变,纯重构)。
  - 新增 `heavyDirs` 黑名单、`defaultFuzzyLimit` 常量、`FuzzyFind(root, query, limit)`、`fuzzyGit`、`fuzzyWalk`。
  - 新增 `io/fs` import。
- `internal/chat/chat.go`:新增 `SessionFuzzyFind(sessionID, query, limit)`,走 `cwdOf` 拿 root 后委托 `fsview.FuzzyFind`(与 `SessionListDir` 等同构)。
- `internal/fsview/fsview_test.go`:新增 `TestFuzzyFindGit`(尊重 .gitignore / 子串 / 字母序 / limit / 大小写不敏感)、`TestFuzzyFindPlain`(大目录跳过 / 子串 / 字母序 / limit)、`TestFuzzyFindEmptyQuery`(空 / 纯空白 query 返回 nil);加 `nodePaths` 辅助。

## 验证

- `go build ./internal/...` / `go vet ./internal/...`:全过。
- `go test ./internal/...`:全过(含 fsview 9 个用例)。
- `go build ./...` / 前端 `bun run build` 的失败是**预存环境问题**(main.go embed `frontend/dist` 缺前端构建产物 + 前端缺 `wails3 gen bindings` 生成的类型),与本次后端改动无关;本次只动 Go 后端 + Go 测试。

## 下一步

- 前端:在文件面板接 `SessionFuzzyFind`(一个 quick-open 输入框,debounce 调用),`wails3 gen bindings` 后即有 TS 类型。
- 若需要更强匹配(离散字符 fuzzy / 文件名加权 / 最近打开置顶),再迭代匹配算法;当前子串已覆盖绝大多数「我知道文件名一部分」的场景。
