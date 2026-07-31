-- 0014_mcp_servers.sql
-- MCP server 全局 catalog(AGENTS.md §1.5:SQLite 是唯一真相来源)。
--
-- 设计:monkey-deck 不发现/监听任何盘上 .mcp.json(用户明确否决自动发现);MCP server 定义
-- 全部落本表。用户可手填,或一键导入 harness 的配置(opencode opencode.json 的 mcp 段 /
-- OMP .mcp.json 的 mcpServers 段)—— 导入是一次性用户动作、解析进本表、文件即弃,不是发现。
--
-- 作用域:本表是「全局定义 + 默认开关」。某次会话「用哪几个」由 session_mcp(0015)决定,
-- 在 NewSession 时勾选(预勾 = 本表 default_enabled=1 的)。会话失败时用户在勾选框里取消,
-- 不改本表(本次不选,catalog 原样)。
--
-- 字段:
--   id              主键(uuid)。
--   name            MCP server 名(ACP 注入时填 Name;unique)。
--   transport       'stdio' | 'http' | 'sse'。
--   command         stdio 可执行文件(如 "npx");http/sse 留空。
--   args            stdio 参数(JSON 数组,如 ["-y","@pkg"]);http/sse 留空数组。
--   env             stdio 环境变量(JSON map,明文存 key/value,§1.5 本地是真相;UI 脱敏展示)。
--   url             http/sse 端点;stdio 留空。
--   headers         http/sse 请求头(JSON map,明文存)。
--   default_enabled 1=新建会话默认勾选,0=默认不勾。
--   created_at/updated_at 毫秒。
--
-- 字段丢失说明:OMP 的 cwd/timeout/auth/oauth 在 ACP 协议与本表都无对应(协议只承传输字段),
-- 导入时静默丢弃 cwd/timeout、对 auth/oauth 告警(ACP 注入鉴权不了)。
CREATE TABLE mcp_servers (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    transport       TEXT NOT NULL,                  -- 'stdio' | 'http' | 'sse'
    command         TEXT NOT NULL DEFAULT '',       -- stdio executable
    args            TEXT NOT NULL DEFAULT '[]',     -- stdio args (JSON array)
    env             TEXT NOT NULL DEFAULT '{}',     -- stdio env (JSON map; plaintext)
    url             TEXT NOT NULL DEFAULT '',       -- http/sse endpoint
    headers         TEXT NOT NULL DEFAULT '{}',     -- http/sse headers (JSON map; plaintext)
    default_enabled INTEGER NOT NULL DEFAULT 1,     -- 1=checked by default in NewSession
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
