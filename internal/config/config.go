// Package config 处理应用配置与数据目录解析(AGENTS.md §0.5/§1.5)。
//
// 目录语义按各平台原生约定分流,让系统清理 / 备份 / 控制台各得其所:
//
//   - DataDir   用户不可再生的数据(SQLite、配置)
//   - LogsDir   诊断日志
//   - CachesDir 可再生的缓存与运行期状态(worktree、pgid 跟踪)
//   - StateDir  窗口/应用状态
//
// 每个平台的命名约定不同(对照业界成熟桌面应用):
//
//   - macOS:Application Support/Monkey Deck、Logs/Monkey Deck、
//     Caches/com.jessonchan.monkeydeck、Saved Application State/<bundle-id>.savedState
//   - Linux:~/.local/share/<slug>、~/.local/state/<slug>[/logs]、~/.cache/<slug>
//   - Windows:%LOCALAPPDATA%\<App>\{Logs,Cache,State}
//
// 平台逻辑见 paths_*.go(build tags 分发)。
package config

import (
	"fmt"
	"os"
	"path/filepath"
)

// 应用身份常量。三段命名(对照业界成熟应用):
//   - AppName  用户可见名(Dock / 菜单 / Finder / Windows 目录)
//   - BundleID 反向域名系统标识(macOS 签名 / 状态目录 / 沙盒)
//   - AppSlug  技术 slug(Linux 目录 / 可执行文件 / 日志文件名 / release asset)
const (
	AppName  = "Monkey Deck"
	BundleID = "com.jessonchan.monkeydeck"
	AppSlug  = "monkey-deck"
)

// dirs 是平台解析出的四个基础目录(paths_*.go 的 defaultDirs 返回)。
type dirs struct {
	DataDir   string
	LogsDir   string
	CachesDir string
	StateDir  string
}

// Config 应用级配置(启动时确定的部分)。
type Config struct {
	DataDir      string // 用户数据:SQLite、配置 —— 不可丢
	LogsDir      string // 日志:诊断日志,Console.app / journalctl / 事件查看器直接看
	CachesDir    string // 缓存:worktree、pgid 跟踪 —— 可再生
	StateDir     string // 应用状态:窗口几何
	DBPath       string // SQLite 文件路径(位于 DataDir)
	DefaultModel string // 默认 model(provider/model 格式)
}

// Default 返回当前平台的默认配置。目录按平台约定分流(见包文档)。
func Default() *Config {
	d := defaultDirs()
	return &Config{
		DataDir:      d.DataDir,
		LogsDir:      d.LogsDir,
		CachesDir:    d.CachesDir,
		StateDir:     d.StateDir,
		DBPath:       filepath.Join(d.DataDir, AppSlug+".db"),
		DefaultModel: "",
	}
}

// EnsureDir 创建全部所需目录(若不存在)。DataDir/LogsDir/CachesDir/StateDir 各归位。
func (c *Config) EnsureDir() error {
	for _, dir := range []string{c.DataDir, c.LogsDir, c.CachesDir, c.StateDir} {
		if dir == "" {
			continue
		}
		// 0o700:多用户系统下日志/缓存/数据库不应被其他用户读(§5 安全)。
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("create dir %s: %w", dir, err)
		}
	}
	return nil
}

// TestConfig 返回所有目录均落在 dir 下的配置(测试用,与 Default 同构)。
func TestConfig(dir string) *Config {
	return &Config{
		DataDir:   dir,
		LogsDir:   dir,
		CachesDir: dir,
		StateDir:  dir,
		DBPath:    filepath.Join(dir, AppSlug+".db"),
	}
}
