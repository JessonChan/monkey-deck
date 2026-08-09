# 2026-08-10 拖拽文件到聊天区:drop zone 高亮 + 分流(内部 @mention/图片、外部附件)

Task #24255(issue #83)。

## 起因

把 OS 文件管理器里的文件拖到聊天区,期望:
- 拖动中:聊天区高亮(drop zone 反馈)。
- 松手后按文件位置**分流**:
  - worktree 内的非图片文件 → `@mention`(相对 cwd,agent 自己读)。
  - worktree 内的 ACP 图片(png/jpg/jpeg/webp/gif)+ agent 支持 image → 内联图片附件。
  - worktree 内但 agent 不支持 image / 图片读失败 / 非 ACP 图片(bmp/svg/ico)→ 退化为 `@mention`(不丢文件)。
  - worktree 外的文件 → 回形针附件(绝对路径,与 `PickFiles` 一致)。

## 根因 / 协议调研(Wails3 文件拖拽机制)

Wails3 webview 里浏览器的 HTML5 `DataTransfer` 只给 content-bearing `File` 对象、**没有可用绝对路径**——无法据路径判「在不在 worktree」。必须走 Wails3 的**原生拖拽通道**:

- 窗口选项 `EnableFileDrop: true`(`WebviewWindowOptions.EnableFileDrop`)。
- DOM 上挂 `data-file-drop-target` 的元素才是合法 drop 目标:Wails runtime 在原生拖拽层(macOS `WebviewDrag` NSView / Windows WebView2)`draggingEntered/Updated` 时用 `elementFromPoint + closest([data-file-drop-target])` 找到目标元素,并**直接给它加 `file-drop-target-active` class**;`performDragOperation` 时把**绝对路径数组**经 `InitiateFrontendDropProcessing → handlePlatformFileDrop` 推回去,最终触发后端 `events.Common.WindowFilesDropped` 事件(`event.Context().DroppedFiles()` = 绝对路径,`DropTargetDetails().Attributes` = 目标元素的全部 DOM 属性)。

关键点:
1. **macOS 上 HTML5 `dragenter/over/leave` 不会可靠到达 webview**(原生 overlay 截走了),所以 drop zone 高亮**不能**用 React 自己的 drag handler 驱动——得镜像 Wails 自己管的 `file-drop-target-active` class。
2. 目标元素的所有属性都被回传,于是把 `data-md-session=<sid>` 挂在 drop 目标上,后端就能把「落在哪个 session」一并回传,前端不必按窗口焦点猜。
3. React 不会覆盖 Wails 加的 class:`className="chat-view"` 是常量 prop,reconciler 不会重写,故跨重渲染安全。

## 改法

**后端(只转发,不路由)**:routing 全在前端(它才持有 per-session cwd / imageSupport)。
- `internal/chat/drop.go`(新):事件常量 `chat:files-dropped` + payload + `RegisterFilesDroppedEmitter(win)`——给窗口挂 `WindowFilesDropped` handler,把 `DroppedFiles()` + 目标元素的 `data-md-session` 属性 emit 给前端。
- `desktop.go`(主窗口):`EnableFileDrop: true` + `chat.RegisterFilesDroppedEmitter(win)`。
- `internal/chat/window.go`(popout 窗口):同上(与主窗口对齐,popout 也支持拖拽)。

**前端路由(纯函数,可测)**:`frontend/src/lib/dropFiles.ts`
- `relativeToRoot(root, abs)`:判 abs 是否在 root 内(整段前缀匹配,拒绝 `../` 逃逸;大小写不敏感容忍 Windows 盘符 / HFS+;分隔符归一)。返回 `null`=外部、`""`=root 本身、`<rel>`=相对路径。
- `routeDroppedFiles(files, opts, readImage)`:逐文件分流为 mentions / attachments / images。`readImage` 注入(生产= `ChatService.SessionReadImage`,测试=mock),保持纯函数可测。图片读失败/不支持/非 ACP 图片 → 退化为 @mention(best-effort,绝不静默丢文件)。root 本身被拖 → 跳过(不出无意义的 `@.`)。

**前端接入**:
- `ChatView.tsx`:`.chat-view` 挂 `data-file-drop-target` + `data-md-session={sessionId}`;`MutationObserver` 镜像 `file-drop-target-active` class → `dropActive` state → 渲染 `.chat-drop-overlay`(dashed card + 文案,test 环境无 `MutationObserver` 时 guard 跳过)。
- `App.tsx`:启动 effect 订阅 `chat:files-dropped`,查 session+project 算 cwd(`worktreePath || project.path`,对齐后端 `cwdOf`),按 `routeDroppedFiles` 结果更新 per-session 的 mentions/draft/attachments/images。窗口作用域:popout 只处理自己的 session,主窗口跳过已 popout 的 session(避免双窗口重复处理)。
- `index.css`:`.chat-view` 加 `position: relative`(给 absolute overlay 做包含块)+ `.chat-drop-overlay/.chat-drop-card` 样式(非交互 `pointer-events:none`)。
- i18n:`chat.dropTitle` / `chat.dropHint`(en + zh)。

## 改了哪些文件

- 新:`internal/chat/drop.go`
- 新:`frontend/src/lib/dropFiles.ts`
- 新:`frontend/src/lib/dropFiles.test.ts`(16 用例:相对路径边界 + 三路分流 + 退化 + 混合批)
- 改:`desktop.go`(EnableFileDrop + Register)
- 改:`internal/chat/window.go`(popout 同上)
- 改:`frontend/src/components/ChatView.tsx`(drop 目标属性 + MutationObserver 高亮 + overlay)
- 改:`frontend/src/App.tsx`(事件订阅 + 路由 + 应用 state)
- 改:`frontend/src/index.css`(overlay 样式 + `.chat-view` relative)
- 改:`frontend/src/i18n/locales/{en,zh}.json`(dropTitle/dropHint)

## 验证

- 后端:`go vet ./...` 通过(临时占位 `frontend/dist` 满足 embed;bindings/dist 均为 gitignored 中间产物)。
- 前端类型/构建:`tsc` 0 错;`bun run build`(tsc + vite build)成功(仅 chunk>500kB 既有警告)。
- 前端单测:`bun test src/lib/dropFiles.test.ts` → 16/16 pass。
- 回归:`bun test` 全量 184 pass / 31 fail / 9 errors —— 与改前**完全一致**(31 fails 均为既有失败:mermaid / harness 升级开关 / queue countdown / new-session-modal / msg-meta duration,与本改动无关)。注:`bun test`(默认)不发现 `src/lib/` 下测试,既有 lib 测试同此状况(需显式 `bun test src/lib/`)。
- i18n parity:`src/i18n/locales.test.ts` 2/2 pass。

## 下一步 / OPEN

- 未在真机 macOS WebKit + Windows WebView2 实测拖拽(本环境无 GUI)。形态与 Wails3 官方 `examples/drag-n-drop` 一致,但跨平台差异(§4.6)仍需桌面实测确认高亮 / 分流。
- server 模式无窗口,拖拽不可用(预期,§5.5)。
- 拖到非聊天区(侧栏 / 设置)无 drop 目标 → 静默无操作(符合「只聊天区接 drop」)。
- 路径含空格 / CJK 的 @mention 仍受 `detectMention` 按空白切分的既有约束(本任务不解决;分流本身不受影响,mentions 数组照常发出 ResourceLink)。
