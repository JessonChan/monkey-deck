package store

// user_harnesses.go:用户声明的 ACP harness 持久化(声明即用流程)。
//
// 与内置 harness(harness.Supported/Registry,Go 变量)并列。用户经 ProbeHarness 自检通过后
// 落库一行;启动时 service 层把它和内置项合并成完整 harness 列表。
//
// 这里只管 CRUD(§2.1:store 是 SQL 唯一入口);"是否能加"的判定在 ProbeHarness(acp 层),
// "与内置 id 冲突"的校验在 service 层(harness.IsBuiltin)。store 不假设这些语义。

import (
	"context"
	"database/sql"
	"fmt"
)

// UserHarness 用户声明的 ACP harness 一行。
type UserHarness struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Command   string `json:"command"`
	Icon      string `json:"icon"` // 空走通用兜底
	CreatedAt int64  `json:"createdAt"`
}

// CreateUserHarness 新建一个用户 harness。id 由调用方给(避免与内置冲突)。
// icon 空串合法(走兜底)。返回带 created_at 的完整行。
func (s *Store) CreateUserHarness(ctx context.Context, id, name, command, icon string) (*UserHarness, error) {
	if id == "" {
		return nil, fmt.Errorf("create user harness: id is required")
	}
	if command == "" {
		return nil, fmt.Errorf("create user harness: command is required")
	}
	h := &UserHarness{
		ID:        id,
		Name:      name,
		Command:   command,
		Icon:      icon,
		CreatedAt: now(),
	}
	if h.Name == "" {
		h.Name = id // 兜底显示名 = id
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO user_harnesses(id,name,command,icon,created_at) VALUES(?,?,?,?,?)`,
		h.ID, h.Name, h.Command, h.Icon, h.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create user harness: %w", err)
	}
	return h, nil
}

// ListUserHarnesses 列出全部用户 harness(按 created_at ASC,稳定顺序;内置项在前由合并层保证)。
func (s *Store) ListUserHarnesses(ctx context.Context) ([]UserHarness, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id,name,command,icon,created_at FROM user_harnesses ORDER BY created_at ASC`)
	if err != nil {
		return nil, fmt.Errorf("list user harnesses: %w", err)
	}
	defer rows.Close()
	var out []UserHarness
	for rows.Next() {
		var h UserHarness
		if err := rows.Scan(&h.ID, &h.Name, &h.Command, &h.Icon, &h.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// GetUserHarness 取单个用户 harness;不存在返回 nil, nil(调用方按 builtin 回退)。
func (s *Store) GetUserHarness(ctx context.Context, id string) (*UserHarness, error) {
	var h UserHarness
	err := s.db.QueryRowContext(ctx,
		`SELECT id,name,command,icon,created_at FROM user_harnesses WHERE id=?`, id).
		Scan(&h.ID, &h.Name, &h.Command, &h.Icon, &h.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get user harness: %w", err)
	}
	return &h, nil
}

// DeleteUserHarness 删除一个用户 harness。不存在不算错(幂等)。
func (s *Store) DeleteUserHarness(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM user_harnesses WHERE id=?`, id)
	if err != nil {
		return fmt.Errorf("delete user harness: %w", err)
	}
	return nil
}

