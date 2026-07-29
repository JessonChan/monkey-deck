package terminal

import (
	"bytes"
	"testing"
)

// TestScrollback_BasicAppend 未写满容量时按顺序留存全部。
func TestScrollback_BasicAppend(t *testing.T) {
	sb := newScrollback(16)
	sb.write([]byte("hello"))
	sb.write([]byte(" world"))
	got := sb.snapshot()
	if string(got) != "hello world" {
		t.Fatalf("want %q, got %q", "hello world", got)
	}
}

// TestScrollback_WrapOverwrite 写满后丢弃最旧、保留最新:核心不变量。
// replay 必须按写入顺序返回(不能乱序),且容量恒定。
func TestScrollback_WrapOverwrite(t *testing.T) {
	sb := newScrollback(8)
	// 写入 ABCDEFGH 正好填满(无覆盖)。
	sb.write([]byte("ABCDEFGH"))
	if got := sb.snapshot(); string(got) != "ABCDEFGH" {
		t.Fatalf("full: want %q, got %q", "ABCDEFGH", got)
	}
	// 再写 IJ → 覆盖 AB,留下 CDEFGHIJ(按写入顺序)。
	sb.write([]byte("IJ"))
	if got := sb.snapshot(); string(got) != "CDEFGHIJ" {
		t.Fatalf("wrap once: want %q, got %q", "CDEFGHIJ", got)
	}
	// 再写 KLMNOPQR(8 字节,正好覆盖一圈)→ 全部替换成 KLMNOPQR。
	sb.write([]byte("KLMNOPQR"))
	if got := sb.snapshot(); string(got) != "KLMNOPQR" {
		t.Fatalf("wrap exact: want %q, got %q", "KLMNOPQR", got)
	}
}

// TestScrollback_SingleWriteExceedsCap 单次写入超过容量:只留最后 cap 字节。
func TestScrollback_SingleWriteExceedsCap(t *testing.T) {
	sb := newScrollback(4)
	sb.write([]byte("ABCDEFGHIJ")) // 10 字节 > cap 4
	if got := sb.snapshot(); string(got) != "GHIJ" {
		t.Fatalf("oversized: want %q, got %q", "GHIJ", got)
	}
}

// TestScrollback_CrossBoundaryMultipleWraps 多次小写跨边界,验证 pos 跟踪正确。
func TestScrollback_CrossBoundaryMultipleWraps(t *testing.T) {
	sb := newScrollback(6)
	sb.write([]byte("ABC"))  // ABC___
	sb.write([]byte("DEF"))  // ABCDEF (满)
	sb.write([]byte("GH"))   // 覆盖 AB → CDEFGH
	if got := sb.snapshot(); string(got) != "CDEFGH" {
		t.Fatalf("after GH: want %q, got %q", "CDEFGH", got)
	}
	sb.write([]byte("IJKLMN")) // 6 字节正好一圈 → IJKLMN
	if got := sb.snapshot(); string(got) != "IJKLMN" {
		t.Fatalf("full replace: want %q, got %q", "IJKLMN", got)
	}
}

// TestScrollback_Empty 空快照安全(nil,不 panic)。
func TestScrollback_Empty(t *testing.T) {
	sb := newScrollback(16)
	if got := sb.snapshot(); got != nil {
		t.Fatalf("empty: want nil, got %q", got)
	}
	sb.write([]byte{})
	if got := sb.snapshot(); got != nil {
		t.Fatalf("empty write: want nil, got %q", got)
	}
}

// TestScrollback_SnapshotIsCopy 快照必须是副本:后续写入不影响已返回的快照。
func TestScrollback_SnapshotIsCopy(t *testing.T) {
	sb := newScrollback(16)
	sb.write([]byte("hello"))
	snap := sb.snapshot()
	sb.write([]byte(" world"))
	if !bytes.Equal(snap, []byte("hello")) {
		t.Fatalf("snapshot mutated after later write: got %q", snap)
	}
}
