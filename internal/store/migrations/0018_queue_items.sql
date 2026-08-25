-- schema v18: server-side per-session message queue (#126A). The queue used
-- to live in frontend memory (App.tsx queueBySession): it vanished on window
-- close/app restart and remote clients each held their own diverging copy.
-- It now moves to the backend (single owner, §2.2 one process = everything)
-- and persists here, so queued messages survive restarts and are shared by
-- every surface (desktop GUI / remote browser / PWA).
-- One row = one queued (not yet sent) message:
--   attachments: JSON-serialized []acp.Attachment (same shape SendMessage
--                takes; built once at enqueue time, reused verbatim by drain).
--   scheduled_at: epoch ms when the item becomes due. Default = enqueue time
--                ("send immediately when possible"); a future value parks the
--                item until then (scheduled send, #97).
--   position:    FIFO order within the session (0..N-1, rewritten on every
--                mutation — queues are tiny, whole-list replace keeps one
--                code path instead of gap-juggling integers).
-- Rows cascade with the session (ON DELETE CASCADE): deleting a session
-- drops its queue; closing a window/tab keeps it.
CREATE TABLE IF NOT EXISTS queue_items (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    attachments TEXT NOT NULL DEFAULT '[]',
    scheduled_at INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_items_session ON queue_items(session_id, position);
