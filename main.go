package main

import (
	"embed"
	"log"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/jessonchan/monkey-deck/internal/chat"
	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/terminal"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// currentVersion 是当前应用版本。发布构建时由 -ldflags 注入
// (见 build/darwin/Taskfile.yml 的 VERSION,源自 `git describe --tags`)。
// 默认 "dev" = 开发构建,会禁用后台自动检查(见 update.ShouldAutoCheck)。
// 格式无前导 v,与 release tag 去掉 v 后一致(如 "0.1.0" ↔ tag "v0.1.0")。
var currentVersion = "dev"

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	cfg := config.Default()
	if err := cfg.EnsureDir(); err != nil {
		// 目录创建失败不致命:继续启动,后续 store/log 打开会自行报错。
		slog.Warn("ensure data dirs failed", "err", err)
	}

	// 诊断日志落盘:GUI 应用 stderr 默认 → /dev/null,曾导致 session 卡死等关键 slog
	// (chat idle/absolute timeout、prompt failed、session live、harness started)全部丢失、
	// 无法事后诊断(§5.4 #16)。重定向 slog 与标准 log 到 LogsDir 下的 monkey-deck.log(append);
	// 打开失败则退回默认(stderr)。LevelInfo 足以覆盖 Warn/Error/Info 级关键诊断。
	if logFile, logErr := os.OpenFile(filepath.Join(cfg.LogsDir, config.AppSlug+".log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); logErr == nil {
		slog.SetDefault(slog.New(slog.NewTextHandler(logFile, &slog.HandlerOptions{Level: slog.LevelInfo})))
		log.SetOutput(logFile)
	} else {
		slog.Warn("open log file failed; logs go to stderr", "err", logErr)
	}

	// 单一 Go 进程:webview 宿主 + harness 子进程父 + ACP 连接持有 + SQLite 读写(§2.2)。
	chatSvc := chat.NewChatService(cfg)
	termSvc := terminal.NewTerminalService()

	app := application.New(application.Options{
		Name:        config.AppName,
		Description: "ACP 桌面客户端 —— 以项目/目录为单位管理编码 agent 的对话",
		Services: []application.Service{
			application.NewService(chatSvc),
			application.NewService(termSvc),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	// 桌面 GUI 装配(应用更新 / 菜单 / 主窗口 + 状态记忆):desktop 构建里见 desktop.go,
	// server 模式(-tags server)下走 server.go 的 no-op —— 后者 app.Run() 直接起 HTTP 服务
	// (默认 :8080,WAILS_SERVER_PORT 可配),供浏览器无 GUI 驱动真后端 + 真数据做集成测试
	// (AGENTS.md §5.5)。
	runDesktop(app, cfg)

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
