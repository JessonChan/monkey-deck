-- schema v13:session 基线分支(worktree 显式基线)。
-- 记录 session 创建 worktree 时所基于的分支名(本地分支,如 main/develop);
-- 合并时合回此分支(从哪 checkout 就合回哪,对称且可控)。
-- 空 = 非 worktree session / 迁移前已存在的旧 session(沿用旧的「合到主仓库 HEAD」行为)。
ALTER TABLE sessions ADD COLUMN base_ref TEXT NOT NULL DEFAULT '';
