# 2026-08-09 Re-review #24187 P2 修复:IsGitProject/HasGitContext 拆分(APPROVE)

**起因**:Task #24188 对 #24187 的 P2 修复(commit `95e1cff`,`fix(scm): split IsGitProject ...`)
做 Backend Reviewer 二审。原 P2 指出上一条(2026-08-09 sub-repo fallback)把两个**假阳性容忍度不同**
的判定混进同一个 `IsGitProject`(放宽了 worktree 门控 → wrapper 项目「开关可用但点了会坏」)。
P2 修复拆成严格 / 放宽两个方法。本次复审确认拆分**正确且完整**。

**复审范围**(仅后端,`internal/`):
- `internal/chat/chat.go`:`IsGitProject`(严格,`IsRepo(proj.Path)`)、`HasGitContext`(放宽,
  `IsRepo(proj.Path) || FindSubRepo != ""`)、`scmDir`(已含 worktree + proj.Path + FindSubRepo 三级)。
- `internal/chat/scm_test.go`:`TestIsGitProject_StrictNoSubRepoFallback`(严格 / 放宽 / 纯非 git 三路)。
- 跨调用方一致性核对(见下)。

**结论(逐条核对硬约束 / 反模式)**:

1. **语义拆分正确,调用方各得其所**:
   - `IsGitProject`(严格)= `IsRepo(proj.Path)`,只服务 worktree 门控。✅
   - `HasGitContext`(放宽)= `IsRepo(proj.Path) || FindSubRepo != ""`,只服务 SCM 面板可见性。✅
   - 后端**内部**两处 worktree 门控不在导出方法上,而是各自内联 `worktree.IsRepo(proj.Path)`(与
     `IsGitProject` 等价、严格),未误用放宽谓词:
       - `createSession`(`chat.go:614`):`if useWorktree && worktree.IsRepo(proj.Path)`。✅ 严格。
       - `CreateGuestSession`(`chat.go:724`):`if !worktree.IsRepo(proj.Path)`。✅ 严格(guest session
         必须挂到既有 worktree,要求项目本身是 repo)。
   - 放宽侧 `scmDir`(`chat.go:1183`)与 `hasSCM`(`chat.go:1213`,per-session 经 scmDir)语义不变。✅
   - **没有遗漏的调用方**(`grep` 全 `internal/` 仅 chat.go 定义 + scm_test.go 引用)。拆分完整。

2. **不变量成立**(§5.3):`HasGitContext` 的判定口径 == `scmDir` 的**项目级**口径(即不含 worktree
   那一级:`IsRepo(proj.Path) || FindSubRepo != ""`)。`gitByProject` 是项目级缓存(加载项目时计算,
   当时无 session / 无 worktree),`hasSCM` 是 per-session(有 worktree 时恒 true),两者用各自正确的
   谓词,不冲突。**SCM 可见性 flag 与实际 `scmDir` 能力不会错配。**

3. **类型补丁反模式排查**(reviewer 反模式清单):`HasGitContext` 新增后被前端 `gitByProject`
   (`App.tsx:217`)消费,**不是死字段**。

4. **测试反模式排查**:`TestIsGitProject_StrictNoSubRepoFallback` 断言布尔语义契约(严格必 false /
   放宽必 true / 纯非 git 两者都 false),不是锚定易变值;且覆盖了 control case(纯非 git)。✅
   未覆盖的错误路径(`proj == nil`、store err)在改动前 `IsGitProject` 同样未测,**非本次回归**,
   不阻塞。

5. **注释 / 文档纪律**:两个新 doc 注释均为英文(§3.7)。✅ commit message 说清「改了什么 + 为什么」(§6.2)。

6. **验证复跑**:
   - `go vet ./internal/chat/ ./internal/worktree/`:clean。
   - `gofmt -l internal/chat/chat.go internal/chat/scm_test.go`:clean。
   - `go test ./internal/chat/ ./internal/worktree/`:全过(含 `TestIsGitProject_StrictNoSubRepoFallback`、
     `TestSCM_SubRepoFallback`、`TestSCMNoWorktree`、`TestSCMNonWorktreeGitSession`、`TestSessionCurrentBranch`,
     零回归)。
   - `go build ./...`:`main.go:22 pattern all:frontend/dist` 报错为 **pre-existing**(worktree 未构建
     前端 embed,与本次改动无关,见上一条 worklog 同样标注)。

**Verdict:APPROVE**。P2 修复把「严格 worktree 门控」与「放宽 SCM 可见性」正交拆开,后端调用方一致、
不变量自洽、测试覆盖到位,无需进一步改动。

**下一步 / 留意点(非阻塞)**:
1. 未来任何「跟 worktree 创建相关的门控」一律严格(`IsGitProject` 或内联 `IsRepo(proj.Path)`);任何
   「跟 SCM / diff / 改动可见性相关的」一律放宽(`HasGitContext` 或走 `scmDir`/`hasSCM`)。两个谓词
   的契约已在各自 doc 注释里写死,后续维护者照注释走即可。
2. 若 `scmDir` 的 FindSubRepo 策略调整(depth / 剪枝表),`HasGitContext` 必须同步——契约是「判定口径
   一致」。
3. (可选,P3)`IsGitProject` / `HasGitContext` 的 `proj == nil` / store-err 路径无单测;若后续加固测试
   覆盖率可补,但不影响本审批。
