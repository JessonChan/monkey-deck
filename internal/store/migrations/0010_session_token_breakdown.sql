-- schema v10:持久化 session token 明细(AGENTS.md §1.6 + Task #15138)。
-- PromptResponse.Usage(UNSTABLE)带 CachedRead/Write/Input/Output/Thought/Total 明细,
-- 在 Prompt 返回后回写,使「重新打开会话」能恢复明细,而非清零。
-- 与 used_tokens/size_tokens/cost(0003,streaming UsageUpdate)互补:明细只在 turn 结束时更新。
ALTER TABLE sessions ADD COLUMN cached_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN cached_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN thought_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0;
