-- schema v1:projects / sessions / messages / settings(AGENTS.md §1.4/§1.5)
-- 本地 SQLite 是唯一真相来源;无中央数据库。

-- 项目 = 磁盘目录(§1.4)。path 唯一:一个目录一个项目。
CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    path       TEXT NOT NULL UNIQUE,   -- 项目根目录(cwd 锚点)
    model      TEXT NOT NULL DEFAULT '', -- 默认 model(provider/model 格式,§3.5)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- session = ACP session,钉在 project 上。acp_session_id 用于 LoadSession 恢复(§1.4)。
CREATE TABLE IF NOT EXISTS sessions (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    acp_session_id TEXT NOT NULL DEFAULT '', -- opencode 的 session id(resume 用)
    title          TEXT NOT NULL DEFAULT '',
    model          TEXT NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);

-- 对话消息:role 区分 user/agent/thought/tool;seq 保证顺序。
CREATE TABLE IF NOT EXISTS messages (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role         TEXT NOT NULL,        -- user | agent | thought | tool
    kind         TEXT NOT NULL DEFAULT '', -- tool_call | tool_call_update | usage_update ...
    content      TEXT NOT NULL DEFAULT '',
    tool_call_id TEXT NOT NULL DEFAULT '',
    seq          INTEGER NOT NULL,
    created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

-- 应用配置(key-value)。
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);
