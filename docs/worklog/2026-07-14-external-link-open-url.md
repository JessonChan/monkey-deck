# 2026-07-14 对话外链用系统浏览器打开(重做)

## 起因

Task #15668:对话 markdown 里的外链(如 `[文档](https://...)`)点击后默认会在 Wails3
内嵌 webview 里试图导航,而非打开系统默认浏览器。这是原始 #2 commit(已丢失)的功能,
重做一遍。需求:仅处理 http/https 外链,mailto/tel/内部锚点放行默认行为。

## 设计

**后端最小一个导出方法 + 前端一个 a 标签覆写**(AGENTS.md §0.5 Wails3 binding 纪律 +
§5.3 KISS / Less is More):

1. **后端 `ChatService.OpenURL(url string) error`**:调 Wails3 `application.Get().Browser.OpenURL`
   (底层 = `github.com/pkg/browser` 的跨平台 `open` / `xdg-open` / `explorer`)。`ChatService`
   已在 `main.go` 经 `application.NewService(chatSvc)` 注册到 application 绑定 —— 新增的
   **导出方法自动暴露给前端**,无需改 `main.go`。与既有 `PickDirectory` / `RevealPath` 同处
   `internal/chat/dialog.go`(都是「系统对话框/外部打开」类能力,放一起)。
2. **前端 `AnchorRenderer`**:`ReactMarkdown` 的 `components.a` 覆写。`onClick` 判定
   `href` 是否匹配 `^https?:\/\//i` —— 是则 `preventDefault` + 调 `ChatService.OpenURL`;
   mailto/tel/相对路径/锚点(`#xxx`)/ 没协议的 href 一律放行默认行为。修饰键(Cmd/Ctrl/Shift/Alt)
   与非左键点击也放行(尊重用户「想在新 webview tab / 复制链接」等意图,不抢)。
   `target="_blank" rel="noopener noreferrer"` 作为兜底(虽然 http/https 已被拦截,但语义正确)。

## 改了哪些文件

- `internal/chat/dialog.go`:新增 `OpenURL` 方法(4 行有效代码)。
- `frontend/src/components/ChatView.tsx`:`AgentMarkdown` 的 `components` 加 `a: AnchorRenderer`,
  新增 `AnchorRenderer` 函数组件。

## 验证

- `wails3 generate bindings`:64 Methods(含新增 `OpenURL`)。
- `wails3 task build`:完整 acceptance gate 通过(`tsc` 零 TS 错误 + `vite build` +
  Go production build,`frontend/dist` stub 由 build task 自动产出)。
- `go build ./...` / `go vet ./...` / `go test ./...`:clean(仅无关 macOS SDK 链接器 warning)。

## 下一步

- 若未来引入其它 markdown 渲染入口(如文档/设置页),复用 `AnchorRenderer` 或抽到共享模块。
  当前仅对话 `AgentMarkdown` 需要,不提前抽。
