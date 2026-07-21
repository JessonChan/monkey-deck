# 2026-07-22 恢复 #21317 自动重连分支:rebase onto main + 重跑 gate + 重合并

## 起因

Task #21319。#21317「harness 断连自动重连」原本落在失败分支
`agent/coder/a597fa0b-failed`(3 个 commit:`f562781` feat / `17d662e` test / `f9dcbb8` docs),
基点是 `ce3618f`。期间 `main` 前进了一个 commit(`935c76b`,补 i18n 回归测试复验 worklog),
原分支形态不再线性。本任务把 #21317 的 3 个 commit **rebase 到最新 main**,重跑 gate,
重新合并为 `main + 3` 的线性历史。

## 做了什么

- 当前 coder 分支 `agent/coder/4b287eb0` 起点即 `main`(`935c76b`),在此之上
  `git cherry-pick f562781 17d662e f9dcbb8`(等价 rebase)。
- **零冲突**:main 的新增 commit 只动 `docs/worklog/...review-...i18n-regression-test.md`,
  与 #21317 三 commit 触碰的文件(`internal/chat/chat.go`、`internal/chat/queue_test.go`、
  `internal/chat/reconnect_test.go`、`AGENTS.md`、`docs/worklog/2026-07-22-harness-auto-reconnect.md`、
  `frontend/src/i18n/locales/{zh,en}.json`)完全不相交。
- 三 commit 的内容/作者/语义原样保留,仅 parent 换成最新 main,无语义改动。

## 验证(gate 全绿)

- `go build ./...` ✅(仅 macOS SDK 版本号 `ld: warning`,非错误)。
- `go vet ./...` ✅(干净)。
- `go test ./...` ✅(全包绿,含 `internal/chat`)。
- `wails3 generate bindings` + 前端 `bun run build` ✅(bindings/dist 不入库;此处仅为补
  `frontend/dist` embed 让根包 `go build` 通过,并跑前端 gate)。
- #21317 reconnect 套件 `-race` 干净:
  `go test -race -run 'TestReconnect|TestStopSessionDoesNotReconnect|TestCloseSessionStopsReconnect|TestHealthWatcher|TestGiveUp|TestReconnectDedup' ./internal/chat/` ✅。

## 一个 -race 发现(预先存在,非本次回归)

- `go test -race -run TestRunPromptDisconnectEmitsCode ./internal/chat/` 报 DATA RACE:
  `error_code_test.go` 里测试主 goroutine 读 `lastPayload`(`waitErrorStatus`/断言)与
  emit 回调 goroutine 写 `lastPayload`(`emitHook`)无同步。
- **已验证为预先存在**:在 `main`(`935c76b`,无任何 #21317 改动)上用临时 worktree 跑同一
  用例,同样 `-race` FAIL(同样两处 DATA RACE)。该测试文件未被 #21317 触碰;其 exercise 的
  `runPrompt → emitError → emitHook` 路径的 emit 行为,#21317 未改变(`startReconnect` 在
  `reconnectEnabled=false` 时 no-op,既有 disconnect 单测不经 `ServiceStartup`)。
- 处理:**不在本任务修复**(超出 #21319 范围;且 #21317 worklog 原本只声明 reconnect 子集
  `-race` 干净,未含此 disconnect 用例)。记成 OPEN,后续单独修 `error_code_test.go` 的
  `lastPayload` 同步(用 mutex/atomic 或 channel 串行化 emitHook 读写)。

## 改了哪些文件

- 仅 git 历史(rebase),无文件内容改动:三 commit 原样落在 main 之上。
  - `1361a1e` feat(chat): 自动重连实现
  - `48afbb7` test(chat): 自动重连单测
  - `cb86a94` docs: AGENTS.md §3.3/§5.4#6 + #21317 worklog
- 本条 worklog(单独 docs commit)。

## 下一步 / OPEN

- **OPEN**:`error_code_test.go` 的 `lastPayload` 数据竞争(预先存在,与 #21317 无关),
  需单独修(给 emitHook 的读写加同步)。
- 实机验证仍未做(同 #21317 原结论):需 `wails3 dev` 人为 kill harness 查 `reconnect succeeded`/
  `reconnect exhausted` 日志。
