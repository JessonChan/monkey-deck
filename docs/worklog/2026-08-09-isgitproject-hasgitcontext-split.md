# 2026-08-09 拆分 IsGitProject(严格 worktree 门控)与 HasGitContext(放宽 SCM 面板)

**起因**:Review(P2)指出上一条 worklog(`2026-08-09-isgitproject-subrepo-fallback.md`)给
`IsGitProject` 加的 `FindSubRepo` fallback 把两个**语义不同**的判定混到了一起:

- **worktree 门控**(NewSessionModal「新建分支」开关 + `createSession` 预取):`git worktree add`
  以 **proj.Path 自身**为 repo 操作。wrapper 目录非 repo 时,即便子目录是 repo,也无法从 wrapper
  建 worktree → 必须**严格**只认 `IsRepo(proj.Path)`。
- **SCM 面板可见性**(`gitByProject` → `SidePanel.hasSCM`):SCM 走 `scmDir`,后者已有 `FindSubRepo`
  fallback(子 repo 也能 Stage/Diff/Commit)。可见性 flag 必须**与 scmDir 语义一致(放宽)**,否则
  wrapper 项目隐藏 SCM,明明改动能在子 repo 里被 surface。

上一条把 `IsGitProject` 一刀放宽,导致 wrapper 项目出现「worktree 开关可用但点了会坏」的错配。

**根因 / 设计**:`IsGitProject` 被当两件事用,但两件事的可接受假阳性不同。拆成两个语义清晰的方法,
各自只服务于一个调用方语义(§5.3「找不变量」:不变量是「调用方需要的严格度」,不是「git 可见性」这
一个概念硬塞两种门控):

| 方法 | 判定 | 调用方 |
|---|---|---|
| `IsGitProject`(严格)| `IsRepo(proj.Path)` | worktree 门控(NewSessionModal) |
| `HasGitContext`(放宽)| `IsRepo(proj.Path) \|\| FindSubRepo != ""` | SCM 面板可见性 |

**改法**:
1. `internal/chat/chat.go`:
   - `IsGitProject` 改回**严格**:只 `IsRepo(proj.Path)`,去掉 `FindSubRepo` fallback。doc 注释英文,
     说明这是 STRICT worktree 门控、禁止并入 sub-repo。
   - 新增 `HasGitContext`(放宽):`IsRepo(proj.Path)` 否则 `FindSubRepo != ""`。doc 注释英文,说明
     这是 SCM 面板的 RELAXED 判定、与 `scmDir` fallback 对齐、worktree 门控必须用 `IsGitProject`。
2. `frontend/src/App.tsx`:
   - `refreshProjects` 里 `gitByProject`(SCM 可见性缓存)改调 `ChatService.HasGitContext`(放宽)。
   - `createSession` 的 worktree 门控**保持** `ChatService.IsGitProject`(严格)。
   - 两处注释各点明严格 / 放宽的区别,防再次混淆。
3. `wails3 generate bindings ./...`:新增导出方法 `HasGitContext` → 重新生成前端 bindings。
4. `internal/chat/scm_test.go`:原 `TestIsGitProject_SubRepoFallback` 改写为
   `TestIsGitProject_StrictNoSubRepoFallback`:wrapper + 子 repo 时 `IsGitProject=false`(严格)、
   `HasGitContext=true`(放宽);纯非 git 两者都 false。`TestSCM_SubRepoFallback`(走 `scmDir`/`hasSCM`)
   不变 —— 它本就走放宽路径,行为零回归。

**改了哪些文件**:
- 改:`internal/chat/chat.go`(`IsGitProject` 收严 + 新增 `HasGitContext`,英文 doc 注释)
- 改:`internal/chat/scm_test.go`(`TestIsGitProject_StrictNoSubRepoFallback` 覆盖严格 / 放宽两路)
- 改:`frontend/src/App.tsx`(`gitByProject` 改用 `HasGitContext`;worktree 门控保留 `IsGitProject`;注释)
- 再生:`frontend/bindings/*`(`wails3 generate bindings` 产物,gitignore,不入库)

**验证**:
- `go build ./...`:通过(`frontend/dist` 已构建,embed 正常)。
- `go vet ./...`:clean。
- `gofmt -l internal/chat/chat.go internal/chat/scm_test.go`:clean(已 format)。
- `go test ./internal/chat/ ./internal/worktree/`:全过。
- 定向跑 `TestIsGitProject_StrictNoSubRepoFallback` / `TestSCM_SubRepoFallback` /
  `TestSCMBindings` / `TestSCMNoWorktree`:全 PASS,零回归。
- 前端 `bun run build`(tsc + vite build):通过。

**下一步 / 风险点**:
1. 两个方法语义现已正交:日后任何「跟 worktree 创建相关的门控」都用 `IsGitProject`(严格);
   任何「跟 SCM / diff / 改动展示相关的可见性」都用 `HasGitContext` 或直接走 `scmDir`/`hasSCM`(放宽)。
2. 若未来 `scmDir` 的 fallback 策略调整(如改 depth / 剪枝表),`HasGitContext` 必须同步保持与之一致
   —— 两者的契约是「判定口径 == scmDir 的口径」,否则可见性与实际能力错配。
