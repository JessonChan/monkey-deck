-- schema v2:每个 session 一个 git worktree(独立分支 + 工作目录)。
-- worktree_path:worktree 在磁盘上的路径(session 的 cwd 锚点);空 = 非 git 项目,用项目目录本身。
-- branch:该 session 对应的 git 分支名(merge/清理用)。
ALTER TABLE sessions ADD COLUMN worktree_path TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN branch TEXT NOT NULL DEFAULT '';
