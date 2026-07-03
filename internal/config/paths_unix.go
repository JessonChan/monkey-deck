//go:build !darwin && !windows

package config

import (
	"path/filepath"

	"github.com/adrg/xdg"
)

// defaultDirs 返回 Linux/Unix 原生约定的四个目录。
//
//   - 全部用 kebab-case slug(monkey-deck),符合 Linux 目录命名惯例
//     (命令行友好、与 release asset / 可执行文件名一致)
//   - 日志放 XDG_STATE_HOME(~/.local/state),不放 cache(cache 会被清理,
//     日志应更持久;StateHome 是 XDG Base Directory Spec 0.8 加的状态目录)
//   - 应用状态(窗口几何)也放 StateHome
//
// 依赖 adrg/xdg 各平台的 base 目录:Linux 映射 ~/.local/{share,state}、~/.cache。
func defaultDirs() dirs {
	return dirs{
		DataDir:   filepath.Join(xdg.DataHome, AppSlug),              // ~/.local/share/monkey-deck
		LogsDir:   filepath.Join(xdg.StateHome, AppSlug, "logs"),     // ~/.local/state/monkey-deck/logs
		CachesDir: filepath.Join(xdg.CacheHome, AppSlug),             // ~/.cache/monkey-deck
		StateDir:  filepath.Join(xdg.StateHome, AppSlug),             // ~/.local/state/monkey-deck
	}
}
