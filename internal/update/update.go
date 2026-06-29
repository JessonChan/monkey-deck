// Package update 把 Wails3 内置的应用自更新(app.Updater)接到 GitHub Releases。
//
// 设计要点(对齐 Wails3 自更新教程 + 本项目约束):
//   - 更新源是 GitHub Releases(monkey-deck 仓库),校验靠同发的 SHA256SUMS。
//   - 内置更新窗口由框架提供(检查/下载/校验/重启一条龙),无需额外 helper 进程。
//   - 菜单「检查更新…」走 CheckAndInstall(打开窗口跑完整流程,含「已是最新」态)。
//   - 后台静默检查(StartBackgroundChecks):仅发布版启用,找到新版本才弹窗,
//     避免每 N 小时弹一次「已是最新」打扰用户。
//
// 这一层与 ACP 无关,纯属桌面应用自更新。
package update

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/github"
)

// GitHubRepository 是发布 release 的 GitHub 仓库(owner/repo),与 go.mod 的
// module 路径一致。更新即从此仓库的 Releases 拉取。
const GitHubRepository = "jessonchan/monkey-deck"

// ChecksumAsset 是每个 release 里与二进制同发的 sha256 校验文件名。
// release 必须同时上传此文件,否则下载校验失败(见发布流程)。
const ChecksumAsset = "SHA256SUMS"

// BackgroundInterval 是后台静默检查更新的间隔。
const BackgroundInterval = 6 * time.Hour

// Init 用 GitHub Releases 源配置 app.Updater。version 为当前版本(无前导 v,
// 与 release tag 去掉 v 后的形式一致,如 "0.1.0")。失败不致命,仅禁用更新。
func Init(app *application.App, version string) error {
	gh, err := newProvider()
	if err != nil {
		return fmt.Errorf("update: %w", err)
	}
	if err := app.Updater.Init(updater.Config{
		CurrentVersion: version,
		Providers:      []updater.Provider{gh},
	}); err != nil {
		return fmt.Errorf("update: %w", err)
	}
	return nil
}

// newProvider 按项目常量构造 GitHub Releases provider。
func newProvider() (*github.Provider, error) {
	return github.New(github.Config{
		Repository:    GitHubRepository,
		ChecksumAsset: ChecksumAsset,
	})
}

// ShouldAutoCheck 判断该版本是否应启用后台自动检查。
//
// 开发构建(version=="dev" 或空)不启用:semver 把 "dev" 视为低于任何正式版,
// 会把首个 release 误判成「有更新」并在后台循环里反复弹窗。
func ShouldAutoCheck(version string) bool {
	return version != "" && version != "dev"
}

// StartBackgroundChecks 启动后台静默检查循环(仅当 ShouldAutoCheck(version) 为真)。
//
// 每个周期先静默 Check():无更新/出错均不弹窗;只有发现新版本才调 CheckAndInstall
// 打开内置更新窗口走完整「下载→校验→重启」流程。这样后台检查不会用「已是最新」打扰用户。
func StartBackgroundChecks(ctx context.Context, app *application.App, version string) {
	if app == nil || app.Updater == nil || !ShouldAutoCheck(version) {
		return
	}
	go backgroundLoop(ctx, app)
}

func backgroundLoop(ctx context.Context, app *application.App) {
	// 启动后稍候,避免与应用启动竞争。
	select {
	case <-time.After(30 * time.Second):
	case <-ctx.Done():
		return
	}
	ticker := time.NewTicker(BackgroundInterval)
	defer ticker.Stop()
	for {
		silentCheck(ctx, app)
		select {
		case <-ticker.C:
		case <-ctx.Done():
			return
		}
	}
}

// silentCheck 跑一轮静默检查:发现新版本才打开更新窗口。
// recover 防御:后台网络/回调异常不应拖垮主进程。
func silentCheck(ctx context.Context, app *application.App) {
	defer func() {
		if r := recover(); r != nil {
			logErr(app, "update background check panic", fmt.Sprintf("%v", r))
		}
	}()
	rel, err := app.Updater.Check(ctx)
	if err != nil {
		logErr(app, "update check", err.Error())
		return
	}
	if rel == nil {
		return // 已是最新:静默
	}
	// 有更新:CheckAndInstall 打开内置窗口走完整流程。
	if err := app.Updater.CheckAndInstall(ctx); err != nil {
		logErr(app, "update install", err.Error())
	}
}

func logErr(app *application.App, msg, val string) {
	if app.Logger != nil {
		app.Logger.Error(msg, "error", val)
		return
	}
	slog.Error(msg, "error", val)
}
