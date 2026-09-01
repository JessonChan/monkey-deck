-- schema v24: fork base watermark (#172 Phase 3).
-- For a forked session: the source session's max message seq at fork time.
-- The fork's transcript is assembled as "source messages with seq <= fork_base_seq"
-- plus the fork's own messages — a lineage query, no message copies (the local DB
-- is the source of truth, §1.5). 0 = no watermark recorded (pre-v24 fork or
-- non-fork session); forks of empty conversations are rejected before this row
-- is written, so a fork always carries a real watermark.
ALTER TABLE sessions ADD COLUMN fork_base_seq INTEGER NOT NULL DEFAULT 0;
