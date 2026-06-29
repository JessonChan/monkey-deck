package main

import (
	"embed"
	"log"

	"github.com/jessonchan/monkey-deck/internal/chat"
	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	cfg := config.Default()

	// 单一 Go 进程:webview 宿主 + harness 子进程父 + ACP 连接持有 + SQLite 读写(§2.2)。
	chatSvc := chat.NewChatService(cfg)

	app := application.New(application.Options{
		Name:        "Monkey Deck",
		Description: "ACP 桌面客户端 —— 以项目/目录为单位管理编码 agent 的对话",
		Services: []application.Service{
			application.NewService(chatSvc),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:  "Monkey Deck",
		Width:  1280,
		Height: 840,
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			Backdrop:                application.MacBackdropNormal, // 改为不透明，减少动画闪烁
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(35, 35, 35),
		URL:              "/",
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
