//go:build server

// server.go:server 模式(-tags server)下的 runDesktop no-op。
// server 模式不起 GUI:不装菜单、不开窗口、不起应用更新。app.Run() 直接起 HTTP 服务
// (默认 :8080,WAILS_SERVER_PORT 可配),对外同时 serve 前端 embed 资源 + /wails/runtime
// binding 端点。浏览器直连即可拿到真后端 + 真数据,做无 GUI 集成测试(AGENTS.md §5.5)。
package main

import (
	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// runDesktop 在 server 模式下无 GUI 可装(no-op)。菜单/窗口/更新均跳过。
func runDesktop(app *application.App, cfg *config.Config) {
	// 故意留空:server 模式不创建任何窗口或菜单。
	_ = app
	_ = cfg
}
