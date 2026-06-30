# 2026-06-30 harness 收窄:移除 mimo/mino,omp 为默认,worktree 默认不建

## 起因

用户要求:移除全部 mino(及其变体 mimo)的 ACP 设置,只保留 opencode 与 omp;
omp 设为默认 harness;新建会话默认不建 worktree(直接用项目目录)。

此前 `internal/harness` 注册表列了三项 `{opencode, mimo, omp}`(代码用 `mimo`,
文档/注释混用 `mino`),默认 opencode;NewSessionModal 的 worktree 初值为 `true`。

## 改法

- **`internal/harness/harness.go`**:
  - `Supported` 只留 `{omp, opencode}`,**omp 置首项**(= 默认,前端 `harnesses[0]` 与
    `Command` 未知回退都自然落到 omp)。
  - `DefaultID` 由 `"opencode"` 改 `"omp"`。
  - `Command` 未知回退由 `Supported[0].Command` 改 `Command(DefaultID)`(顺序无关,
    显式走默认)。
  - **关键**:`IsOpenCode` 由 `Normalize(id) == DefaultID` 改为**显式判 `"opencode"`**。
    原写法与 DefaultID 耦合 —— 一旦把默认改成 omp,`IsOpenCode` 会误判 omp 为 opencode,
    进而在 `startLive` 给 omp 写 `opencode.json`(§3.5),属回归。现与默认 harness 解耦。
- **`internal/store/sessions.go`**:`CreateSession` 空 harness 兜底 `"opencode"` → `"omp"`
  (与默认对齐;该分支为防御,chat 层已 `harness.Normalize`)。
- **`internal/store/store.go`**:`Session.Harness` 注释 `opencode/mino/omp` → `omp/opencode`。
- **`internal/chat/chat.go`**:`CreateSession` 注释更新(omp/opencode,空=omp 默认)。
- **`internal/harness/harness_test.go`**:注册表数量 ≥2、期望 id `{omp, opencode}`、
  `Normalize`/`Command`(未知回退 `omp acp`)、`IsOpenCode`(`omp` 与空都不再是 opencode)
  全部重写;新增「Supported 首项 == DefaultID」不变量。
- **`frontend/src/components/NewSessionModal.tsx`**:
  - harness 默认 `harnesses[0]?.id || "omp"`(列表首项 = omp)。
  - **worktree 初值 `true` → `false`**(默认不建)。
  - 注释更新。
- **migration 0005**:不动。列默认 `'opencode'` 是历史记录(迁移已落盘到既有 DB,
  改了也不会重跑);应用层 `CreateSession` 始终显式传 harness,该列默认是死路径。
  真正的默认由 `harness.DefaultID` + UI 决定。

## 改了哪些文件

`internal/harness/{harness.go,harness_test.go}`、`internal/store/{store.go,sessions.go}`、
`internal/chat/chat.go`、`frontend/src/components/NewSessionModal.tsx`、
`frontend/bindings/.../harness/models.ts`(注释同步,bindings gitignored 自动重生成)、
`PROCESS.md`(§B)。

## 验证

- `go build . ./internal/...` ✅。
- `go test ./internal/harness/ ./internal/store/ ./internal/chat/` ✅(全绿,含重写的 harness 用例)。
- `go vet` 干净;`gofmt -l` 我改的文件干净(`queue_test.go` 的格式问题是既有、未触碰)。
- 前端 `bunx tsc --noEmit` ✅。
- **未做实机验证**(待 `wails3 dev`):弹窗默认选中 omp、worktree 默认未勾、
  选 opencode 仍写 opencode.json、选 omp 不写。

## 下一步 / 可改进

- 实机验证上述四点。
- omp 的 model 注入机制仍留空(`startLive` 非 opencode 时 model=""),走 omp 自身全局配置,
  作为后续 harness 适配项。
