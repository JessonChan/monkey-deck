//go:build !server

// desktop.go:桌面 GUI 装配(应用更新 + 菜单 + 主窗口 + 窗口状态记忆)。
// 仅 desktop 构建(不带 -tags server)编译;server 模式见 server.go 的 no-op 版本。
// 拆分目的:让 main.go 在 -tags server 下也能编译,启用 Wails3 server 模式做无 GUI
// 浏览器驱动集成测试(AGENTS.md §5.5)。GUI 专属符号(application.DefaultApplicationMenu /
// app.Window.NewWithOptions 等)只在非 server tag 下存在,故必须整块隔离。
package main

import (
	"context"
	"log"
	"path/filepath"
	"sync"
	"time"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/ui"
	"github.com/jessonchan/monkey-deck/internal/update"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// runDesktop 装配桌面专属能力:应用自更新、应用菜单、主窗口及其状态记忆。
// 仅 desktop 构建生效;server 模式(-tags server)走 server.go 的 no-op。
func runDesktop(app *application.App, cfg *config.Config) {
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
	statePath := filepath.Join(cfg.StateDir, "ui_state.json")
	saved, err := ui.LoadWindow(statePath)
	if err != nil {
		log.Printf("ui: load window state: %v", err)
	}
	width, height := 1280, 840
	if saved.Width >= ui.MinWidth && saved.Height >= ui.MinHeight {
		width, height = saved.Width, saved.Height
	}
	opts := application.WebviewWindowOptions{
		Title:  config.AppName,
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

	// 窗口状态跟踪 + 防抖落盘。
	// 关键:不能只靠「关闭时存盘」——macOS Cmd+Q 终止不触发 windowShouldClose
	// (即 Common.WindowClosing),会导致状态从不落盘(实测 ui_state.json 一直不存在,
	// 每次启动都是默认尺寸)。改为「变更即防抖写盘」:resize/move/最大化变更后 400ms
	// 落盘,磁盘状态始终新鲜,崩溃/强退/Cmd+Q 都只丢防抖窗口期。
	// stateMu 保护 cur(定时器回调在独立 goroutine 读快照,与主线程事件写并发)。
	var (
		stateMu sync.Mutex
		cur     = saved
		saveT   *time.Timer
	)
	// rescheduleSave 重排一次防抖写盘(调用方须持有 stateMu)。
	rescheduleSave := func() {
		snapshot := cur
		if saveT != nil {
			saveT.Stop()
		}
		saveT = time.AfterFunc(400*time.Millisecond, func() {
			if err := ui.SaveWindow(statePath, snapshot); err != nil {
				log.Printf("ui: save window state: %v", err)
			}
		})
	}

	// 仅记录「非最大化」时的正常几何,否则最大化尺寸会被当成默认尺寸存下来。
	win.OnWindowEvent(events.Common.WindowDidResize, func(event *application.WindowEvent) {
		stateMu.Lock()
		defer stateMu.Unlock()
		if cur.Maximized {
			return
		}
		cur.Width, cur.Height = win.Size()
		rescheduleSave()
	})
	win.OnWindowEvent(events.Common.WindowDidMove, func(event *application.WindowEvent) {
		stateMu.Lock()
		defer stateMu.Unlock()
		if cur.Maximized {
			return
		}
		cur.X, cur.Y = win.Position()
		rescheduleSave()
	})
	win.OnWindowEvent(events.Common.WindowMaximise, func(event *application.WindowEvent) {
		stateMu.Lock()
		defer stateMu.Unlock()
		cur.Maximized = true
		rescheduleSave()
	})
	win.OnWindowEvent(events.Common.WindowUnMaximise, func(event *application.WindowEvent) {
		stateMu.Lock()
		defer stateMu.Unlock()
		cur.Maximized = false
		// 显式捕获还原后的几何,不依赖「UnMaximise 之后必跟 WindowDidResize」的顺序。
		cur.Width, cur.Height = win.Size()
		cur.X, cur.Y = win.Position()
		rescheduleSave()
	})
	// 关闭即落盘:取消未触发的防抖、立即写一次。WindowWillClose 在窗口销毁时触发
	// (比 windowShouldClose 更接近真正关闭);即便它不触发(如 Cmd+Q),防抖写盘已保底。
	win.OnWindowEvent(events.Mac.WindowWillClose, func(event *application.WindowEvent) {
		stateMu.Lock()
		if saveT != nil {
			saveT.Stop()
			saveT = nil
		}
		snapshot := cur
		stateMu.Unlock()
		if err := ui.SaveWindow(statePath, snapshot); err != nil {
			log.Printf("ui: save window state: %v", err)
		}
	})
}
