package main

import (
	"context"
	"embed"
	"log"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/jessonchan/monkey-deck/internal/chat"
	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/ui"
	"github.com/jessonchan/monkey-deck/internal/update"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
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
	_ = cfg.EnsureDir()

	// 诊断日志落盘:GUI 应用 stderr 默认 → /dev/null,曾导致 session 卡死等关键 slog
	// (chat idle/absolute timeout、prompt failed、session live、harness started)全部丢失、
	// 无法事后诊断(§5.4 #16)。重定向 slog 与标准 log 到 DataDir 下的 monkey-deck.log(append);
	// 打开失败则退回默认(stderr)。LevelInfo 足以覆盖 Warn/Error/Info 级关键诊断。
	if logFile, logErr := os.OpenFile(filepath.Join(cfg.DataDir, "monkey-deck.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); logErr == nil {
		slog.SetDefault(slog.New(slog.NewTextHandler(logFile, &slog.HandlerOptions{Level: slog.LevelInfo})))
		log.SetOutput(logFile)
	} else {
		slog.Warn("open log file failed; logs go to stderr", "err", logErr)
	}

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

	// 应用自更新(AGENTS.md §0.5 之外的桌面能力,与 ACP 无关):
	// GitHub Releases 源 + 内置更新窗口 + 发布版后台静默检查。
	// 配置失败不致命:仅禁用更新菜单与后台检查,应用照常运行。
	updaterReady := false
	if err := update.Init(app, currentVersion); err != nil {
		log.Printf("update: init failed (updates disabled): %v", err)
	} else {
		updaterReady = true
		update.StartBackgroundChecks(context.Background(), app, currentVersion)
	}

	// 应用菜单:基于默认菜单(保留编辑菜单 剪切/复制/粘贴 —— webview 文本输入必需),
	// 在 App 子菜单里加「检查更新…」。非 macOS 平台若无 AppMenu 角色则跳过。
	menu := application.DefaultApplicationMenu()
	if updaterReady {
		if item := menu.FindByRole(application.AppMenu); item != nil {
			if sub := item.GetSubmenu(); sub != nil {
				sub.AddSeparator()
				sub.Add("检查更新…").OnClick(func(*application.Context) {
					// CheckAndInstall 阻塞至流程结束,放 goroutine 不卡 UI 线程。
					go func() {
						if err := app.Updater.CheckAndInstall(context.Background()); err != nil {
							if app.Logger != nil {
								app.Logger.Error("update", "error", err)
							}
						}
					}()
				})
			}
		}
	}
	app.Menu.SetApplicationMenu(menu)

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
