-- schema v6:session 排序键拆分(AGENTS.md §1.4 session=目录锚点)。
-- prompted_at = 用户最后一次在该 session 发消息(prompt)的时刻,专用于侧栏排序:
--   - 只在用户发消息(SendMessage/startTurn)时刷新,后台 agent 活动(usage_update/标题同步/
--     工具返回)不刷新它 → 侧栏顺序由用户意图掌控,后台 session 跑完不抖动。
--   - 排序 ORDER BY prompted_at DESC, updated_at DESC;updated_at 作二级兜底
--     (新建 worktree/切 model 等无用户消息的变更仍能合理排位)。
-- backfill = updated_at,保持现有顺序不变(继承最后修改时间)。
ALTER TABLE sessions ADD COLUMN prompted_at INTEGER NOT NULL DEFAULT 0;
UPDATE sessions SET prompted_at = updated_at;
