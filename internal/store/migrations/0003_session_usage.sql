-- schema v3:持久化 session token 用量(AGENTS.md §1.6)。
-- SessionUsageUpdate 的累积 context 量(used)+ 窗口大小(size)+ 自报成本(cost),
-- 在 handleEvent 收到 usage_update 时回写,使「重新打开会话」能恢复 token 占比,而非清零。
ALTER TABLE sessions ADD COLUMN used_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN size_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN cost REAL NOT NULL DEFAULT 0;
