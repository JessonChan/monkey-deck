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
	sess, err := s.CreateSession(ctx, p.ID, "first chat", "anthropic/claude-3.5-sonnet")
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
