package store

import (
	"context"
	"database/sql"
	"fmt"
	"sort"

	"github.com/google/uuid"
)

// PermissionRule 一条权限规则(与 internal/permissions.Rule 对齐,§3.4)。
// 空约束字段 = 通配;AND 语义;按 SortOrder 升序逐条判定。
type PermissionRule struct {
	ID             string `json:"id"`
	ToolName       string `json:"toolName"`
	ActionType     string `json:"actionType"`
	PathPattern    string `json:"pathPattern"`
	CommandPattern string `json:"commandPattern"`
	Level          string `json:"level"` // allow | ask | deny
	SortOrder      int    `json:"sortOrder"`
	Enabled        bool   `json:"enabled"`
	CreatedAt      int64  `json:"createdAt"`
	UpdatedAt      int64  `json:"updatedAt"`
}

// ListPermissionRules 按优先级(sort_order ASC)列出全部权限规则。
func (s *Store) ListPermissionRules(ctx context.Context) ([]PermissionRule, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id,tool_name,action_type,path_pattern,command_pattern,level,sort_order,enabled,created_at,updated_at
		 FROM permission_rules ORDER BY sort_order ASC, created_at ASC`)
	if err != nil {
		return nil, fmt.Errorf("list permission rules: %w", err)
	}
	defer rows.Close()
	var out []PermissionRule
	for rows.Next() {
		var r PermissionRule
		var enabled int
		if err := rows.Scan(&r.ID, &r.ToolName, &r.ActionType, &r.PathPattern, &r.CommandPattern, &r.Level, &r.SortOrder, &enabled, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		r.Enabled = enabled != 0
		out = append(out, r)
	}
	return out, rows.Err()
}

// CreatePermissionRule 新建一条规则(id 由调用方给出或自动生成)。返回创建后的规则。
func (s *Store) CreatePermissionRule(ctx context.Context, r PermissionRule) (*PermissionRule, error) {
	if r.ID == "" {
		r.ID = uuid.NewString()
	}
	// 未指定 sort_order → 放到队尾(现有最大 +1)
	if r.SortOrder == 0 && r.ID != "" {
		var maxOrder int
		_ = s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(sort_order),-1) FROM permission_rules`).Scan(&maxOrder)
		r.SortOrder = maxOrder + 1
	}
	r.CreatedAt = now()
	r.UpdatedAt = now()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO permission_rules(id,tool_name,action_type,path_pattern,command_pattern,level,sort_order,enabled,created_at,updated_at)
		 VALUES(?,?,?,?,?,?,?,?,?,?)`,
		r.ID, r.ToolName, r.ActionType, r.PathPattern, r.CommandPattern, r.Level, r.SortOrder, boolToInt(r.Enabled), r.CreatedAt, r.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create permission rule: %w", err)
	}
	return &r, nil
}

// UpdatePermissionRule 全量更新一条规则(按 id)。enabled/level/各约束字段均来自入参。
func (s *Store) UpdatePermissionRule(ctx context.Context, r PermissionRule) error {
	r.UpdatedAt = now()
	res, err := s.db.ExecContext(ctx,
		`UPDATE permission_rules SET tool_name=?,action_type=?,path_pattern=?,command_pattern=?,level=?,sort_order=?,enabled=?,updated_at=? WHERE id=?`,
		r.ToolName, r.ActionType, r.PathPattern, r.CommandPattern, r.Level, r.SortOrder, boolToInt(r.Enabled), r.UpdatedAt, r.ID)
	if err != nil {
		return fmt.Errorf("update permission rule: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// DeletePermissionRule 按 id 删除一条规则。
func (s *Store) DeletePermissionRule(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM permission_rules WHERE id=?`, id)
	if err != nil {
		return fmt.Errorf("delete permission rule: %w", err)
	}
	return nil
}

// ReorderPermissionRules 按传入 id 顺序全量重写 sort_order 为 0..N-1(拖拽后调用)。
func (s *Store) ReorderPermissionRules(ctx context.Context, ids []string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("reorder permission rules (begin): %w", err)
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, `UPDATE permission_rules SET sort_order=? WHERE id=?`)
	if err != nil {
		return fmt.Errorf("reorder permission rules (prepare): %w", err)
	}
	defer stmt.Close()
	for i, id := range ids {
		if _, err := stmt.ExecContext(ctx, i, id); err != nil {
			return fmt.Errorf("reorder permission rules (update %s): %w", id, err)
		}
	}
	return tx.Commit()
}

// SeedDefaultPermissionRules 表空时写入默认规则(§3.4)。返回是否写了。
// 默认规则来自调用方传入(避免 store 依赖 internal/permissions 包,反向依赖)。
func (s *Store) SeedDefaultPermissionRules(ctx context.Context, defaults []PermissionRule) (bool, error) {
	existing, err := s.ListPermissionRules(ctx)
	if err != nil {
		return false, err
	}
	if len(existing) > 0 {
		return false, nil
	}
	// 确保按传入顺序写(sort_order 用下标),稳定优先级。
	sort.SliceStable(defaults, func(i, j int) bool { return defaults[i].SortOrder < defaults[j].SortOrder })
	for i := range defaults {
		defaults[i].SortOrder = i // 归一化:0..N-1
		if _, err := s.CreatePermissionRule(ctx, defaults[i]); err != nil {
			return false, err
		}
	}
	return true, nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
