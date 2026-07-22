# 2026-07-23 恢复 #22108 ThoughtBlock 分支:rebase onto main + 重跑 gate + 重合并

## 起因

Task #22109。#22108「ThoughtBlock 展开内容限高滚动 + streaming 自动滚到底」原本落在失败分支
`agent/coder/c6c98323-failed`(2 个 commit:`ece1b81` feat / `5a4186c` docs),基点是 `4993548`。
期间 `main` 前进了一个 commit(`67919f3`,#22106 drainQueue per-session 验收 worklog),原分支
形态不再线性。本任务把 #22108 的 2 个 commit **rebase 到最新 main**,重跑 gate,重新合并为
`main + 2` 的线性历史。

## 做了什么

- 当前 coder 分支 `agent/coder/0ec81ae6` 起点即最新 main(`67919f3`),在此之上
  `git cherry-pick ece1b81 5a4186c`(等价 rebase)。
- **零冲突**:main 的新增 commit 只动 `docs/worklog/2026-07-23-review-drainqueue-per-session.md`,
  与 #22108 两 commit 触碰的文件(`frontend/src/components/ChatView.tsx`、`frontend/src/index.css`、
  `docs/worklog/2026-07-23-thought-block-scroll.md`)完全不相交。
- 两 commit 的内容/作者/语义原样保留,仅 parent 换成最新 main,无语义改动。`git range-diff`
  给出 `ece1b81 = 3aebd6c`(同一 patch,标识符相等),逐文件 `git diff` 为空,证字节级一致。

## 验证(gate 全绿)

- `go build ./...` ✅(仅 macOS SDK 版本号 `ld: warning`,非错误)。
- `go vet ./...` ✅(干净)。
- `go test ./...` ✅(全包绿:acp / chat / config / fsview / harness / permissions / store /
  terminal / titlegen / ui / update / worktree)。
- 前端:`wails3 generate bindings` + `bun install` + `bun run build`(tsc + vite production)
  ✅(仅有 chunk-size > 500kB 的既有提示,非错误)。bindings/dist 不入库(已 `git check-ignore`
  确认 `frontend/bindings`、`frontend/dist` 均被忽略)。

## 改了哪些文件

- 仅 git 历史(rebase),无文件内容改动:两 commit 原样落在 main 之上。
  - `3aebd6c` feat(chat): ThoughtBlock 展开内容限高滚动 + streaming 自动滚到底
  - `ad090fb` docs(worklog): ThoughtBlock 限高滚动 + streaming 贴底(Task #22108)
- 本条 worklog(单独 docs commit)。

## 下一步

- #22108 的实机验证仍未做:需 `wails3 dev` 起一轮带长思考块的对话,确认展开内容在 360px 限高容器内
  自滚动、streaming 时贴底跟随,且不撑开外部对话列表(虚拟化路径下尤其要看 `.thought-text` 的
  `max-height` 与 `contain` 是否叠加良好)。
