-- 0012_user_harnesses.sql
-- 用户自添加的 ACP harness(声明即用流程:命令 + 自检 + 体检单 + 添加)。
--
-- 与内置 harness(harness.Supported/Registry,Go 变量)并列:用户在「添加 harness」弹窗里填
-- ID / 名称 / stdio ACP 启动命令,经 ProbeHarness 自检(ConformanceReport.CanAdd)通过后落库一行。
-- 启动时 service 层把它和内置项合并成完整 harness 列表(harness.SetUserHarnesses 灌进内存合并视图)。
--
-- 为什么用 SQLite 表而不是 JSON 文件:与其他业务实体(session/project/permission)一致走 store
-- 唯一入口(§2.1),享受事务/迁移/并发安全,避免再多一份 JSON 文件持久化(§1.5 本地是真相)。
--
-- 字段:
--   id         harness 标识(如 "junie"),与 session.harness 对齐。调用方负责不与内置 id 冲突。
--   name       显示名(用户给定)。
--   command    stdio ACP 启动命令(如 "junie acp")。第一段是可执行文件(进程回收据此识别,§3.2)。
--   icon       图标资源路径或内联;空 = 走通用兜底(当前 UI 不采集,留字段向前兼容)。
--   created_at 创建时刻(毫秒)。
CREATE TABLE user_harnesses (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    command    TEXT NOT NULL,
    icon       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
