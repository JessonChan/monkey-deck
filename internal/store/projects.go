package store

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/google/uuid"
)

// --- Projects ---

// CreateProject 新建项目(path 唯一)。model 为空则用默认。
func (s *Store) CreateProject(ctx context.Context, name, path, model string) (*Project, error) {
	p := &Project{
		ID:        uuid.NewString(),
		Name:      name,
		Path:      path,
		Model:     model,
		CreatedAt: now(),
		UpdatedAt: now(),
	}
	// sort_order = MIN-1(表空则 0):新建项目恒在顶部(0007)。
	var minOrder int64
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE((SELECT MIN(sort_order)-1 FROM projects), 0)`).Scan(&minOrder); err != nil {
		return nil, fmt.Errorf("create project (sort_order): %w", err)
	}
	p.SortOrder = minOrder
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO projects(id,name,path,model,created_at,updated_at,sort_order) VALUES(?,?,?,?,?,?,?)`,
		p.ID, p.Name, p.Path, p.Model, p.CreatedAt, p.UpdatedAt, p.SortOrder)
	if err != nil {
		return nil, fmt.Errorf("create project: %w", err)
	}
	return p, nil
}

// ListProjects 列出全部项目(按 sort_order ASC, updated_at DESC):全 0 时兜底 updated_at DESC(原行为不变),拖拽后按手动顺序。
func (s *Store) ListProjects(ctx context.Context) ([]Project, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id,name,path,model,created_at,updated_at,allow_external_dir,sort_order FROM projects ORDER BY sort_order ASC, updated_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	defer rows.Close()
	var out []Project
	for rows.Next() {
		var p Project
		if err := rows.Scan(&p.ID, &p.Name, &p.Path, &p.Model, &p.CreatedAt, &p.UpdatedAt, &p.AllowExternal, &p.SortOrder); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// GetProject 取单个项目。
func (s *Store) GetProject(ctx context.Context, id string) (*Project, error) {
	var p Project
	err := s.db.QueryRowContext(ctx,
		`SELECT id,name,path,model,created_at,updated_at,allow_external_dir,sort_order FROM projects WHERE id=?`, id).
		Scan(&p.ID, &p.Name, &p.Path, &p.Model, &p.CreatedAt, &p.UpdatedAt, &p.AllowExternal, &p.SortOrder)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get project: %w", err)
	}
	return &p, nil
}

// GetProjectByPath 按 path 取项目(去重用)。
func (s *Store) GetProjectByPath(ctx context.Context, path string) (*Project, error) {
	var p Project
	err := s.db.QueryRowContext(ctx,
		`SELECT id,name,path,model,created_at,updated_at,allow_external_dir,sort_order FROM projects WHERE path=?`, path).
		Scan(&p.ID, &p.Name, &p.Path, &p.Model, &p.CreatedAt, &p.UpdatedAt, &p.AllowExternal, &p.SortOrder)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get project by path: %w", err)
	}
	return &p, nil
}

// ReorderProjects 按传入 id 顺序全量重写 sort_order 为 0..N-1(侧栏拖拽后调用)。
// 项目量级小(几十),事务内逐条 UPDATE,全量重写最简单可靠,无需 lexorank/浮点。
func (s *Store) ReorderProjects(ctx context.Context, ids []string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("reorder projects (begin): %w", err)
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, `UPDATE projects SET sort_order=? WHERE id=?`)
	if err != nil {
		return fmt.Errorf("reorder projects (prepare): %w", err)
	}
	defer stmt.Close()
	for i, id := range ids {
		if _, err := stmt.ExecContext(ctx, i, id); err != nil {
			return fmt.Errorf("reorder projects (update %s): %w", id, err)
		}
	}
	return tx.Commit()
}

// UpdateProject 更新项目的 name/model。
func (s *Store) UpdateProject(ctx context.Context, id, name, model string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE projects SET name=?, model=?, updated_at=? WHERE id=?`,
		name, model, now(), id)
	return err
}

// SetProjectAllowExternal 设置项目级权限记忆(用户在权限弹窗选「本项目允许」时写)。
// 按 project 存、不分 harness → 跨 harness 共享;session 启动时由 service 读出加载进
// handler(Handler.SetProjectAllowExternal),命中即对所有后续 RequestPermission 自动放行。
// 列名 allow_external_dir 保留历史(曾仅管外部目录),语义已泛化为「项目已批准」。
func (s *Store) SetProjectAllowExternal(ctx context.Context, id string, allow bool) error {
	v := 0
	if allow {
		v = 1
	}
	_, err := s.db.ExecContext(ctx, `UPDATE projects SET allow_external_dir=?, updated_at=? WHERE id=?`, v, now(), id)
	return err
}

// TouchProject 更新项目的 updated_at(有新活动时)。
func (s *Store) TouchProject(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE projects SET updated_at=? WHERE id=?`, now(), id)
	return err
}

// DeleteProject 删除项目(级联删 session + message)。
func (s *Store) DeleteProject(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM projects WHERE id=?`, id)
	return err
}
