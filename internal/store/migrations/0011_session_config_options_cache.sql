-- schema v11:持久化 session config options 快照(懒 spawn:只读态用缓存渲染 ModelSelect)。
-- agent 自报的 config options(model/mode/effort)在 spawn / config_option_update /
-- set_config_option / refresh config 时回写,使「只读打开历史会话」能从缓存渲染模型选择器,
-- 不依赖 harness 进程存活。JSON 序列化的扁平化 []ConfigOption。
ALTER TABLE sessions ADD COLUMN config_options_cache TEXT NOT NULL DEFAULT '';
