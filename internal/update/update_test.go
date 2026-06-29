package update

import "testing"

func TestShouldAutoCheck(t *testing.T) {
	cases := []struct {
		name string
		ver  string
		want bool
	}{
		{"empty disabled", "", false},
		{"dev disabled", "dev", false},
		{"release enabled", "0.1.0", true},
		{"release with v stripped elsewhere enabled", "1.2.3", true},
		{"dirty post-tag enabled", "0.1.0-3-gabc", true},
		{"commit-hash enabled", "abc1234", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ShouldAutoCheck(c.ver); got != c.want {
				t.Fatalf("ShouldAutoCheck(%q) = %v, want %v", c.ver, got, c.want)
			}
		})
	}
}

// newProvider 用项目常量构造 provider,应始终成功(const 仓库合法)。
func TestNewProviderSucceeds(t *testing.T) {
	p, err := newProvider()
	if err != nil {
		t.Fatalf("newProvider: unexpected error: %v", err)
	}
	if p == nil {
		t.Fatal("newProvider: nil provider")
	}
	if got := p.Name(); got != "github" {
		t.Fatalf("provider name = %q, want github", got)
	}
}

// 项目常量本身应格式正确(便于及早发现拼写错误)。
func TestConstantsWellFormed(t *testing.T) {
	if !contains(GitHubRepository, "/") {
		t.Fatalf("GitHubRepository %q must be owner/repo", GitHubRepository)
	}
	if ChecksumAsset == "" {
		t.Fatal("ChecksumAsset must be set")
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
