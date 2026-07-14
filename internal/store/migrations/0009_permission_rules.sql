-- 分级访问控制规则表(AGENTS.md §3.4)。
-- 每条规则 = (工具名, 动作分组, 路径 glob, 命令正则) → 级别(allow/ask/deny)。
-- 空约束字段 = 通配;AND 语义;按 sort_order 升序逐条判定,首条命中者决定裁决。
-- 默认规则在首次读取(表空)时由 store.SeedDefaultPermissionRules 写入。
CREATE TABLE IF NOT EXISTS permission_rules (
    id              TEXT PRIMARY KEY,
    tool_name       TEXT NOT NULL DEFAULT '',        -- 匹配 ACP ToolKind;'' = 任意
    action_type     TEXT NOT NULL DEFAULT '',        -- read/write/exec/other/any;'' = any
    path_pattern    TEXT NOT NULL DEFAULT '',        -- glob;'' = 任意路径
    command_pattern TEXT NOT NULL DEFAULT '',        -- 正则(对抽取的命令);'' = 任意命令
    level           TEXT NOT NULL DEFAULT 'ask',     -- allow | ask | deny
    sort_order      INTEGER NOT NULL DEFAULT 0,      -- 小者先判定
    enabled         INTEGER NOT NULL DEFAULT 1,      -- 0=禁用 1=启用
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
