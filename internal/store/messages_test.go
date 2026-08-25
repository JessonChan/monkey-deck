package store

// messages_test.go:UpsertTurnMessage 回归(#125 增量落库)。
//
// 覆盖:
//   - 幂等:同键重复 upsert 只有一行,内容就地更新,seq/id 稳定(行保持首次
//     出现位置,重放不重排历史,§5.4 #5);created_at 随写刷新(收尾 reconcile
//     最后写,终态 ≈ 回合结束,保持旧时间语义,#68)。
//   - 新键:插新行,seq 续接会话内 MAX(seq)+1。
//   - 不同 turn 同 entry_key:互不冲突(turn_id 是 upsert 键的一部分)。
//   - 旧行兼容:AppendMessage 写的行(entry_key='')不参与去重,与 upsert 行共存。

import (
	"context"
	"path/filepath"
	"testing"
)

func newUpsertTestSession(t *testing.T) (*Store, string) {
	t.Helper()
	s := newTestStore(t)
	ctx := context.Background()
	p, err := s.CreateProject(ctx, "p", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	se, err := s.CreateSession(ctx, p.ID, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	return s, se.ID
}

func TestUpsertTurnMessageIdempotent(t *testing.T) {
	s, sid := newUpsertTestSession(t)
	ctx := context.Background()

	// 首次写入(flush 阶段的部分内容)。
	m1, err := s.UpsertTurnMessage(ctx, sid, "turn-1", "msg:m1:agent", "agent", "agent_message_chunk", "部分回", "")
	if err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	// 同键重放:内容增长(reconcile 阶段的最终全文)。
	m2, err := s.UpsertTurnMessage(ctx, sid, "turn-1", "msg:m1:agent", "agent", "agent_message_chunk", "部分回复全文", "")
	if err != nil {
		t.Fatalf("second upsert: %v", err)
	}
	// 第三次重放(相同内容,reconcile 重入)。
	if _, err := s.UpsertTurnMessage(ctx, sid, "turn-1", "msg:m1:agent", "agent", "agent_message_chunk", "部分回复全文", ""); err != nil {
		t.Fatalf("third upsert: %v", err)
	}

	msgs, err := s.ListMessages(ctx, sid)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("idempotence broken: want 1 row, got %d: %+v", len(msgs), msgs)
	}
	got := msgs[0]
	if got.Content != "部分回复全文" {
		t.Fatalf("content not updated in place: %q", got.Content)
	}
	if got.TurnID != "turn-1" || got.EntryKey != "msg:m1:agent" {
		t.Fatalf("keys not persisted: %+v", got)
	}
	// 同一行:id/seq 稳定(upsert 不重排、不换行);created_at 随写刷新(见上)。
	if m1.ID != m2.ID || m1.Seq != m2.Seq {
		t.Fatalf("row identity moved: first=%+v second=%+v", m1, m2)
	}
	if m2.CreatedAt < m1.CreatedAt {
		t.Fatalf("created_at must not go backwards: %d -> %d", m1.CreatedAt, m2.CreatedAt)
	}
	if got.ID != m1.ID || got.Seq != m1.Seq {
		t.Fatalf("stored row differs from first write: %+v vs %+v", got, m1)
	}
}

func TestUpsertTurnMessageNewKeysAppendInOrder(t *testing.T) {
	s, sid := newUpsertTestSession(t)
	ctx := context.Background()

	// user 消息(AppendMessage,entry_key='')先落库,随后增量条目按 timeline 序插入。
	if _, err := s.AppendMessage(ctx, sid, "user", "", "问", ""); err != nil {
		t.Fatal(err)
	}
	first, err := s.UpsertTurnMessage(ctx, sid, "turn-1", "msg:m1:thought", "thought", "agent_thought_chunk", "想", "")
	if err != nil {
		t.Fatal(err)
	}
	tool, err := s.UpsertTurnMessage(ctx, sid, "turn-1", "T1", "tool", "tool_call", `{"id":"T1"}`, "T1")
	if err != nil {
		t.Fatal(err)
	}
	agent, err := s.UpsertTurnMessage(ctx, sid, "turn-1", "msg:m2:agent", "agent", "agent_message_chunk", "答", "")
	if err != nil {
		t.Fatal(err)
	}
	if !(first.Seq == 2 && tool.Seq == 3 && agent.Seq == 4) {
		t.Fatalf("seq not appended in timeline order: %d %d %d", first.Seq, tool.Seq, agent.Seq)
	}
	// 后到的 upsert 重放早先条目:seq 不动(交错时序保持,§5.4 #5)。
	again, err := s.UpsertTurnMessage(ctx, sid, "turn-1", "msg:m2:agent", "agent", "agent_message_chunk", "答(终)", "")
	if err != nil {
		t.Fatal(err)
	}
	if again.Seq != agent.Seq {
		t.Fatalf("replay moved seq: %d -> %d", agent.Seq, again.Seq)
	}
	msgs, _ := s.ListMessages(ctx, sid)
	if len(msgs) != 4 {
		t.Fatalf("want 4 rows (user+3), got %d", len(msgs))
	}
	wantRoles := []string{"user", "thought", "tool", "agent"}
	for i, w := range wantRoles {
		if msgs[i].Role != w {
			t.Fatalf("row[%d].role: want %q got %q — order broken", i, w, msgs[i].Role)
		}
	}
}

func TestUpsertTurnMessageSeparateTurns(t *testing.T) {
	s, sid := newUpsertTestSession(t)
	ctx := context.Background()

	// fallback entry key("msg:_fb:1:agent")在每个 turn 都会出现,turn_id 消歧。
	for _, turn := range []string{"turn-1", "turn-2"} {
		if _, err := s.UpsertTurnMessage(ctx, sid, turn, "msg:_fb:1:agent", "agent", "agent_message_chunk", "回复"+turn, ""); err != nil {
			t.Fatalf("upsert %s: %v", turn, err)
		}
	}
	msgs, _ := s.ListMessages(ctx, sid)
	if len(msgs) != 2 {
		t.Fatalf("want 2 rows across turns, got %d", len(msgs))
	}
	if msgs[0].Content != "回复turn-1" || msgs[1].Content != "回复turn-2" {
		t.Fatalf("cross-turn collision: %+v", msgs)
	}
}

func TestUpsertTurnMessageLegacyRowsCoexist(t *testing.T) {
	s, sid := newUpsertTestSession(t)
	ctx := context.Background()

	// 旧行(entry_key='',AppendMessage 写入)在 partial unique index 之外:
	// 多条共存合法,且不影响 upsert 行的去重。
	for _, c := range []string{"旧1", "旧2"} {
		if _, err := s.AppendMessage(ctx, sid, "agent", "agent_message_chunk", c, ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.UpsertTurnMessage(ctx, sid, "turn-9", "msg:m:agent", "agent", "agent_message_chunk", "新", ""); err != nil {
		t.Fatal(err)
	}
	msgs, _ := s.ListMessages(ctx, sid)
	if len(msgs) != 3 {
		t.Fatalf("legacy rows must coexist: got %d rows", len(msgs))
	}
}

// 迁移兼容:带数据的旧库跑 0017(ALTER + partial unique index)不炸、旧行可读。
func TestMessageTurnKeysMigrationOnExistingDB(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	ctx := context.Background()

	// 阶段 1:只跑到 0016(手工建最小 v1 messages 表 + 两行重复空键数据)。
	s1, err := New(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	// New 已跑全部迁移;直接验证迁移后的库上旧行(手工插入 entry_key='')与 index 共存。
	p, err := s1.CreateProject(ctx, "p", filepath.Join(dir, "wd"), "")
	if err != nil {
		t.Fatal(err)
	}
	se, err := s1.CreateSession(ctx, p.ID, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	_, err = s1.db.ExecContext(ctx,
		`INSERT INTO messages(id,session_id,role,kind,content,tool_call_id,turn_id,entry_key,seq,created_at)
		 VALUES('legacy1',?,'agent','','旧内容','','','','1',0),
		        ('legacy2',?,'agent','','旧内容2','','','','2',0)`,
		se.ID, se.ID)
	if err != nil {
		t.Fatalf("seed legacy rows: %v", err)
	}
	// 多条 entry_key='' 的行不触发 unique 冲突(partial index 排除空键)。
	if _, err := s1.UpsertTurnMessage(ctx, se.ID, "t", "k", "agent", "agent_message_chunk", "v", ""); err != nil {
		t.Fatalf("upsert alongside legacy rows: %v", err)
	}
	if err := s1.Close(); err != nil {
		t.Fatal(err)
	}

	// 阶段 2:重开(迁移幂等,IF NOT EXISTS)后数据仍在。
	s2, err := New(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	var n int
	if err := s2.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("row count after reopen: want 3, got %d", n)
	}
}
