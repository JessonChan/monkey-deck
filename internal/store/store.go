// Package store 是 SQLite 的唯一入口(AGENTS.md §2.1)。
// 业务包禁止直接写裸 SQL,全部经此 CRUD。本地单文件是唯一真相来源(§1.5)。
package store

import (
	"database/sql"
	"embed"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Store 封装 SQLite 连接。
type Store struct {
	db *sql.DB
}

// Message 一条对话记录(role: user/agent/thought/tool)。
type Message struct {
	ID         string `json:"id"`
	SessionID  string `json:"sessionId"`
	Role       string `json:"role"`
	Kind       string `json:"kind"`
	Content    string `json:"content"`
	ToolCallID string `json:"toolCallId,omitempty"`
	Seq        int64  `json:"seq"`
	CreatedAt  int64  `json:"createdAt"`
}

// Project 一个项目(= 磁盘目录)。
type Project struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	Model     string `json:"model"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

// Session 一个 ACP session(钉在 project 上)。
type Session struct {
	ID         string `json:"id"`
	ProjectID  string `json:"projectId"`
	ACPSession string `json:"acpSession"`
	Title      string `json:"title"`
	Model      string `json:"model"`
	// token 用量(最后一次 SessionUsageUpdate 的快照,使重开会话能恢复占比,§1.6)。
	UsedTokens int64   `json:"usedTokens"`
	SizeTokens int64   `json:"sizeTokens"`
	Cost       float64 `json:"cost"`
	CreatedAt  int64   `json:"createdAt"`
	UpdatedAt  int64   `json:"updatedAt"`
}

// New 打开(或创建)SQLite 并跑迁移。dbPath 为空时用内存库(测试用)。
func New(dbPath string) (*Store, error) {
	dsn := dbPath
	if dsn == "" {
		dsn = ":memory:"
	} else {
		dsn = "file:" + dsn + "?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// 单进程桌面应用,1 连接足够且避免 WAL 检查点竞争。
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// Close 关闭数据库。
func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	// schema 版本表
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`); err != nil {
		return fmt.Errorf("create schema_version: %w", err)
	}
	var version int
	row := s.db.QueryRow(`SELECT COALESCE(MAX(version),0) FROM schema_version`)
	if err := row.Scan(&version); err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		return fmt.Errorf("read migrations dir: %w", err)
	}
	// 简单递增:每个文件名 000N_xxx.sql,N>version 就跑。
	for _, e := range entries {
		var n int
		if _, err := fmt.Sscanf(e.Name(), "%04d", &n); err != nil {
			continue
		}
		if n <= version {
			continue
		}
		b, err := migrationFS.ReadFile("migrations/" + e.Name())
		if err != nil {
			return fmt.Errorf("read migration %s: %w", e.Name(), err)
		}
		if _, err := s.db.Exec(string(b)); err != nil {
			return fmt.Errorf("apply migration %s: %w", e.Name(), err)
		}
		if _, err := s.db.Exec(`INSERT INTO schema_version(version) VALUES (?)`, n); err != nil {
			return fmt.Errorf("record version %d: %w", n, err)
		}
	}
	return nil
}

func now() int64 { return time.Now().UnixMilli() }
