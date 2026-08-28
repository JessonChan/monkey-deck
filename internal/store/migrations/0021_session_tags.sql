-- schema v21: session tags (issue #150 MVP). A session carries zero or more
-- user-defined labels stored as a JSON string array ('[]' = none). Tags are a
-- purely organizational overlay: assigning or removing them is not content
-- activity, so updated_at stays untouched (same rationale as pinned 0008 and
-- custom_title 0016). Write-layer normalization (trim / dedupe / cap 5) lives
-- in store.NormalizeTags; the column itself only ever receives clean JSON.
ALTER TABLE sessions ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
