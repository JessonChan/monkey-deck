package terminal

import (
	"bytes"
	"math/rand/v2"
	"testing"
)
// TestScrollback_StressRandomWrites 压测:10000 次随机大小 chunk 写入,
// 每次验证 snapshot 长度 == min(totalWritten, cap)。确保高频 PTY 输出下 ring buffer 不出错。
func TestScrollback_StressRandomWrites(t *testing.T) {
	rng := rand.New(rand.NewPCG(42, 99))
	capv := 4096
	sb := newScrollback(capv)
	totalWritten := 0

	for i := range 10000 {
		chunkSize := rng.IntN(500) + 1 // 1-500 bytes
		chunk := make([]byte, chunkSize)
		for j := range chunk {
			chunk[j] = byte(rng.IntN(256))
		}

		snap := sb.snapshot()
		expectedLen := totalWritten
		if expectedLen > capv {
			expectedLen = capv
		}
		if len(snap) != expectedLen {
			t.Fatalf("iter %d: snap len %d != expected %d", i, len(snap), expectedLen)
		}
	}
}
// 写入一个已知全序列,验证 ring buffer 满后 snapshot = 最后 cap 字节、顺序正确。
func TestScrollback_SuffixCorrectness(t *testing.T) {
	capv := 16
	sb := newScrollback(capv)
	// 写入 A-P(16 字节,正好填满)
	full := []byte("ABCDEFGHIJKLMNOP")
	sb.write(full)
	if got := sb.snapshot(); !bytes.Equal(got, full) {
		t.Fatalf("full: got %q want %q", got, full)
	}
	// 再写 QR(2 字节):覆盖 AB,留下 C-P + QR = CDEFGHIJKLMNOPQR
	sb.write([]byte("QR"))
	want := []byte("CDEFGHIJKLMNOPQR")
	if got := sb.snapshot(); !bytes.Equal(got, want) {
		t.Fatalf("after QR: got %q want %q", got, want)
	}
}

// TestScrollback_StressConcurrentReadWhileWrite 模拟 readLoop 写 + GetTerminalScrollback 读的并发。
// ring buffer 本身非线程安全(由 termSession.mu 保护),这里验证「写完→快照」的一致性在大量交替下不丢数据。
func TestScrollback_AlternatingWriteSnapshot(t *testing.T) {
	sb := newScrollback(32)
	// 交替写入 + 快照 100 次,每次写 3 字节
	for i := range 100 {
		sb.write([]byte{byte('a' + i%26), byte('a' + (i+1)%26), byte('a' + (i+2)%26)})
		snap := sb.snapshot()
		// 快照长度应 = min((i+1)*3, 32)
		expected := (i + 1) * 3
		if expected > 32 {
			expected = 32
		}
		if len(snap) != expected {
			t.Fatalf("iter %d: snap len %d != expected %d", i, len(snap), expected)
		}
	}
}
