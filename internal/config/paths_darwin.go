//go:build darwin

package config

import (
	"os"
	"path/filepath"

	"github.com/adrg/xdg"
)

// defaultDirs 返回 macOS 原生约定的四个目录。
//
//   - Application Support 用显示名(Finder 可读)
//   - Caches/SavedState 用 BundleID(与签名/沙盒标识对齐,业界成熟应用惯例)
//   - Logs 在 ~/Library/Logs/<AppName>(Console.app 直接定位)
//
// macOS 的 Logs/SavedState 没有标准 XDG 环境变量,需手动拼接 home/Library。
func defaultDirs() dirs {
	home := homeDir()
	return dirs{
		DataDir:   filepath.Join(xdg.DataHome, AppName),                            // ~/Library/Application Support/Monkey Deck
		LogsDir:   filepath.Join(home, "Library", "Logs", AppName),                 // ~/Library/Logs/Monkey Deck
		CachesDir: filepath.Join(xdg.CacheHome, BundleID),                          // ~/Library/Caches/com.jessonchan.monkeydeck
		StateDir:  filepath.Join(home, "Library", "Saved Application State", BundleID+".savedState"),
	}
}

// homeDir 返回用户主目录;失败回退 "."(保证路径拼接不 panic)。
func homeDir() string {
	h, err := os.UserHomeDir()
	if err != nil || h == "" {
		return "."
	}
	return h
}
