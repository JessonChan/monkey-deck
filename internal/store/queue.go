package store

// queue.go: server-side per-session message queue persistence (#126A).
// SQLite is the single truth source (§1.5): the in-service queue logic
// (internal/chat/queue.go) reads/writes through these two methods only.
// Queues are tiny (user-paced), so every mutation is a whole-list replace —
// one code path, position = slice index, no integer-gap juggling (§5.3 KISS).
//
// Attachments is stored as an opaque JSON string (the prompt-attachment array
// exactly as the chat service builds it). Deliberately NOT typed: importing
// internal/acp here would create an import cycle (acp -> mcp -> store), and
// the store layer has no business knowing ACP shapes anyway (§2.1) — the
// chat layer marshals/unmarshals at its boundary.

import (
	"context"
	"fmt"

	"github.com/google/uuid"
)

// QueueItem is one persisted queue row. Attachments is the JSON-serialized
// attachment array ("" equivalent to empty).
type QueueItem struct {
	ID          string `json:"id"`
	Text        string `json:"text"`
	Attachments string `json:"attachments"`
	ScheduledAt int64  `json:"scheduledAt"` // epoch ms; due when <= now
}

// NewQueueItem builds a due-now row with a fresh id.
func NewQueueItem(text, attachmentsJSON string, scheduledAt int64) QueueItem {
	return QueueItem{
		ID:          "q-" + uuid.NewString(),
		Text:        text,
		Attachments: attachmentsJSON,
		ScheduledAt: scheduledAt,
	}
}

// ListQueueItems returns the session's queue in FIFO order (empty slice when
// none — never nil, so callers get a stable array shape).
func (s *Store) ListQueueItems(ctx context.Context, sessionID string) ([]QueueItem, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, text, attachments, scheduled_at FROM queue_items WHERE session_id=? ORDER BY position`,
		sessionID)
	if err != nil {
		return nil, fmt.Errorf("list queue items: %w", err)
	}
	defer rows.Close()
	out := []QueueItem{}
	for rows.Next() {
		var it QueueItem
		if err := rows.Scan(&it.ID, &it.Text, &it.Attachments, &it.ScheduledAt); err != nil {
			return nil, fmt.Errorf("scan queue item: %w", err)
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// ReplaceQueueItems atomically rewrites the session's queue; position = slice
// index. items == nil/empty clears the queue. Unknown sessionID fails on the
// FK constraint (file DBs; the caller validates existence where it matters).
func (s *Store) ReplaceQueueItems(ctx context.Context, sessionID string, items []QueueItem) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin replace queue: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM queue_items WHERE session_id=?`, sessionID); err != nil {
		return fmt.Errorf("clear queue: %w", err)
	}
	nowMs := now()
	for i, it := range items {
		if it.ID == "" {
			it.ID = "q-" + uuid.NewString()
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO queue_items(id, session_id, text, attachments, scheduled_at, position, created_at) VALUES(?,?,?,?,?,?,?)`,
			it.ID, sessionID, it.Text, it.Attachments, it.ScheduledAt, i, nowMs); err != nil {
			return fmt.Errorf("insert queue item: %w", err)
		}
	}
	return tx.Commit()
}
