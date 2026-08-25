-- schema v17: messages gain turn-scoped upsert keys for incremental turn
-- persistence (#125). Streamed turn content used to be written only at turn
-- end (persistTurn); a crash mid-turn lost the whole partial reply. Now entries
-- flush incrementally (debounced) and the turn-end pass reconciles via
-- UpsertTurnMessage, keyed by (session_id, turn_id, entry_key):
--   turn_id  = user message id that opened the turn (client-generated).
--   entry_key= timeline entry id ("msg:<messageId>:<role>" | toolCallId).
--
-- The unique index is PARTIAL (entry_key != '') so legacy rows written before
-- this migration (empty entry_key, no dedupe semantics) stay outside the index
-- and cannot violate it; SQLite upsert targets it via
-- ON CONFLICT(session_id, turn_id, entry_key) WHERE entry_key != ''.
-- seq is only set on INSERT: a row keeps the position of its first appearance,
-- so repeated upserts never reorder history (§5.4 #5). created_at refreshes on
-- update: the turn-end reconcile writes the final content last, so the stored
-- timestamp converges to turn end — same time semantics as the old
-- write-everything-at-turn-end behavior (frontend #68 relies on it).
ALTER TABLE messages ADD COLUMN turn_id TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN entry_key TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_turn_entry
    ON messages(session_id, turn_id, entry_key) WHERE entry_key != '';
