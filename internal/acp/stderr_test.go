package acp

// stderr_test.go:stderrRing 环形缓冲的行为单测(白盒,同包可直接构造小缓冲)。
// 覆盖:容量内写入、精确填满、超容丢弃最老、多次环绕、Tail 长度、tee 镜像、空缓冲。
// 不启真 harness —— 纯数据结构测试。

import (
	"bytes"
	"io"
	"strings"
	"testing"
)

// newTestRing 构造指定容量的 ring(白盒),绕开 newStderrRing 的固定 32KiB 容量以便小缓冲测溢出。
// tee 为 io.Writer(nil = 纯捕获不镜像),避免 *bytes.Buffer 的 typed-nil 坑。
func newTestRing(cap int, tee io.Writer) *stderrRing {
	return &stderrRing{buf: make([]byte, cap), tee: tee}
}

func TestStderrRingUnderCap(t *testing.T) {
	r := newTestRing(16, nil)
	r.Write([]byte("abc"))
	if got := r.Snapshot(); got != "abc" {
		t.Fatalf("snapshot = %q, want %q", got, "abc")
	}
	if got := r.Tail(2); got != "bc" {
		t.Fatalf("tail(2) = %q, want %q", got, "bc")
	}
	if got := r.Tail(100); got != "abc" { // 超过已存量 → 全部
		t.Fatalf("tail(100) = %q, want %q", got, "abc")
	}
	if got := r.Tail(0); got != "" {
		t.Fatalf("tail(0) = %q, want empty", got)
	}
}

func TestStderrRingExactCap(t *testing.T) {
	r := newTestRing(5, nil)
	r.Write([]byte("hello"))
	if got := r.Snapshot(); got != "hello" {
		t.Fatalf("snapshot = %q, want %q", got, "hello")
	}
}

// TestStderrRingOverflow 单次写入超过容量:只保留尾部(根因总在最后)。
func TestStderrRingOverflow(t *testing.T) {
	r := newTestRing(5, nil)
	r.Write([]byte("hello world")) // 11 字节,容量 5 → 保留末 5 字节 "world"... 实际是 "world"?
	want := "world"                 // 末 5 字节
	if got := r.Snapshot(); got != want {
		t.Fatalf("snapshot = %q, want %q", got, want)
	}
}

// TestStderrRingWrapAround 多次小写入累计超容:验证环绕写入正确(最老被丢弃,顺序保持)。
func TestStderrRingWrapAround(t *testing.T) {
	r := newTestRing(4, nil)
	r.Write([]byte("AB")) // buf: AB.. (size 2)
	r.Write([]byte("CD")) // buf: ABCD (size 4,满)
	r.Write([]byte("EF")) // 溢出 2 → 丢最老 AB,留 CDEF
	if got := r.Snapshot(); got != "CDEF" {
		t.Fatalf("snapshot = %q, want %q", got, "CDEF")
	}
	r.Write([]byte("GHIJ")) // 4 字节,满容 → 全替换为 GHIJ
	if got := r.Snapshot(); got != "GHIJ" {
		t.Fatalf("snapshot = %q, want %q", got, "GHIJ")
	}
}

// TestStderrRingWrapOrder 多次写入后顺序仍正确(覆盖环绕读路径)。
func TestStderrRingWrapOrder(t *testing.T) {
	r := newTestRing(3, nil)
	for _, s := range []string{"a", "b", "c", "d", "e"} {
		r.Write([]byte(s))
	}
	// 写入序列 abcde,容量 3 → 保留 cde
	if got := r.Snapshot(); got != "cde" {
		t.Fatalf("snapshot = %q, want %q", got, "cde")
	}
	if got := r.Tail(2); got != "de" {
		t.Fatalf("tail(2) = %q, want %q", got, "de")
	}
}

// TestStderrRingTee 验证 tee 收到全量(非仅尾部)—— 保留「stderr 直通 os.Stderr」的既有行为。
func TestStderrRingTee(t *testing.T) {
	var tee bytes.Buffer
	r := newTestRing(4, &tee)
	r.Write([]byte("hello world")) // ring 只留 "orld",但 tee 应收全量
	if got := tee.String(); got != "hello world" {
		t.Fatalf("tee = %q, want full %q", got, "hello world")
	}
	if got := r.Snapshot(); got != "orld" {
		t.Fatalf("snapshot = %q, want %q", got, "orld")
	}
}

// TestStderrRingEmptyWrite 空写入不 panic、不改状态。
func TestStderrRingEmptyWrite(t *testing.T) {
	r := newTestRing(4, nil)
	r.Write([]byte(""))
	if got := r.Snapshot(); got != "" {
		t.Fatalf("empty write: snapshot = %q, want empty", got)
	}
}

// TestStderrRingWriteReturnsOrigLen Write 返回原始 p 长度(io.Writer 契约),即使超容截断。
func TestStderrRingWriteReturnsOrigLen(t *testing.T) {
	r := newTestRing(2, nil)
	n, err := r.Write([]byte("abcdef"))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if n != 6 {
		t.Fatalf("returned n = %d, want 6 (orig len)", n)
	}
}

// TestStderrRingBigChunkAcrossWrap 验证一次写入跨过缓冲末尾再环绕,内容顺序正确。
func TestStderrRingBigChunkAcrossWrap(t *testing.T) {
	r := newTestRing(5, nil)
	r.Write([]byte("abc"))     // buf: abc.. size 3
	r.Write([]byte("DEFGH"))   // 5 字节,从 pos 3 起:buf[3:5]=DE, 环绕 buf[0:3]=FGH → size 满,溢出 3 丢 abc
	want := "DEFGH"             // 结果 D E F G H 顺序
	if got := r.Snapshot(); got != want {
		t.Fatalf("snapshot = %q, want %q", got, want)
	}
}

// TestStderrRingDefaultCap 验证生产构造器用固定容量(stderrRingCap),且默认 tee 工作正常。
func TestStderrRingDefaultCap(t *testing.T) {
	var tee bytes.Buffer
	r := newStderrRing(&tee)
	payload := strings.Repeat("x", stderrRingCap+100)
	r.Write([]byte(payload))
	// 环只保留尾部 stderrRingCap 字节
	if got := len(r.Snapshot()); got != stderrRingCap {
		t.Fatalf("snapshot len = %d, want %d", got, stderrRingCap)
	}
	if got := r.Tail(3); got != "xxx" {
		t.Fatalf("tail(3) = %q, want xxx", got)
	}
	// tee 收全量
	if got := tee.Len(); got != len(payload) {
		t.Fatalf("tee len = %d, want full %d", got, len(payload))
	}
}
