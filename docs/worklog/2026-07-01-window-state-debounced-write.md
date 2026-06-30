# 2026-07-01 修复窗口状态记忆:关闭事件不触发 → 改防抖写盘

## 起因
窗口尺寸/位置/最大化记忆功能(ae8abd5、15ad6dd,已合入 main)实机不生效:每次启动都是默认尺寸 1280×840。

## 根因(代码 + 平台行为核查)
- 诊断:数据目录 `~/Library/Application Support/monkey-deck/` 下 **`ui_state.json` 从未生成**,`monkey-deck.log` 里也搜不到任何 `ui:` 存盘日志 → `SaveWindow` 从未执行 → `Common.WindowClosing` 事件从未触发。
- 平台行为核查(`wails/v3@alpha2.106/pkg/application/webview_window_darwin.m`):
  - `windowShouldClose:`(`webview_window_darwin.m:306`)→ 发 `EventWindowShouldClose` → 映射 `Common.WindowClosing`。它**只在用户点红绿灯关闭按钮 / Cmd+W 时触发**。
  - **macOS Cmd+Q 终止不走 `windowShouldClose:`**,直接进 `applicationWillTerminate` 收尾 → `Common.WindowClosing` 不触发 → 原实现「仅在 WindowClosing 落盘」彻底失效。
  - `windowWillClose:`(`webview_window_darwin.m:638`)→ `Mac.WindowWillClose`(1175,未映射到 Common),窗口销毁时触发,更接近真正关闭,但终止时是否触发不保证。
- 结论:**不能只靠「关闭时存盘」**,必须让磁盘状态在运行时就保持新鲜。

## 改法
`main.go` 窗口事件块重写为「**变更即防抖写盘**」:
- resize / move / WindowMaximise / WindowUnMaximise 每次变更后,用 `time.AfterFunc(400ms)` 重排一次防抖写盘(连续拖拽/缩放被折叠成一次写)。
- 磁盘状态始终新鲜:崩溃 / 强退 / Cmd+Q 都只丢 ≤400ms 的防抖窗口期。
- 关闭时 `Mac.WindowWillClose` 取消未触发的防抖、立即写一次(比 `windowShouldClose` 更接近真正销毁);即便它不触发,防抖写盘已保底。
- 引入 `sync.Mutex`(`stateMu`)保护 `cur`:定时器回调在独立 goroutine 读快照、与主线程事件写并发,加锁消除数据竞争(顺带解决上一轮 OCR 审查 #5 提的 `cur` 无锁问题)。
- 删除原 `Common.WindowClosing` 落盘分支(被防抖写盘 + WindowWillClose 取代)。

## 改了哪些文件
- `main.go`(import +sync/+time;窗口事件块重写为防抖写盘)。

## 验证
- `go build -o /tmp/md-test .` exit=0(ld warning 为 macOS SDK 版本警告,无关)。
- `go vet ./internal/...` 干净;`gofmt -l main.go` 干净。
- **待实机验证**(`wails3 dev`):缩放/移动窗口 → 等 ≥400ms → Cmd+Q → 重开恢复上次尺寸;最大化后重开最大化;观察 `ui_state.json` 已生成且内容正确。

## 下一步
- 实机验证后若仍异常,看 `<DataDir>/monkey-deck.log` 里 `ui: save window state` 报错与 `ui_state.json` 内容进一步定位。
- 防抖 400ms 可调;如嫌拖拽时仍有不必要写,可加大窗口。
