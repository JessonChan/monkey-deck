package main

import (
	"embed"
	"log"
	"path/filepath"

	"github.com/jessonchan/monkey-deck/internal/chat"
	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/ui"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	cfg := config.Default()
	_ = cfg.EnsureDir()

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

	// 窗口状态记忆:记住上次的尺寸/位置/是否最大化(ui_state.json,AGENTS.md §0.5)。
	statePath := filepath.Join(cfg.DataDir, "ui_state.json")
	saved, err := ui.LoadWindow(statePath)
	if err != nil {
		log.Printf("ui: load window state: %v", err)
	}
	width, height := 1280, 840
	if saved.Width >= ui.MinWidth && saved.Height >= ui.MinHeight {
		width, height = saved.Width, saved.Height
	}
	opts := application.WebviewWindowOptions{
		Title:  "Monkey Deck",
		Width:  width,
		Height: height,
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			Backdrop:                application.MacBackdropNormal, // 改为不透明，减少动画闪烁
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(35, 35, 35),
		URL:              "/",
	}
	// 有记录且非最大化:恢复到上次位置;首次启动(无记录)由系统居中。
	// 校验位置仍在某块屏幕内,否则跳过恢复(防止外接显示器拔除后窗口落到屏幕外)。
	if saved.Width >= ui.MinWidth && saved.Height >= ui.MinHeight && !saved.Maximized {
		rect := ui.Bounds{X: saved.X, Y: saved.Y, Width: saved.Width, Height: saved.Height}
		var workAreas []ui.Bounds
		for _, s := range app.Screen.GetAll() {
			workAreas = append(workAreas, ui.Bounds{X: s.WorkArea.X, Y: s.WorkArea.Y, Width: s.WorkArea.Width, Height: s.WorkArea.Height})
		}
		if ui.VisibleOn(workAreas, rect) {
			opts.InitialPosition = application.WindowXY
			opts.X, opts.Y = saved.X, saved.Y
		}
	}
	// 上次最大化:最大化打开(最大化时让系统居中逻辑接管,避免 maximise 后再 setPosition 干扰)。
	if saved.Maximized {
		opts.StartState = application.WindowStateMaximised
	}

	win := app.Window.NewWithOptions(opts)

	// 跟踪窗口运行时状态:仅记录「非最大化」时的正常几何,
	// 否则最大化尺寸会被当成默认尺寸存下来。
	cur := saved
	win.OnWindowEvent(events.Common.WindowDidResize, func(event *application.WindowEvent) {
		if cur.Maximized {
			return
		}
		cur.Width, cur.Height = win.Size()
	})
	win.OnWindowEvent(events.Common.WindowDidMove, func(event *application.WindowEvent) {
		if cur.Maximized {
			return
		}
		cur.X, cur.Y = win.Position()
	})
	win.OnWindowEvent(events.Common.WindowMaximise, func(event *application.WindowEvent) {
		cur.Maximized = true
	})
	win.OnWindowEvent(events.Common.WindowUnMaximise, func(event *application.WindowEvent) {
		cur.Maximized = false
		// 显式捕获还原后的几何,不依赖「UnMaximise 之后必跟 WindowDidResize」的顺序。
		cur.Width, cur.Height = win.Size()
		cur.X, cur.Y = win.Position()
	})
	win.OnWindowEvent(events.Common.WindowClosing, func(event *application.WindowEvent) {
		if err := ui.SaveWindow(statePath, cur); err != nil {
			log.Printf("ui: save window state: %v", err)
		}
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
