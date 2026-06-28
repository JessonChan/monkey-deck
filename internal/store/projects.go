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
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO projects(id,name,path,model,created_at,updated_at) VALUES(?,?,?,?,?,?)`,
		p.ID, p.Name, p.Path, p.Model, p.CreatedAt, p.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create project: %w", err)
	}
	return p, nil
}

// ListProjects 列出全部项目(按更新时间倒序)。
func (s *Store) ListProjects(ctx context.Context) ([]Project, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id,name,path,model,created_at,updated_at FROM projects ORDER BY updated_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	defer rows.Close()
	var out []Project
	for rows.Next() {
		var p Project
		if err := rows.Scan(&p.ID, &p.Name, &p.Path, &p.Model, &p.CreatedAt, &p.UpdatedAt); err != nil {
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
		`SELECT id,name,path,model,created_at,updated_at FROM projects WHERE id=?`, id).
		Scan(&p.ID, &p.Name, &p.Path, &p.Model, &p.CreatedAt, &p.UpdatedAt)
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
		`SELECT id,name,path,model,created_at,updated_at FROM projects WHERE path=?`, path).
		Scan(&p.ID, &p.Name, &p.Path, &p.Model, &p.CreatedAt, &p.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get project by path: %w", err)
	}
	return &p, nil
}

// UpdateProject 更新项目的 name/model。
func (s *Store) UpdateProject(ctx context.Context, id, name, model string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE projects SET name=?, model=?, updated_at=? WHERE id=?`,
		name, model, now(), id)
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
