package store

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/google/uuid"
)

// --- Messages ---

// AppendMessage 追加一条消息(seq 自增)。role: user/agent/thought/tool。
func (s *Store) AppendMessage(ctx context.Context, sessionID, role, kind, content, toolCallID string) (*Message, error) {
	row := s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq),0)+1 FROM messages WHERE session_id=?`, sessionID)
	var seq int64
	if err := row.Scan(&seq); err != nil {
		return nil, fmt.Errorf("next seq: %w", err)
	}
	m := &Message{
		ID:         uuid.NewString(),
		SessionID:  sessionID,
		Role:       role,
		Kind:       kind,
		Content:    content,
		ToolCallID: toolCallID,
		Seq:        seq,
		CreatedAt:  now(),
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO messages(id,session_id,role,kind,content,tool_call_id,seq,created_at) VALUES(?,?,?,?,?,?,?,?)`,
		m.ID, m.SessionID, m.Role, m.Kind, m.Content, m.ToolCallID, m.Seq, m.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("append message: %w", err)
	}
	if err := s.TouchSession(ctx, sessionID); err != nil {
		return nil, err
	}
	return m, nil
}

// ListMessages 列出某 session 全部消息(按 seq 升序)。
func (s *Store) ListMessages(ctx context.Context, sessionID string) ([]Message, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id,session_id,role,kind,content,tool_call_id,seq,created_at FROM messages WHERE session_id=? ORDER BY seq ASC`,
		sessionID)
	if err != nil {
		return nil, fmt.Errorf("list messages: %w", err)
	}
	defer rows.Close()
	var out []Message
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.SessionID, &m.Role, &m.Kind, &m.Content, &m.ToolCallID, &m.Seq, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// --- Settings ---

// GetSetting 取配置值;无则返回空串。
func (s *Store) GetSetting(ctx context.Context, key string) (string, error) {
	var v string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key=?`, key).Scan(&v)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return v, err
}

// SetSetting 设置配置值。
func (s *Store) SetSetting(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
		key, value)
	return err
}
