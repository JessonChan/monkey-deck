-- 0015_session_mcp.sql
-- 每个 session 实际选用哪些 MCP server(per-session 选择,0014 catalog 的子集)。
--
-- 写入时机:CreateSession 时,前端 NewSessionModal 把勾选的 mcp_server_id 列表传来,落本表。
-- 读取时机:startLive(spawn harness)前,按 session_id 拉出选择 → 关联 mcp_servers → 转 ACP
-- McpServer → 注入 session/new | session/resume(三入口之一的 new/resume 在此;load 走 resume 语义)。
--
-- 不用外键:与项目内其它表一致(modernc.org/sqlite 默认不强制 FK),靠应用层保证 mcp_server_id 存在。
-- 语义:行存在 = 该 session 用这个 server;无行 = 不用。改 MCP 需新建 session(ACP 在 session/new 钉死)。
CREATE TABLE session_mcp (
    session_id    TEXT NOT NULL,
    mcp_server_id TEXT NOT NULL,
    PRIMARY KEY (session_id, mcp_server_id)
);
