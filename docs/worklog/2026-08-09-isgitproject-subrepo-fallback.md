# 2026-08-09 IsGitProject + scmDir 放宽:子目录 .git fallback

**起因**:用户把一个**外层目录**(不是 git 仓库本身,如 monorepo wrapper 或 `~/work/some-wrapper`)
加成项目时,`IsGitProject=false` → 前端 SCM 面板不显示、「新建分支」开关不可用;`scmDir` 报
「非 git 项目」。但真实 git 仓库其实在外层目录的某个**子目录**里(`wrapper/actual-repo/.git`)。
当前两条路径都只判 `IsRepo(proj.Path)`,对「项目目录非 git、子目录才是 git」的场景一刀切拒绝。

**根因 / 设计**:`IsRepo(path)` 只判 path 自身是否在 git 工作树内,不下探子目录。需要一个 best-effort
的子目录探测函数,把 `IsGitProject` 与 `scmDir` 的「git 可见性」判定从「proj.Path 本身」放宽到
「proj.Path 或其(限深剪枝后的)某子目录」。

新增 `worktree.FindSubRepo(root) string`:
- **递归限深**(`subRepoMaxDepth=2`):覆盖 1~2 层 wrapper 场景;不做全量深扫(性能 + 大型项目假阳性爆炸)。
- **剪枝**(`subRepoSkipDirs`):`node_modules` / `vendor` / `dist` / `build` / `target` / `.venv` /
  `__pycache__` / `.next` / `.gradle` 等依赖 / 构建目录永不下钻 —— 它们常含 vendored 上游仓库的 `.git`,
  是假阳性源头。`.git` 自身也不下钻。
- **两段判定**:先 `os.Stat(.git)`(快,纯文件系统),命中再用 `IsRepo` 复核是有效工作树
  (防坏 `.git` / 失效 gitdir 指针);复核失败继续往下找,不返假阳性。
- **root 自身不是候选**:调用方(IsGitProject)应先 `IsRepo(root)`。返回名字排序最前者
  (`os.ReadDir` 已排序),结果稳定可复现。

**改法**:
1. `internal/worktree/worktree.go`:新增 `subRepoSkipDirs` / `subRepoMaxDepth` / `FindSubRepo` /
   `findSubRepo`(递归内部实现),紧跟 `IsRepo` 之后。
2. `internal/chat/chat.go` `IsGitProject`:`IsRepo(proj.Path)` 为真即 true;否则 `FindSubRepo != ""` 也算 true。
3. `internal/chat/chat.go` `scmDir`:`IsRepo(proj.Path)` 与 worktree 都不是时,加一道 `FindSubRepo` fallback,
   返回子 repo root;仍找不到才报「非 git 项目」。注释同步更新层级顺序。

**改了哪些文件**:
- 改:`internal/worktree/worktree.go`(`FindSubRepo` + 剪枝表 + 限深常量)
- 改:`internal/worktree/worktree_test.go`(7 个 `TestFindSubRepo_*`:immediate/nested/depth-limit/
  prune-deps/prefer-real/empty-missing/sorted-first)
- 改:`internal/chat/chat.go`(`IsGitProject` + `scmDir` 接入 `FindSubRepo` fallback,注释英文)
- 改:`internal/chat/scm_test.go`(`TestIsGitProject_SubRepoFallback` + `TestSCM_SubRepoFallback`,
  覆盖 IsGitProject 放宽 + scmDir fallback 端到端:hasSCM/Changes/Stage/Commit 全走子 repo)

**验证**:
- `go build ./internal/...`:通过(main.go 的 `all:frontend/dist` embed 报错是 pre-existing,需先构建前端,
  与本次改动无关)。
- `go vet ./internal/worktree/ ./internal/chat/`:clean。
- `go test ./internal/worktree/`:`TestFindSubRepo_*` 7/7 + 全量包通过。
- `go test ./internal/chat/`:`TestIsGitProject_SubRepoFallback` / `TestSCM_SubRepoFallback` 通过,
  全量包通过,零回归。

**下一步 / 风险点**:
1. `FindSubRepo` 仅在 `IsGitProject`(项目加载时,前端缓存到 `gitByProject`)与 `scmDir`(SCM 操作前)
   调用,均非热路径,限深 2 + 剪枝成本可接受;若超大目录出现卡顿可调 `subRepoMaxDepth=1`。
2. 多子 repo 时取排序最前的一个,未提供「让用户选哪个子 repo」的 UI(当前 best-effort 够用);
   真有歧义需求再做成 selectable。
3. `.git` 文件形式(submodule gitdir 指针)已被 `IsRepo` 复核覆盖:指针失效 → 复核失败 → 继续找,
   不返坏路径。
