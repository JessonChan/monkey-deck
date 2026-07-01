// Package config 处理应用配置与数据目录解析(AGENTS.md §0.5/§1.5)。
package config

import (
	"os"
	"path/filepath"

	"github.com/adrg/xdg"
)

// Config 应用级配置(启动时确定的部分)。
type Config struct {
	DataDir      string // 数据目录(SQLite 落盘处)
	DBPath       string // SQLite 文件路径
	DefaultModel string // 默认 model(provider/model 格式)
}

// Default 返回基于 XDG 的默认配置。
// macOS: ~/Library/Application Support/monkey-deck/(§1.5)。
func Default() *Config {
	dataDir := filepath.Join(xdg.DataHome, "monkey-deck")
	return &Config{
		DataDir:      dataDir,
		DBPath:       filepath.Join(dataDir, "monkey-deck.db"),
		DefaultModel: "",
	}
}

// EnsureDir 创建数据目录(若不存在)。
func (c *Config) EnsureDir() error {
	return os.MkdirAll(c.DataDir, 0o755)
}
