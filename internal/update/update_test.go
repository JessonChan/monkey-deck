package update

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/github"
)

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

func TestArchiveOnlyAssetMatcher(t *testing.T) {
	assets := []github.ReleaseAsset{
		{Name: "SHA256SUMS"},
		{Name: "monkey-deck-linux-amd64.deb"},
		{Name: "monkey-deck-linux-amd64.rpm"},
		{Name: "monkey-deck-linux-arm64.deb"},
		{Name: "monkey-deck-linux-arm64.rpm"},
		{Name: "monkey-deck-darwin-arm64.zip"},
		{Name: "monkey-deck-darwin-amd64.zip"},
		{Name: "monkey-deck-linux-amd64.zip"},
	}
	pick := func(plat, arch string) string {
		idx := archiveOnlyAssetMatcher(updater.CheckRequest{Platform: plat, Arch: arch}, assets)
		if idx < 0 {
			return ""
		}
		return assets[idx].Name
	}
	cases := []struct {
		name       string
		plat, arch string
		want       string
	}{
		{"linux amd64 picks zip not deb", "linux", "amd64", "monkey-deck-linux-amd64.zip"},
		{"linux arm64 no archive → none", "linux", "arm64", ""},
		{"darwin arm64 zip", "darwin", "arm64", "monkey-deck-darwin-arm64.zip"},
		{"darwin amd64 zip", "darwin", "amd64", "monkey-deck-darwin-amd64.zip"},
		{"x86_64 alias matches amd64 asset", "linux", "x86_64", "monkey-deck-linux-amd64.zip"},
		{"aarch64 alias matches arm64 asset", "linux", "aarch64", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := pick(c.plat, c.arch); got != c.want {
				t.Fatalf("matcher(%s/%s) = %q, want %q", c.plat, c.arch, got, c.want)
			}
		})
	}
}
