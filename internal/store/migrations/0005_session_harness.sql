-- schema v5:每个 session 记录其使用的 harness(opencode/mino/omp)。
-- 新建会话时由用户选择(§2.1 harness 适配层)。旧 session 无此字段,默认 opencode(向后兼容)。
ALTER TABLE sessions ADD COLUMN harness TEXT NOT NULL DEFAULT 'opencode';
