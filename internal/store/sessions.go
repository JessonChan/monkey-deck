package store

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/google/uuid"
)

// sessionColumns / scanSession:统一 session 的列与扫描,避免多处 SELECT/Scan 漂移(§1.5)。
const sessionColumns = `id,project_id,acp_session_id,title,model,harness,worktree_path,branch,used_tokens,size_tokens,cost,created_at,updated_at`

func scanSession(r interface {
	Scan(dest ...any) error
}, se *Session) error {
	return r.Scan(&se.ID, &se.ProjectID, &se.ACPSession, &se.Title, &se.Model, &se.Harness,
		&se.WorktreePath, &se.Branch,
		&se.UsedTokens, &se.SizeTokens, &se.Cost, &se.CreatedAt, &se.UpdatedAt)
}

// --- Sessions ---

// CreateSession 新建 session(钉在 project 上)。model 为空用项目默认;harness 为空用 opencode。
func (s *Store) CreateSession(ctx context.Context, projectID, title, model, harnessv string) (*Session, error) {
	if harnessv == "" {
		harnessv = "opencode"
	}
	sess := &Session{
		ID:        uuid.NewString(),
		ProjectID: projectID,
		Title:     title,
		Model:     model,
		Harness:   harnessv,
		CreatedAt: now(),
		UpdatedAt: now(),
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO sessions(id,project_id,acp_session_id,title,model,harness,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
		sess.ID, sess.ProjectID, sess.ACPSession, sess.Title, sess.Model, sess.Harness, sess.CreatedAt, sess.UpdatedAt)
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

// UpdateSessionUsage 回写 token 用量快照(used/size/cost),使重开会话能恢复占比(§1.6)。
func (s *Store) UpdateSessionUsage(ctx context.Context, id string, used, size int64, cost float64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE sessions SET used_tokens=?, size_tokens=?, cost=?, updated_at=? WHERE id=?`,
		used, size, cost, now(), id)
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
		`SELECT `+sessionColumns+` FROM sessions WHERE project_id=? ORDER BY updated_at DESC`,
		projectID)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		var se Session
		if err := scanSession(rows, &se); err != nil {
			return nil, err
		}
		out = append(out, se)
	}
	return out, rows.Err()
}

// GetSession 取单个 session。
func (s *Store) GetSession(ctx context.Context, id string) (*Session, error) {
	var se Session
	if err := scanSession(s.db.QueryRowContext(ctx,
		`SELECT `+sessionColumns+` FROM sessions WHERE id=?`, id), &se); err == sql.ErrNoRows {
		return nil, nil
	} else if err != nil {
		return nil, fmt.Errorf("get session: %w", err)
	}
	return &se, nil
}

// DeleteSession 删除 session(级联删 message)。
func (s *Store) DeleteSession(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE id=?`, id)
	return err
}

// SetSessionWorktree 记录 session 的 git worktree 路径与分支(创建 worktree 后调)。
func (s *Store) SetSessionWorktree(ctx context.Context, id, worktreePath, branch string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE sessions SET worktree_path=?, branch=?, updated_at=? WHERE id=?`,
		worktreePath, branch, now(), id)
	return err
}
