package acp

// proc_pgidfile_test.go:验证 pgidFile 持久化机制 —— 限定 KillAllHarnesses 只杀本应用残留,
// 不误杀用户在其它终端跑的 harness(AGENTS.md §3.2 + #21 修复;后通用化为 harness 无关)。
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

// TestIsHarnessCmdline 回归:此前 listOpencodeProcs 写死 "opencode acp",omp 以 `bun …/omp acp`
// 启动时被漏掉 → omp 孤儿从不被回收。验证现在按受支持命令子串匹配,覆盖 omp/opencode/goose 三形态。
// 不启真 harness,纯字符串匹配。
func TestIsHarnessCmdline(t *testing.T) {
	cmds := []string{"omp acp", "opencode acp", "goose acp"}
	cases := []struct {
		line string
		want bool
	}{
		{"  2938  2938  bun /path/to/omp acp", true},          // omp 经 bun wrapper,"omp acp" 子串命中
		{"  5251  5251  opencode acp", true},                  // opencode 裸命令
		{"  6100  6100  goose acp", true},                     // goose 裸命令
		{"  1234  1234  /usr/bin/ssh user@host", false},       // 无关进程
		{"  1234  1234  /usr/bin/python3 http.server", false}, // 无关进程
		{"  1234  1234  omp-compiler build", false},           // 子串 "omp acp" 不命中
	}
	for _, c := range cases {
		if got := isHarnessCmdline(c.line, cmds); got != c.want {
			t.Errorf("isHarnessCmdline(%q) = %v, want %v", c.line, got, c.want)
		}
	}
}

// TestListHarnessProcsEmptyConfig 未配置 harnessCmds(SetHarnessCommands 未调)时返回 nil ——
// 安全降级:不识别任何进程 = 不杀(宁可漏杀不误杀)。
func TestListHarnessProcsEmptyConfig(t *testing.T) {
	if got := listHarnessProcs(); got != nil {
		t.Fatalf("nil harnessCmds should yield nil, got %v", got)
	}
}
