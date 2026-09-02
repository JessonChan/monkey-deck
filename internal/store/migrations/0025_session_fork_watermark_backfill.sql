-- schema v25: backfill fork_base_seq for forks created before the watermark
-- mechanism existed (#189). The watermark column landed in 0024 (a7c9b9b);
-- fork rows created before it carry only forked_from with fork_base_seq = 0,
-- and LoadMessagesPage's guard (ForkBaseSeq <= 0) falls back to own-only —
-- such forks reopen with an empty history even though their lineage is
-- intact in the local DB.
--
-- Reconstruct the watermark as the source's max message seq at/before the
-- fork's creation time (created_at <= fork.created_at, inclusive), so source
-- messages written AFTER the fork can never leak into the lineage prefix.
-- A fork whose source has no messages at/before the boundary keeps 0: the
-- lineage stays off, same as today — we do not fabricate a prefix. Rows
-- already carrying a real watermark are untouched.
UPDATE sessions
SET fork_base_seq = (
    SELECT COALESCE(MAX(seq), 0)
    FROM messages
    WHERE session_id = sessions.forked_from
      AND created_at <= sessions.created_at
)
WHERE forked_from IS NOT NULL
  AND forked_from != ''
  AND (fork_base_seq IS NULL OR fork_base_seq <= 0);
