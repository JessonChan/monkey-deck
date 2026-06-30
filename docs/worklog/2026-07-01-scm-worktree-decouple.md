# 2026-07-01 SCM 面板可见性与 worktree 解耦(git 项目不再因「没勾独立分支」而不显示源代码管理)

## 起因
用户发现:建会话时如果没勾选「新建独立分支」,右侧 SCM(源代码管理)面板不显示,即使项目目录本身就是一个 git 仓库。Stage/Diff/Commit 全部失效。

用户同时调研了 reference:
- /references/vscode/extensions/git/src/(relevant `git.ts` / `model.ts`):VS Code 的 SCM 面板显示跟「工作目录是不是 git repo」绑定,跟有没有独立 worktree **解耦**
- /references/orca(Electron desktop agent client):`repo-kind.ts` 的 `git` / `folder` 判定 —— folder repo 永远不显示 SCM,git repo 始终显示
- /references/real-agent-kanban(Next.js kanban):无 SCM UI(worktree 绑定 task 生命周期)

用户评判:原设计(SCM 可见性 = session.branch 非空 = 建了 worktree)错配 —— 正确的语义应该是 SCM 可见性 = session 的工作目录(项目目录)是不是 git repo,跟有没有独立 worktree 解耦。

## 根因(设计,非 bug)

**`internal/chat/chat.go` `ChatService.CreateSession`** 在 `useWorktree=true` 时只为 session 建 worktree,`branch` 字段被赋值为 `md/<short>`:

```go
if useWorktree && worktree.IsRepo(proj.Path) {
    branch := "md/" + short
    ...
    se.WorktreePath, se.Branch = wtPath, branch
}  // ← 否则 branch=""、se.WorktreePath=""
```

**前端 `frontend/src/components/SidePanel.tsx`** 用 `!!props.branch` 判定 SCM 可见性:

```js
const hasSCM = !!props.branch;
```

`branch` 来自 `App.tsx` `activeSession.branch || ""`,只在勾了 worktree 才非空 → git 项目、没勾,SCM 就不显示。

**后端 git 操作(`SessionChanges`/`SessionDiff`/`SessionStage`/`SessionUnstage`/`SessionDiscard`/`SessionCommit`/`SessionFileDiff`)全部持有老 `worktreeOf(sessionID)` helper:**

```go
func (s *ChatService) worktreeOf(sessionID string) (string, error) {
    ...
    if se == nil || se.WorktreePath == "" {
        return "", fmt.Errorf("session 无独立 worktree(非 git 项目或未建)")
    }
    return se.WorktreePath, nil
}
```

→ 没 worktree 就直接报错,所有 SCM 操作都中断。

三层叠加:建文档用 worktree 才建 worktree,前端用 branch 判 SCM,后端用 worktreeOf 取操作目录 — 共同把「git 项目但没勾独立分支」的会话锁在 SCM 面板之外。

## 改法

### 1. 后端:`scmDir` + `hasSCM` 取代 `worktreeOf`

```go
// scmDir 返回 session 的 git 操作目录
func (s *ChatService) scmDir(sessionID string) (string, error) {
    se, err := s.st.GetSession(s.ctx, sessionID); if err != nil { return "", err }
    proj, err := s.st.GetProject(s.ctx, se.ProjectID); if err != nil { return "", err }
    if se.WorktreePath != "" { return se.WorktreePath, nil }       // 独立 worktree
    if worktree.IsRepo(proj.Path) { return proj.Path, nil }       // fallback 到项目目录
    return "", fmt.Errorf("session 无 git 上下文(非 git 项目)")
}

// hasSCM 报告 session 是否应显示 SCM 面板
func (s *ChatService) hasSCM(sessionID string) bool {
    dir, err := s.scmDir(sessionID)
    if err != nil { return false }
    return worktree.IsRepo(dir)
}
```

删除 `worktreeOf`(原意是「仅返回 worktree,非 git 报错」,已被 `scmDir` 覆盖)。变更后所有 SCM 调用方(SessionChanges/SessionDiff/SessionStage/SessionUnstage/SessionDiscard/SessionCommit/SessionFileDiff)统一用 `scmDir` + `hasSCM` 守卫。

### 2. 前端:`isGitProject` prop 替换 `branch` 判 SCM 可见性

`frontend/src/components/SidePanel.tsx`:
```ts
const hasSCM = props.isGitProject;  // 原为 !!props.branch
```

`frontend/src/App.tsx`:
- 新增 `gitByProject: Record<string,boolean>` 状态,在 `refreshProjects` 中探测每个项目的 `IsGitProject` 并缓存
- `<SidePanel>` 新增 `isGitProject={gitByProject[selectedProject?.id ?? ""] ?? false}`

`branch` 作为展示用 GitPanel props 仍传入(有 worktree 时显示分支名),**不再用于可见性判定**。

### 3. `SessionDiff` 行为无 worktree 时提供「工作区改动」视图(无分支名,直接展示 `StatusFiles` 的 M/A/D/U 列表),有 worktree 时保留原有的 `diff --stat` + commit log 视图。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `internal/chat/chat.go` | 加 `scmDir` / `hasSCM` 两个 helper;删 `worktreeOf`;`SessionChanges` 用 `hasSCM` 守卫;`SessionDiff` 拆 worktree vs 非 worktree 视图;`SessionStage` / `SessionUnstage` / `SessionDiscard` / `SessionCommit` / `SessionFileDiff` 改调 `scmDir` |
| `frontend/src/components/SidePanel.tsx` | `Props` 加 `isGitProject: boolean`,`hasSCM = props.isGitProject`(原 `= !!props.branch`)|
| `frontend/src/App.tsx` | 新增 `gitByProject` 状态并在 `refreshProjects` 探测;`<SidePanel>` 带 `isGitProject` prop |
| `internal/chat/scm_test.go` | 新增 `TestSCMNonWorktreeGitSession`:无 worktree + git 项目 → Changes/Stage/Commit 三段链路 verification |

## 验证

- `go build .` exit 0
- `go test ./internal/... -count=1`(8 packages + 1 no tests)全绿,关键:
  - `TestSCMNonWorktreeGitSession` 通过:无 worktree + git 项目,`SessionChanges`/`SessionStage`/`SessionCommit` 全程可用
  - `TestSCMNoWorktree`(原回归用例)通过:非 git 项目无 worktree 时 4 个写操作仍被拒
  - `TestSCMBusyGuard` / `TestSCMBindings` / `TestMergeSessionNoAutoCommit` / `TestMergeSessionConflictMessage` 全过,无回归
- `npx tsc --noEmit` 通过
- `wails3 gen bindings` 不需要(no Go 导出签名变更,`scmDir`/`hasSCM` 均小写未导出)

## 权衡 / OPEN

- 所有 git 项目的 session 都显示 SCM,即使是不想看到的只读展示(原「不勾就不看」是意外)。可以接受,VS Code / orca 都是如此。
- `SessionDiff` 在非 worktree 场景下只展示工作区改动列表,没有 commit log / branch 名(需 MergeSession 才有 branch)。若将来需要更丰富的非 worktree 视图(如「此 session 相较项目 HEAD 的 diff」),须在 `proj.Path` 上做 `git log --oneline -n` 或类似探测 —— 但非本次 ask(此时 agent 只改了工作区,未 commit)。
- 无:wails3 dev 实机验证(需 GUI + 真 harness)。逻辑 + 单测覆盖。

## 下一步

可选:wails3 dev 实机跑一轮 git 项目不勾「独立分支」,确认 SCM 入口立即可见、Stage/Diff/Commit 全流程正常,切换 worktree session 切回仍正常。
可选(新需求,非本次):若用户希望「git 项目强制建 worktree」(对齐 RAK),可在 `CreateSession` 去掉 `useWorktree` 参数,git 项目自动建 worktree —— 那是 §1.4 的另一条路,目前保留现有行为。

## 提交说明

计划提交(用户尚未提交):
- `internal/chat/chat.go` + `internal/chat/scm_test.go`:`feat(chat): SCM 解耦 worktree —— git 项目不勾「独立分支」也显示源代码管理`
- `frontend/src/components/SidePanel.tsx` + `frontend/src/App.tsx`:`feat(ui): SCM 可见性改用项目 git repo 判定,跟 worktree 解耦`
- `AGENTS.md` §5.4 补一条本项目坑记录(待用户确认后带入)
- `docs/worklog/2026-06-30-trim-harness-default-omp.md` / `docs/worklog/2026-06-30-permission-memory-command-exec.md` / `docs/worklog/2026-06-30-per-file-worklog.md` / `docs/worklog/2026-06-30-deprecate-process-md.md` / `docs/worklog/2026-06-30-chat-scroll-on-footer-resize.md` 等 worklog 条目格式对齐本文
