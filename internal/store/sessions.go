package store

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/google/uuid"
)

// --- Sessions ---

// CreateSession 新建 session(钉在 project 上)。model 为空用项目默认。
func (s *Store) CreateSession(ctx context.Context, projectID, title, model string) (*Session, error) {
	sess := &Session{
		ID:        uuid.NewString(),
		ProjectID: projectID,
		Title:     title,
		Model:     model,
		CreatedAt: now(),
		UpdatedAt: now(),
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO sessions(id,project_id,acp_session_id,title,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`,
		sess.ID, sess.ProjectID, sess.ACPSession, sess.Title, sess.Model, sess.CreatedAt, sess.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create session: %w", err)
	}
	return sess, nil
}

// UpdateSessionACP 记录 opencode 返回的 session id(LoadSession resume 用,§1.4)。
func (s *Store) UpdateSessionACP(ctx context.Context, id, acpSessionID, title string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE sessions SET acp_session_id=?, title=?, updated_at=? WHERE id=?`,
		acpSessionID, title, now(), id)
	return err
}

// UpdateSessionTitle 更新 session 标题。
func (s *Store) UpdateSessionTitle(ctx context.Context, id, title string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE sessions SET title=?, updated_at=? WHERE id=?`, title, now(), id)
	return err
}

// TouchSession 更新 updated_at。
func (s *Store) TouchSession(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE sessions SET updated_at=? WHERE id=?`, now(), id)
	return err
}

// ListSessions 列出某项目的全部 session(按更新时间倒序)。
func (s *Store) ListSessions(ctx context.Context, projectID string) ([]Session, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id,project_id,acp_session_id,title,model,created_at,updated_at FROM sessions WHERE project_id=? ORDER BY updated_at DESC`,
		projectID)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		var se Session
		if err := rows.Scan(&se.ID, &se.ProjectID, &se.ACPSession, &se.Title, &se.Model, &se.CreatedAt, &se.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, se)
	}
	return out, rows.Err()
}

// GetSession 取单个 session。
func (s *Store) GetSession(ctx context.Context, id string) (*Session, error) {
	var se Session
	err := s.db.QueryRowContext(ctx,
		`SELECT id,project_id,acp_session_id,title,model,created_at,updated_at FROM sessions WHERE id=?`, id).
		Scan(&se.ID, &se.ProjectID, &se.ACPSession, &se.Title, &se.Model, &se.CreatedAt, &se.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get session: %w", err)
	}
	return &se, nil
}

// DeleteSession 删除 session(级联删 message)。
func (s *Store) DeleteSession(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE id=?`, id)
	return err
}
