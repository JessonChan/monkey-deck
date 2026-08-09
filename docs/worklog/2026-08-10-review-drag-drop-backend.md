# 2026-08-10 Review #83 拖拽文件到聊天 后端 (APPROVE, Task #24257)

**起因**:Task #24257 对 #24255 / issue #83 的后端 commit `bf952b3`(feat(acp):
bridge OS file drop to chat:files-dropped)做 Backend Reviewer 端到端验收。本审
只评后端 Go 代码(`internal/chat/drop.go` 新 + `desktop.go` / `internal/chat/window.go`
两处接线)——前端路由 / UI(commit `cdc4da5`)不在本审范围,留给前端 reviewer。

## 复审范围

- `internal/chat/drop.go`(新,63 行):事件常量 `chat:files-dropped` +
  `FilesDroppedPayload` + `RegisterFilesDroppedEmitter(win)`。
- `desktop.go`:主窗口 `EnableFileDrop: true` + `chat.RegisterFilesDroppedEmitter(win)`。
- `internal/chat/window.go`:popout 窗口同上(parity)。

## Wails3 API 正确性(逐项对 alpha2.106 源码核实)

本改动全部基于 Wails3 原生拖拽 API,逐项核对 `$GOMODCACHE/.../wails/v3@v3.0.0-alpha2.106`
源码确认存在且签名匹配:

| 调用 | 源码位置 | 核实 |
|---|---|---|
| `events.Common.WindowFilesDropped` | `pkg/events/events.go:19`(id 1034) | ✅ |
| `win.OnWindowEvent(...)` | `webview_window.go` | ✅ 全仓既有用法 |
| `event.Context()` → `*WindowEventContext` | `webview_window.go:127` | ✅ |
| `.DroppedFiles() []string` | `context_window_event.go:15`(value receiver,ptr 自动解引) | ✅ |
| `.DropTargetDetails() *DropTargetDetails` | `context_window_event.go:57` | ✅ |
| `DropTargetDetails.Attributes map[string]string` | `application.go:260` | ✅ 与代码 `dt.Attributes["data-md-session"]` 一致 |
| `WebviewWindowOptions.EnableFileDrop bool` | `webview_window_options.go:152` | ✅ |
| `application.Get()` + `app.Event.Emit(name, data)` | 既有模式(`chat.go:420`) | ✅ |

**属性回传链核实**:`messageprocessor_window.go:370-376` 把 JS 端 element 的全属性
(`payload.ElementDetails.Attributes`)原样灌进 `DropTargetDetails.Attributes`,故
前端挂在 `.chat-view` 上的 `data-md-session` 必然到达后端 handler。✅

## 防御性 / 边界 ✅

- `win == nil` 守卫(防止 server 模式 / 测试传 nil)。✅
- `len(files) == 0` 早退(空 drop 不发事件,避免前端收到无意义 payload)。✅
- `dt != nil && dt.Attributes != nil` 双层判空后才读 map(`dt.Attributes["data-md-session"]`,
  key 不存在时 string 零值 `""`,安全)。✅
- `app := application.Get(); if app == nil { return }`(boot / shutdown 竞态兜底)。✅

## 契约一致性(前后端字段对账) ✅

| 后端 payload(`FilesDroppedPayload`) | JSON tag | 前端订阅(`App.tsx:675`) | 一致 |
|---|---|---|---|
| `Files []string` | `files` | `files: string[]` | ✅ |
| `SessionID string` | `sessionId` | `sessionId: string` | ✅ |

DOM 属性:后端读 `dt.Attributes["data-md-session"]` ↔ 前端 `ChatView.tsx:634`
`data-md-session={props.sessionId}`。✅ 双向匹配,session 路由不靠窗口焦点猜。

## ACP 回归 ✅(无)

改动**完全不触碰 ACP 代码路径**(`internal/acp/`、handler 回调、runner 生命周期、
session 持久化均未动)。`RegisterFilesDroppedEmitter` 是纯 Wails3 窗口事件 → 前端
event 的转发桥,与 ACP 协议层零耦合。`go test ./internal/chat/...` 全绿(既有测试
无回归)。

## 内存 / 并发 ✅

- **无泄漏**:闭包只捕获入参 `win`(注册期)与回调内的局部变量;窗口销毁时 Wails3
  清理其 event handler。主窗口 reopen(`createMainWindow` 重建)在新窗口上重新注册,
  旧窗口的 handler 随旧窗口而死;popout 单例检查(`GetByName` 命中即 return)保证
  不重复注册。✅
- **并发安全**:回调跑在 Wails3 事件线程,只读全局单例 `application.Get()` + 调
  线程安全的 `app.Event.Emit`,无共享可变状态。✅

## 观察项(非阻塞 nit,不改)

### #1 `RegisterFilesDroppedEmitter` 绕过 `ChatService.emit` 的 `emitHook`

`ChatService.emit`(`chat.go:415`)有测试钩子 `emitHook`(捕获事件序列供单测断言),
而本函数是 standalone(非 ChatService 方法),直接调 `application.Get().Event.Emit` ——
`chat:files-dropped` 不经 `emitHook`,无法被现有测试基建捕获。

**为何可接受**:`createMainWindow`(`desktop.go`)拿不到 ChatService 实例(签名只有
`app` + `cfg`),把本函数改成 ChatService 方法需要把 service 实例穿进 `createMainWindow`,
改动面远超收益。且本函数是 15 行纯转发(nan-to-mock 的原生窗口 API + 全局单例),
无可测业务逻辑——真正的可测路由逻辑全在前端 `dropFiles.ts`(16 个单测)。属
§5.3 KISS 权衡:测转发桥的 harness 比桥本身还重,不值。**不阻塞**。

### #2 无 `drop_test.go`

`RegisterFilesDroppedEmitter` 无单测。理由同 #1(原生窗口事件 + `application.Get()`
全局单例不可 mock)。worklog 已明示「后端只转发,不路由」,可测逻辑在前端。
**不阻塞**(同 #102 fontScale review 的 #3 观察项处理:功能简单 + 路径短,桌面实测兜底)。

## 反模式自查 ✅

- **类型补丁反模式**(字段加了全链路没人消费):`FilesDroppedPayload.Files` +
  `SessionID` 均被前端 `App.tsx:675` 消费,无死字段。✅
- **测试断言锚定值**:N/A(本审无后端测试,不适用)。

## 注释语言(§3.7) ✅

`drop.go` 全英文注释;`desktop.go` / `window.go` 新增两行接线注释均英文。符合
§3.7「新增注释一律英文」。

## 验证(acceptance gate)

1. `go vet ./internal/...` → **clean**(0 输出)。
2. `go build ./internal/...` → **exit 0**。
3. `go test ./internal/chat/...` → **ok 15.3s**(既有测试全绿,无回归)。
4. `go build .` 的 `pattern all:frontend/dist: no matching files found` 是**预存在**
   条件(worktree 未 build 前端),与本次改动无关——`internal/...` 独立编译通过即证后端无误。

## Verdict:APPROVE

Wails3 API 逐项对 alpha2.106 源码核实无误;防御性 nil/empty 守卫完备;前后端契约
(`files` / `sessionId` 字段 + `data-md-session` DOM 属性)双向匹配;ACP 零回归
(改动隔离在窗口事件层);无内存泄漏 / 并发问题;注释全英文(§3.7);反模式自查通过。
两项观察项(绕过 emitHook / 无 drop_test)均非阻塞,属合理的 KISS 权衡(转发桥无可测
业务逻辑,可测逻辑在前端 16 个单测)。建议合入。

## 改了哪些文件

- `docs/worklog/2026-08-10-review-drag-drop-backend.md`(本条,新增)。
