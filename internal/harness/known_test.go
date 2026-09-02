package harness

import "testing"

func TestMatchKnownHarness_AliasExact(t *testing.T) {
	got := MatchKnownHarness("claude")
	if got == nil || got.ID != "claude-agent" {
		t.Fatalf("expected claude-agent, got %+v", got)
	}
}

func TestMatchKnownHarness_NpxCommand(t *testing.T) {
	// User types a real launch command; alias must still match inside the string.
	got := MatchKnownHarness("npx @openai/codex")
	if got == nil || got.ID != "codex-cli" {
		t.Fatalf("expected codex-cli, got %+v", got)
	}
}

func TestMatchKnownHarness_FullID(t *testing.T) {
	got := MatchKnownHarness("github-copilot")
	if got == nil || got.ID != "github-copilot" {
		t.Fatalf("expected github-copilot, got %+v", got)
	}
}

func TestMatchKnownHarness_Empty(t *testing.T) {
	if MatchKnownHarness("") != nil {
		t.Fatal("empty command must not match")
	}
	if MatchKnownHarness("   ") != nil {
		t.Fatal("whitespace command must not match")
	}
}

func TestMatchKnownHarness_NoMatch(t *testing.T) {
	if MatchKnownHarness("vim") != nil {
		t.Fatal("unrelated command must not match")
	}
}

// Short alias must be whole-token only: "pi" must NOT match inside "shipping".
func TestMatchKnownHarness_ShortKeywordNoSubstring(t *testing.T) {
	got := MatchKnownHarness("shipping")
	if got != nil && got.ID == "pi" {
		t.Fatalf("short keyword 'pi' must not substring-match 'shipping', got %+v", got)
	}
}

func TestMatchKnownHarness_ShortKeywordWholeToken(t *testing.T) {
	got := MatchKnownHarness("npx @svkozak/pi-acp")
	if got == nil || got.ID != "pi" {
		t.Fatalf("expected pi via whole-token match, got %+v", got)
	}
}

// Longer/more-specific keyword wins over a shorter overlapping one.
func TestMatchKnownHarness_LongerWins(t *testing.T) {
	got := MatchKnownHarness("github-copilot")
	if got == nil || got.ID != "github-copilot" {
		t.Fatalf("expected github-copilot (specific) over short overlaps, got %+v", got)
	}
}

func TestKnownCatalog_ExcludesBuiltins(t *testing.T) {
	for _, kh := range KnownCatalog {
		if kh.ID == "omp" || kh.ID == "opencode" {
			t.Fatalf("KnownCatalog must not include builtins, found %s", kh.ID)
		}
	}
}
