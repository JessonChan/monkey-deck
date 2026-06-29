-- schema v4:项目级「允许访问外部目录」(权限裁决记忆,AGENTS.md §3.4)。
-- 用户在权限弹窗选「本项目允许」时写入;该项目的 session 启动时由 service 读出,
-- 加载进 handler——命中即对外部目录读取请求自动放行(不弹窗、不等)。
-- opencode 写盘不触发 request_permission(RAK §16.5),弹的基本都是外部目录读取,
-- 故单一布尔列足以覆盖实际场景。
ALTER TABLE projects ADD COLUMN allow_external_dir INTEGER NOT NULL DEFAULT 0;
