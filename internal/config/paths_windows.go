//go:build windows

package config

import (
	"path/filepath"

	"github.com/adrg/xdg"
)

// defaultDirs 返回 Windows 原生约定的四个目录。
//
//   - 全部以 %LOCALAPPDATA%\<AppName> 为根(Windows 桌面应用最常见布局,
//     Discord / Slack / VS Code 等),内部 Logs/Cache/State 子目录分流
//   - 用显示名(AppName)而非 slug:Windows 文件系统不区分大小写但支持空格,
//     Explorer 里 Pascal Case 带空格更自然
//
// adrg/xdg 在 Windows 上的映射:DataHome 与 StateHome 均解析为 %LOCALAPPDATA%。
func defaultDirs() dirs {
	root := filepath.Join(xdg.DataHome, AppName) // %LOCALAPPDATA%\Monkey Deck
	return dirs{
		DataDir:   root,
		LogsDir:   filepath.Join(root, "Logs"),
		CachesDir: filepath.Join(root, "Cache"),
		StateDir:  filepath.Join(root, "State"),
	}
}
