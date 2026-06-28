package acp

// proc_pgidfile_test.go:验证 pgidFile 持久化机制 —— 限定 KillAllOpencode 只杀本应用残留,
// 不误杀用户在其它终端跑的 opencode(AGENTS.md §3.2 + 本次 #21 修复)。
//
// 不启真 harness:仅测文件读写 + 集合判定逻辑(register/unregister/isActive/readPgidFile)。

import (
	"os"
	"path/filepath"
	"testing"
)

// TestPgidFileRoundTrip 注册→落盘→重读,集合一致。
func TestPgidFileRoundTrip(t *testing.T) {
	dir := t.TempDir()
	SetPgidFile(filepath.Join(dir, "pgids.json"))
	t.Cleanup(func() { SetPgidFile("") })

	registerHarness(1001)
	registerHarness(1002)
	unregisterHarness(1001) // 模拟干净退出

	got := readPgidFile()
	if _, ok := got[1001]; ok {
		t.Fatalf("1001 should be removed, got %v", got)
	}
	if _, ok := got[1002]; !ok {
		t.Fatalf("1002 should remain, got %v", got)
	}
	if isActiveHarness(1002) != true {
		t.Fatalf("1002 should be active in-memory")
	}
	if isActiveHarness(1001) != false {
		t.Fatalf("1001 should not be active")
	}
}

// TestReadPgidFile_MissingOrCorrupt 文件缺失/损坏均返回空集(容错:宁可漏杀不误杀)。
func TestReadPgidFile_MissingOrCorrupt(t *testing.T) {
	dir := t.TempDir()
	SetPgidFile(filepath.Join(dir, "pgids.json"))
	t.Cleanup(func() { SetPgidFile("") })

	// 不存在 → 空集
	if got := readPgidFile(); len(got) != 0 {
		t.Fatalf("missing file should yield empty set, got %v", got)
	}
	// 损坏 JSON → 空集,不 panic
	if err := os.WriteFile(pgidFile, []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readPgidFile(); len(got) != 0 {
		t.Fatalf("corrupt file should yield empty set, got %v", got)
	}
}

// TestReadPgidFile_Disabled pgidFile 为空字符串时不启用(返回空集,register 不写盘)。
func TestReadPgidFile_Disabled(t *testing.T) {
	SetPgidFile("")
	t.Cleanup(func() { SetPgidFile("") })

	registerHarness(9999) // 无文件,不应 panic、不应落盘
	if got := readPgidFile(); len(got) != 0 {
		t.Fatalf("disabled should yield empty set, got %v", got)
	}
}
