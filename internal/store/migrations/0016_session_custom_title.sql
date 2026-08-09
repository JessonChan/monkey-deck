-- schema v16:session custom title (user-defined rename, kept separate from the
-- harness/auto-generated title). Sidebar shows custom_title when set, falling back
-- to title; hovering a renamed session reveals the original auto title.
-- Default '' (no custom title). Rename is not content activity -> does not touch
-- updated_at (keeps time display and secondary sort stable, same rationale as pinned).
ALTER TABLE sessions ADD COLUMN custom_title TEXT NOT NULL DEFAULT '';
