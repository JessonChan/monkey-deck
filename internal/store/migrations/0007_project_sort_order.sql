-- 项目手动排序:侧栏拖拽改顺序时全量重写 sort_order,
-- ListProjects 按 sort_order ASC, updated_at DESC。
-- 默认 0:全部 0 时兜底 updated_at DESC(继承原行为,顺序不变);
-- 一旦拖拽,全部赋值 0..N-1 进入纯手动排序模式。
-- CreateProject 设 sort_order = MIN-1(表空则 0),保证新建项目恒在顶部。
ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
