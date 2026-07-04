-- schema v8:session 置顶(用户要求:置顶后该会话恒在项目列表顶部)。
-- 单一布尔列;ListSessions 排序变为 pinned DESC, prompted_at DESC, updated_at DESC
-- —— 置顶组恒在未置顶组之上,组内仍按「最近发消息」排,心智一致。
-- 默认 0(未置顶),现有 session 行为不变。置顶不是内容活动,SetSessionPinned 不动 updated_at。
ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
