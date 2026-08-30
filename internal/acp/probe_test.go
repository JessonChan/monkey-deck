package acp

// probe_test.go:ConformanceReport 的纯函数测试(CanAdd 门槛 + Summary 渲染)。
// ProbeHarness 自身需 spawn 真 harness,归 integration 测试(§5.1),不在此覆盖。

import (
	"strings"
	"testing"
)

// TestCanAdd_AllTier1Pass Tier1 四项全过 → CanAdd 为真。
func TestCanAdd_AllTier1Pass(t *testing.T) {
	r := ConformanceReport{
		Initialized: CheckResult{Pass: true},
		NewSession:  CheckResult{Pass: true},
		Streamed:    CheckResult{Pass: true},
		PromptTurn:  CheckResult{Pass: true},
	}
	if !r.CanAdd() {
		t.Fatalf("CanAdd()=false, want true when all Tier1 pass")
	}
}

// TestCanAdd_AnyTier1Fail Tier1 任一不过 → CanAdd 为假(严格门槛)。
func TestCanAdd_AnyTier1Fail(t *testing.T) {
	base := ConformanceReport{
		Initialized: CheckResult{Pass: true},
		NewSession:  CheckResult{Pass: true},
		Streamed:    CheckResult{Pass: true},
		PromptTurn:  CheckResult{Pass: true},
	}
	cases := []struct {
		name string
		mut  func(*ConformanceReport)
	}{
		{"init fail", func(r *ConformanceReport) { r.Initialized.Pass = false }},
		{"session fail", func(r *ConformanceReport) { r.NewSession.Pass = false }},
		{"stream fail", func(r *ConformanceReport) { r.Streamed.Pass = false }},
		{"turn fail", func(r *ConformanceReport) { r.PromptTurn.Pass = false }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := base
			tc.mut(&r)
			if r.CanAdd() {
				t.Fatalf("CanAdd()=true, want false when %s", tc.name)
			}
		})
	}
}

// TestCanAdd_Tier2NeverBlocks 能力矩阵缺失(Resume/List/...全 false)不阻断 CanAdd。
func TestCanAdd_Tier2NeverBlocks(t *testing.T) {
	r := ConformanceReport{
		Initialized: CheckResult{Pass: true},
		NewSession:  CheckResult{Pass: true},
		Streamed:    CheckResult{Pass: true},
		PromptTurn:  CheckResult{Pass: true},
		// Tier2 全 false(能力矩阵缺失)。
	}
	if !r.CanAdd() {
		t.Fatalf("CanAdd()=false, Tier2 gaps must not block")
	}
}

// TestSummary_ContainsVerdict Summary 含结论行 + 命令;通过/不通过两种各验一次。
func TestSummary_ContainsVerdict(t *testing.T) {
	pass := ConformanceReport{
		Command:     "junie acp",
		AgentName:   "Junie",
		Initialized: CheckResult{Pass: true},
		NewSession:  CheckResult{Pass: true},
		Streamed:    CheckResult{Pass: true},
		PromptTurn:  CheckResult{Pass: true},
	}
	s := pass.Summary()
	if !strings.Contains(s, "junie acp") {
		t.Fatalf("pass summary missing command: %s", s)
	}
	if !strings.Contains(s, "可以添加") {
		t.Fatalf("pass summary missing ok verdict: %s", s)
	}

	fail := ConformanceReport{Command: "bad acp", AgentName: "Bad"}
	fs := fail.Summary()
	if !strings.Contains(fs, "不能添加") {
		t.Fatalf("fail summary missing fail verdict: %s", fs)
	}
}

// TestSummary_WarnsOnOptionalGaps 缺模型选择器/用量/思考流时 Summary 含「预警」。
func TestSummary_WarnsOnOptionalGaps(t *testing.T) {
	r := ConformanceReport{
		Command:     "x acp",
		AgentName:   "X",
		Initialized: CheckResult{Pass: true},
		NewSession:  CheckResult{Pass: true},
		Streamed:    CheckResult{Pass: true},
		PromptTurn:  CheckResult{Pass: true},
		// 三个可选功能全缺。
	}
	s := r.Summary()
	if !strings.Contains(s, "预警") {
		t.Fatalf("summary should warn on optional gaps: %s", s)
	}
	if !strings.Contains(s, "无模型选择器") || !strings.Contains(s, "不报 token 用量") || !strings.Contains(s, "无思考流") {
		t.Fatalf("summary missing specific gap warnings: %s", s)
	}
}

// TestSummary_ForkDeclared fork 探针行:declared 显示逐项 marks;N/A 行显式标 n/a,不与 ✗ 混淆。
func TestSummary_ForkDeclared(t *testing.T) {
	r := ConformanceReport{Fork: ForkReport{
		Declared:    true,
		NewID:       CheckResult{Pass: true, Note: "source=fake-sess-1… fork=fake-sess-2…"},
		SourceAlive: CheckResult{Pass: true, Note: "end_turn"},
		InList:      CheckResult{Pass: false, Note: "N/A: session/list 未声明"},
	}}
	s := r.Summary()
	if !strings.Contains(s, "[fork] declared") {
		t.Fatalf("declared summary missing fork line: %s", s)
	}
	if !strings.Contains(s, "n/a") {
		t.Fatalf("N/A row must render n/a: %s", s)
	}
	if strings.Contains(s, "forced-fork") {
		t.Fatalf("declared agent must not show forced-fork line: %s", s)
	}
}

// TestSummary_ForkForced undeclared:Summary 显示强 fork 锚定串与分类。
func TestSummary_ForkForced(t *testing.T) {
	r := ConformanceReport{Fork: ForkReport{
		Force:      "forced-fork: -32601 method not found: session/fork",
		ForceClass: "method-not-found",
	}}
	s := r.Summary()
	if !strings.Contains(s, "forced-fork: -32601 method not found: session/fork") {
		t.Fatalf("forced summary missing anchored error: %s", s)
	}
	if !strings.Contains(s, "method-not-found") {
		t.Fatalf("forced summary missing error class: %s", s)
	}
}
