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

// SessionHasMessages 报告某 session 是否已有消息。
// 用于懒 spawn 判定:历史会话(有消息)只读打开,不 spawn harness(§3.x 懒 spawn)。
func (s *Store) SessionHasMessages(ctx context.Context, sessionID string) (bool, error) {
	var exists int
	err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM messages WHERE session_id=?)`,
		sessionID).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("session has messages: %w", err)
	}
	return exists == 1, nil
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

// ListUserMessages 列出某 session 全部用户消息的文本内容(按 seq 升序,无长度限制)。
// 供输入框「上下键翻历史」用:翻遍该 session 所有发过的消息。
func (s *Store) ListUserMessages(ctx context.Context, sessionID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT content FROM messages WHERE session_id=? AND role='user' ORDER BY seq ASC`,
		sessionID)
	if err != nil {
		return nil, fmt.Errorf("list user messages: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ListMessagesBefore 游标分页:取 seq < beforeSeq 的最新 limit+1 条(beforeSeq<=0 取最新一页)。
// 多取 1 条用于判断 hasMore;返回按 seq 升序(与 ListMessages 一致)。前端据此 slice + 判断。
func (s *Store) ListMessagesBefore(ctx context.Context, sessionID string, beforeSeq int64, limit int) ([]Message, error) {
	if limit <= 0 {
		limit = 30
	}
	query := `SELECT id,session_id,role,kind,content,tool_call_id,seq,created_at FROM messages WHERE session_id=?`
	args := []any{sessionID}
	if beforeSeq > 0 {
		query += ` AND seq < ?`
		args = append(args, beforeSeq)
	}
	query += ` ORDER BY seq DESC LIMIT ?`
	args = append(args, limit+1) // +1: 多取一条探测 hasMore

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list messages before: %w", err)
	}
	defer rows.Close()
	var desc []Message
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.SessionID, &m.Role, &m.Kind, &m.Content, &m.ToolCallID, &m.Seq, &m.CreatedAt); err != nil {
			return nil, err
		}
		desc = append(desc, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// 反转为升序(查询是 DESC)。
	for i, j := 0, len(desc)-1; i < j; i, j = i+1, j-1 {
		desc[i], desc[j] = desc[j], desc[i]
	}
	return desc, nil
}

// SearchSessionIDsByContent 返回某项目下消息内容包含 query(大小写不敏感)的 session id 去重列表。
// 供侧栏会话搜索:桌面级 SQLite 单项目 LIKE 扫描是毫秒级,无需 FTS5。
// 返回 id 列表,前端在已加载的 session 列表上与标题命中做并集过滤(KISS:只回 id,不回 snippet)。
// 注意:query 中的 %/_ 会作 LIKE 通配符,桌面搜索场景可接受。
func (s *Store) SearchSessionIDsByContent(ctx context.Context, projectID, query string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT DISTINCT m.session_id FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.project_id=? AND m.content LIKE ? COLLATE NOCASE`,
		projectID, "%"+query+"%")
	if err != nil {
		return nil, fmt.Errorf("search session content: %w", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
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
