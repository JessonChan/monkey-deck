# 2026-07-14 修复 GitPanel 非 worktree 模式分支显示为空

## 起因
Task #14778:源代码管理面板(GitPanel)在非 worktree 模式下分支显示错误。
复现:`GitPanel` 顶部那个分支徽标,worktree 会话正常显示 `md/<id>`,但非 worktree 的
git 项目会话该位置**空白**。

## 根因
- 分支徽标的数据来源是 `App.tsx` 里 `branch={activeSession.branch || ""}`(`App.tsx:970`),
  直接读 `Session.Branch` 字段。
- 而 `Session.Branch` 字段语义是「**worktree 模式下的会话分支**(`md/<id>`)**」**
  —— 只在 `CreateSession` 建了 worktree 时才赋值(`chat.go:426`),
  **非 worktree(含非 worktree 的 git 项目)恒为空串**。
- 所以前端直接拿它去显示,非 worktree 的 git 项目就显示空分支。这是「字段语义被误用
  当展示值」的典型:Branch 字段同时承担「worktree 分支名(给 merge/cleanup 用)」和
  「展示用当前分支」两件事,后者在非 worktree 没有兜底。

## 改法(读真实 HEAD,不重用 Branch 字段)
1. **后端新增 `SessionCurrentBranch(sessionID)`**(`internal/chat/chat.go`):读
   `scmDir` 拿到 session 的 git 工作目录(worktree 路径,或非 worktree git 项目的
   `proj.Path`),再 `worktree.HeadShort(dir)` 取真实当前分支(本地分支 / 远程跟踪
   分支 / detached 时短 commit)。非 git 项目静默返回空串(前端本就不显示 SCM)。
   - 关键:不把结果写进 `Session.Branch`——该字段给 `MergeSession`/`cleanupWorktree`/
     `SessionDiff` 用(要的是 `md/<id>`),展示与持久化解耦。
2. **前端**(`App.tsx`):新增 `branchBySession` 状态,`openSession` 时调
   `ChatService.SessionCurrentBranch` 拉真实分支;SidePanel 的 `branch` 改为
   `branchBySession[selectedSessionId] || activeSession.branch || ""`(worktree 模式
   fetch 完前先用 `activeSession.branch` 即时显示,fetch 回来是同一个 `md/<id>`,
   无闪烁)。

## 改了哪些文件
- `internal/chat/chat.go`:新增导出方法 `SessionCurrentBranch`。
- `internal/chat/scm_test.go`:新增 `TestSessionCurrentBranch`,覆盖三种模式
  (非 worktree git 项目 / worktree `md/<id>` / 非 git 项目)。
- `frontend/src/App.tsx`:`branchBySession` 状态 + `openSession` 里拉取 + SidePanel
  `branch` prop 改用真实分支。
- (`frontend/bindings/` 由 `wails3 generate bindings` 重新生成,不入库。)

## 验证
- `go build ./...` / `go vet ./...` 通过(加 `frontend/dist` stub 满足 embed)。
- `go test ./...` 全绿,含新 `TestSessionCurrentBranch`(本地分支 / worktree / 非 git 三路)。
- `cd frontend && bun run build`(tsc + vite)无类型 / 编译错误;`bun run test` 14 pass。
- `git status` 仅 3 个源文件改动,无 RAK 运行时文件 / AGENTS.md / bindings / dist / node_modules 入暂存。

## 下一步
- 如需在用户终端里手动 `git switch` 切分支后实时刷新徽标,可在 SCM 操作
  (commit/stage 后)或切回 SCM tab 时顺带重拉 `SessionCurrentBranch`;当前打开会话
  时拉一次已修复空显示这一核心 bug,保持最小改动。
