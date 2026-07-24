-- 0012_user_harnesses.sql
-- 用户声明的 ACP harness(声明即用流程,见 docs/worklog/2026-07-24-probe-harness-acp-conformance-jcode-zero-code.md)。
--
-- 与内置 harness(harness.Supported/Registry,Go 变量)并列:用户通过"声明向导"提供
-- 启动命令(+可选图标),经 ProbeHarness 自检通过后落库。启动时与内置项合并成完整列表。
--
-- 字段:
--   id        harness 标识(如 "jcode"),与 session.harness 对齐。调用方负责不与内置 id 冲突。
--   name      显示名(取自 Initialize 的 AgentInfo.Name,或用户给定)。
--   command   stdio ACP 启动命令(如 "jcode acp")。
--   icon      图标资源路径或内联;空 = 走通用兜底(身份/审美地板)。
--   created_at 创建时刻(毫秒)。
CREATE TABLE user_harnesses (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    command    TEXT NOT NULL,
    icon       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
