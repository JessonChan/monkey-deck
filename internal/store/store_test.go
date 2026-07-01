package store

import (
	"context"
	"path/filepath"
	"testing"
)

// 测试用临时文件,不污染用户数据(AGENTS.md §5.2)。
func newTestStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	s, err := New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestProjectSessionMessageCRUD(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	// project
	p, err := s.CreateProject(ctx, "demo", "/tmp/demo", "anthropic/claude-3.5-sonnet")
	if err != nil {
		t.Fatal(err)
	}
	if p.ID == "" {
		t.Fatal("empty project id")
	}
	got, _ := s.GetProject(ctx, p.ID)
	if got == nil || got.Path != "/tmp/demo" {
		t.Fatalf("get project: %+v", got)
	}
	byPath, _ := s.GetProjectByPath(ctx, "/tmp/demo")
	if byPath == nil || byPath.ID != p.ID {
		t.Fatalf("get by path: %+v", byPath)
	}
	projs, _ := s.ListProjects(ctx)
	if len(projs) != 1 {
		t.Fatalf("list projects: %d", len(projs))
	}
	if err := s.UpdateProject(ctx, p.ID, "demo2", "openai/gpt-4o"); err != nil {
		t.Fatal(err)
	}

	// session
	sess, err := s.CreateSession(ctx, p.ID, "first chat", "anthropic/claude-3.5-sonnet", "opencode")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateSessionACP(ctx, sess.ID, "acp-sess-123", "t1"); err != nil {
		t.Fatal(err)
	}
	sess2, _ := s.GetSession(ctx, sess.ID)
	if sess2 == nil || sess2.ACPSession != "acp-sess-123" {
		t.Fatalf("session acp not saved: %+v", sess2)
	}
	sesss, _ := s.ListSessions(ctx, p.ID)
	if len(sesss) != 1 {
		t.Fatalf("list sessions: %d", len(sesss))
	}

	// messages
	m1, _ := s.AppendMessage(ctx, sess.ID, "user", "", "hello", "")
	m2, _ := s.AppendMessage(ctx, sess.ID, "agent", "agent_message_chunk", "hi there", "")
	if m1.Seq != 1 || m2.Seq != 2 {
		t.Fatalf("seq order: %d %d", m1.Seq, m2.Seq)
	}
	msgs, _ := s.ListMessages(ctx, sess.ID)
	if len(msgs) != 2 || msgs[0].Role != "user" {
		t.Fatalf("list messages: %+v", msgs)
	}

	// settings
	if err := s.SetSetting(ctx, "theme", "dark"); err != nil {
		t.Fatal(err)
	}
	v, _ := s.GetSetting(ctx, "theme")
	if v != "dark" {
		t.Fatalf("setting: %q", v)
	}
	missing, _ := s.GetSetting(ctx, "nope")
	if missing != "" {
		t.Fatalf("missing setting should be empty: %q", missing)
	}

	// cascade delete
	if err := s.DeleteProject(ctx, p.ID); err != nil {
		t.Fatal(err)
	}
	sesss2, _ := s.ListSessions(ctx, p.ID)
	msgs2, _ := s.ListMessages(ctx, sess.ID)
	if len(sesss2) != 0 || len(msgs2) != 0 {
		t.Fatalf("cascade delete failed: sessions=%d msgs=%d", len(sesss2), len(msgs2))
	}
}

// TestSessionUsagePersist 校验 token 用量快照的写入与读回(重开会话恢复占比,§1.6)。
func TestSessionUsagePersist(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	p, err := s.CreateProject(ctx, "demo", "/tmp/demo2", "zai/glm-4.6")
	if err != nil {
		t.Fatal(err)
	}
	sess, err := s.CreateSession(ctx, p.ID, "", "zai/glm-4.6", "opencode")
	if err != nil {
		t.Fatal(err)
	}

	// 新建时用量为 0。
	got, _ := s.GetSession(ctx, sess.ID)
	if got.UsedTokens != 0 || got.SizeTokens != 0 || got.Cost != 0 {
		t.Fatalf("new session usage should be zero: %+v", got)
	}

	// 回写用量快照,GetSession / ListSessions 都应读到。
	if err := s.UpdateSessionUsage(ctx, sess.ID, 12345, 200000, 0.0123); err != nil {
		t.Fatal(err)
	}
	got, _ = s.GetSession(ctx, sess.ID)
	if got.UsedTokens != 12345 || got.SizeTokens != 200000 || got.Cost != 0.0123 {
		t.Fatalf("usage not persisted via GetSession: %+v", got)
	}
	list, _ := s.ListSessions(ctx, p.ID)
	if len(list) != 1 || list[0].UsedTokens != 12345 || list[0].SizeTokens != 200000 || list[0].Cost != 0.0123 {
		t.Fatalf("usage not persisted via ListSessions: %+v", list)
	}
}

// TestListMessagesBefore 校验游标分页:beforeSeq<=0 取最新一页 + hasMore 探测;翻页取更早的。
func TestListMessagesBefore(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	p, err := s.CreateProject(ctx, "demo", "/tmp/pg", "m")
	if err != nil {
		t.Fatal(err)
	}
	sess, err := s.CreateSession(ctx, p.ID, "", "m", "opencode")
	if err != nil {
		t.Fatal(err)
	}
	// 插入 5 条消息(seq 1..5)。
	for i := 0; i < 5; i++ {
		if _, err := s.AppendMessage(ctx, sess.ID, "user", "", "msg", ""); err != nil {
			t.Fatal(err)
		}
	}

	// 第一页 limit=2:应返回 3 条(limit+1),前端据此判断 hasMore。
	page1, err := s.ListMessagesBefore(ctx, sess.ID, 0, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(page1) != 3 {
		t.Fatalf("page1 should return limit+1=3, got %d", len(page1))
	}
	if page1[0].Seq != 3 || page1[2].Seq != 5 {
		t.Fatalf("page1 seq order wrong: %d,%d,%d", page1[0].Seq, page1[1].Seq, page1[2].Seq)
	}

	// 第二页:取 seq<3 的,limit=2 → 应返回 2 条(seq 1,2),hasMore=false。
	page2, err := s.ListMessagesBefore(ctx, sess.ID, 3, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(page2) != 2 {
		t.Fatalf("page2 should return 2, got %d", len(page2))
	}
	if page2[0].Seq != 1 || page2[1].Seq != 2 {
		t.Fatalf("page2 seq order wrong: %d,%d", page2[0].Seq, page2[1].Seq)
	}

	// 空页:seq<1 → 0 条。
	empty, err := s.ListMessagesBefore(ctx, sess.ID, 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(empty) != 0 {
		t.Fatalf("expected 0 messages before seq=1, got %d", len(empty))
	}
}

// TestListUserMessages 校验:只取 role=user 的文本,按 seq 升序,无长度限制。
func TestListUserMessages(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	p, err := s.CreateProject(ctx, "demo", "/tmp/um", "m")
	if err != nil {
		t.Fatal(err)
	}
	sess, err := s.CreateSession(ctx, p.ID, "", "m", "opencode")
	if err != nil {
		t.Fatal(err)
	}
	// 交替插 user / agent 消息。
	s.AppendMessage(ctx, sess.ID, "user", "", "第一句", "")
	s.AppendMessage(ctx, sess.ID, "agent", "agent_message_chunk", "回复1", "")
	s.AppendMessage(ctx, sess.ID, "user", "", "第二句", "")
	s.AppendMessage(ctx, sess.ID, "agent", "agent_message_chunk", "回复2", "")

	got, err := s.ListUserMessages(ctx, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 user messages, got %d (%v)", len(got), got)
	}
	if got[0] != "第一句" || got[1] != "第二句" {
		t.Fatalf("user messages order wrong: %v", got)
	}

	// 空 session / 不存在 session 返回空切片无错。
	got2, err := s.ListUserMessages(ctx, "nope")
	if err != nil {
		t.Fatal(err)
	}
	if len(got2) != 0 {
		t.Fatalf("expected empty for nonexistent session, got %v", got2)
	}
}

// TestSessionPromptedAtSort 校验侧栏排序键:prompted_at DESC → updated_at DESC(§1.4 排序策略)。
// 核心断言:用户发消息(TouchPrompted)让 session 跳顶,后台活动(UpdateSessionUsage/UpdateSessionTitle)
// 不动 prompted_at、只动 updated_at,后台 session 不会盖掉最近被用户 prompt 过的 session。
func TestSessionPromptedAtSort(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	p, err := s.CreateProject(ctx, "demo", "/tmp/sort", "m/m")
	if err != nil {
		t.Fatal(err)
	}

	a, _ := s.CreateSession(ctx, p.ID, "A", "m/m", "opencode")
	b, _ := s.CreateSession(ctx, p.ID, "B", "m/m", "opencode")
	c, _ := s.CreateSession(ctx, p.ID, "C", "m/m", "opencode")

	// 初始顺序:三者都刚 CreateSession(prompted_at=now),按 created_at 细分应是 C,B,A;
	// 但同一毫秒内不稳定,故只断言数量,不做顺序断言。
	list, _ := s.ListSessions(ctx, p.ID)
	if len(list) != 3 {
		t.Fatalf("expected 3 sessions, got %d", len(list))
	}

	// 模拟「A 是较早被用户发消息的」:显式把 A 的 prompted_at 压低(老会话)。
	if _, err := s.db.ExecContext(ctx, `UPDATE sessions SET prompted_at=? WHERE id=?`, 1000, a.ID); err != nil {
		t.Fatal(err)
	}

	// 模拟后台活动:b 收到 usage_update / 标题同步 → 只动 updated_at,不动 prompted_at。
	// 这里把 b 的 updated_at 抬到非常大,但 prompted_at 保持 CreateSession 时的值。
	if _, err := s.db.ExecContext(ctx, `UPDATE sessions SET updated_at=? WHERE id=?`, 9_999_999, b.ID); err != nil {
		t.Fatal(err)
	}

	// 模拟「C 是最近被用户 prompt 的」:TouchPrompted 把 C 的 prompted_at 抬到 now(最大)。
	if err := s.TouchPrompted(ctx, c.ID); err != nil {
		t.Fatal(err)
	}

	list, _ = s.ListSessions(ctx, p.ID)
	// 期望:C(最近 prompted) > b(prompted_at 仍是 CreateSession 值,但 updated_at 大) > A(prompted_at 压到 1000)。
	if list[0].ID != c.ID {
		t.Fatalf("expected C on top (most recently prompted), got %s; order=%v", list[0].ID, sessionIDs(list))
	}
	if list[len(list)-1].ID != a.ID {
		t.Fatalf("expected A at bottom (oldest prompted_at), got %s; order=%v", list[len(list)-1].ID, sessionIDs(list))
	}
	// 关键:b 的 updated_at 虽然是 9_999_999,但 C 的 prompted_at 更大,排序优先 → C 在 b 之上。
	// 这证明后台活动(updated_at)不能盖过用户 prompt(prompted_at)。
	if list[1].ID != b.ID {
		t.Fatalf("expected B in middle, got %s; order=%v", list[1].ID, sessionIDs(list))
	}
}

func sessionIDs(ss []Session) []string {
	out := make([]string, len(ss))
	for i, x := range ss {
		out[i] = x.ID
	}
	return out
}

// TestSearchSessionIDsByContent 校验会话内容搜索:大小写不敏感、按项目隔离、去重、空结果。
func TestSearchSessionIDsByContent(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	p, _ := s.CreateProject(ctx, "demo", "/tmp/demo", "m")
	p2, _ := s.CreateProject(ctx, "other", "/tmp/other", "m")
	s1, _ := s.CreateSession(ctx, p.ID, "first", "m", "opencode")
	s2, _ := s.CreateSession(ctx, p.ID, "second", "m", "opencode")
	s3, _ := s.CreateSession(ctx, p2.ID, "other-proj", "m", "opencode")

	s.AppendMessage(ctx, s1.ID, "user", "", "Hello World", "")
	s.AppendMessage(ctx, s1.ID, "agent", "agent_message_chunk", "FIX the bug now", "")
	s.AppendMessage(ctx, s1.ID, "agent", "", "refactor the World module", "") // s1 第二条含 world,验去重
	s.AppendMessage(ctx, s2.ID, "user", "", "totally unrelated text", "")
	s.AppendMessage(ctx, s3.ID, "user", "", "Hello World", "") // 同文但属另一项目,不应命中

	// 大小写不敏感 + 项目隔离:搜 hello 只命中 s1(p 内),不含 p2 的 s3。
	got, _ := s.SearchSessionIDsByContent(ctx, p.ID, "hello")
	if len(got) != 1 || got[0] != s1.ID {
		t.Fatalf("search hello in p: %+v", got)
	}
	// 搜 fix(小写)命中含 "FIX" 的 s1。
	got, _ = s.SearchSessionIDsByContent(ctx, p.ID, "fix")
	if len(got) != 1 || got[0] != s1.ID {
		t.Fatalf("case-insensitive fix: %+v", got)
	}
	// 跨项目:在 p2 搜 hello 命中 s3。
	got, _ = s.SearchSessionIDsByContent(ctx, p2.ID, "hello")
	if len(got) != 1 || got[0] != s3.ID {
		t.Fatalf("search hello in p2: %+v", got)
	}
	// 无命中返回空切片(非 nil 也允许,关键是长度 0)。
	got, _ = s.SearchSessionIDsByContent(ctx, p.ID, "zzz")
	if len(got) != 0 {
		t.Fatalf("no match should be empty: %+v", got)
	}
	// 多消息同 session 只返回一次(去重):搜命中 s1 两条消息,仍只一个 id。
	got, _ = s.SearchSessionIDsByContent(ctx, p.ID, "world") // s1 两条含 world,s2/s3 无(去重)
	if len(got) != 1 || got[0] != s1.ID {
		t.Fatalf("dedup within session: %+v", got)
	}
}
