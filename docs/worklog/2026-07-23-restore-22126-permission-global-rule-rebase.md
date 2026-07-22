# 2026-07-23 恢复 #22126 后端 global 权限分支:rebase onto main + 重跑 gate + 重合并

## 起因
Task #22128。#22126「后端 onRespond("global") 转全局 PermissionRule(准确匹配)」原本落在
失败分支 `agent/coder/127c5c1a-failed`(4 个 commit,基点 `9cf0f16`):

- `2f0c1c6` feat(permissions): ExactMatchRule 准确匹配 allow 规则
- `b7546e0` feat(acp): onRespond("global") 经 OnGlobalRule 固化全局 allow 规则
- `319b159` feat(chat): 注册 OnGlobalRule 持久化全局权限规则
- `4e0b5d2` docs(worklog): onRespond("global") 转全局 PermissionRule

期间 `main` 前进了 2 个 commit(#22127 前端「PermissionCard 加「全局允许」按钮」feat `cfc7382` +
docs `afb8190`)。本任务把 #22126 的 4 个 commit **rebase 到最新 main(`afb8190`)**,重跑 gate,
重新合并为线性历史。

## rebase 结果:零冲突,语义链自洽

4 个 commit **直接 cherry-pick 零文本冲突**:#22126 碰的全是 Go 后端文件
(`internal/permissions/*.go` / `internal/acp/handler*.go` / `internal/chat/chat.go`),
与 #22127 碰的前端文件(`ChatView.tsx` / i18n locales)**完全不相交**。

**但这是「前端按钮 + 后端落库」的配套任务**,rebase 后必须确认语义链首尾相接(否则会出现
「按钮发了 "global" 但后端不认」的断链):

```
PermissionCard perm-global 按钮 (#22127)
  → onRespond("global")
  → ChatService.RespondPermission(sessionId, reqId, "global")   (App.tsx:767)
  → handler.RespondPermission(reqId, "global")                   (chat.go:1902)
  → RequestPermission 回调:level=="global"
       ├─ applyDecision("global") → 写满 session/project 内存记忆(本 session 即时放行)
       └─ emitGlobalRule(req) → OnGlobalRule(ExactMatchRule(req))   (handler.go:376-380)
            → persistGlobalPermissionRule → CreatePermissionRule(入库 + applyPermissionRulesToAll)   (chat.go:1078)
```
逐段 grep 核对全链都在,且 #22127 的 `perm-global` 按钮(`ChatView.tsx:1309`)发出的正是
`onRespond("global")`。**无断链、无语义冲突**,rebase 后直接可用。

## 改了哪些文件
- 仅本条 worklog(4 个功能/文档 commit 已由 cherry-pick 原样落地,见下「提交形态」)。

## 提交形态
cherry-pick 保留原 4 个原子 commit(3 feat + 1 docs),新 SHA:
- `41d2876` feat(permissions)
- `ab362dd` feat(acp)
- `3b54d32` feat(chat)
- `3eac4e2` docs(worklog #22126)
- 本条 = docs(worklog #22128 restore)

## 验证(gate 全绿)
- `make bindings`(`wails3 generate bindings`,**不带 `-d`**)成功:2 Services / **67 methods** /
  10 Models,输出到 `frontend/bindings`(正确路径,前端 import 期望处)。
- 前端:`bun install` + `bun run build`(tsc + vite production)通过,仅有既有的
  chunk-size > 500kB 警告(非错误)。bindings/dist/node_modules 不入库。
- `go build ./...` ✅(仅 macOS linker 版本警告,非错误)。
- `go vet ./...` ✅(干净)。
- `go test ./...` ✅(全包绿:acp / chat / config / fsview / harness / permissions / store /
  terminal / titlegen / ui / update / worktree —— 含 #22126 新增的 permissions / acp global 测试)。
  > 对比:#22126 原 worklog 记 `internal/chat` 3 个预存在失败;当前 main 已绿,无需特判。

## 踩坑(已恢复,警示后人)
**`wails3 generate bindings -d .` 会清空目标目录!** 一次误用 `-d .`(输出目录=worktree 根)
把整个 worktree 工作树(含 `.git` 指针文件)清空,只剩生成的 `github.com/` bindings 目录。

- **根因**:wails3 generate bindings 在生成前会 **clean 目标 output dir**,`-d .` 即「清空当前目录」。
- **恢复**(`default.git` 是 bare 仓,commit 对象/refs 完好,仅工作树文件丢失):
  1. 重建 worktree 根的 `.git` 指针文件,内容为 `gitdir: <default.git 的绝对路径>/worktrees/worktree`
     (gitfile 格式**必须有 `gitdir: ` 前缀**,否则 `invalid gitfile format`)。
  2. `git checkout -f HEAD` 从 index 重放全部 tracked 文件。
  3. 删掉误生成的根级 `github.com/` 目录;`node_modules`/`dist`/`bindings` 属 untracked/ignored,
     重装/重生成即可。
- **教训(硬约束级)**:本项目 bindings 生成**只用 `make bindings`(等价 `wails3 generate bindings`,
  无参数,自动输出到 `frontend/bindings`)**,**严禁加 `-d`** 改输出目录。Makefile/Taskfile 已固定该命令。

## 下一步
- 实机验证(`wails3 dev`):点 PermissionCard「全局允许」→ 该工具+命令/路径以后所有 session
  自动放行(去设置面板可见生成的 allow 规则);重启 app 后仍生效(SQLite 持久化)。
- (沿用 #22126「下一步」)重复同标识请求多次点「全局允许」会产重复规则,如需可在
  `persistGlobalPermissionRule` 按 (tool/action/cmd/path) 去重(当前 KISS 不做)。
