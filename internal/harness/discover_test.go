package harness

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeProbe2 测试用 Probe:LookPath 按 fakeBin 返回;Version 按 fakeVer 返回。
// 不真起进程,确定性。
//
// 用法见 TestDiscover_BasicAndInstalledFields。
type fakeProbe2 struct {
	paths map[string]string // BinaryName → abs path
	vers  map[string]string // BinaryName → version output(原始,会过 extractVersion)
}

func (f fakeProbe2) LookPath(bin string) (string, error) {
	if p, ok := f.paths[bin]; ok {
		return p, nil
	}
	return "", errNotFound
}

func (f fakeProbe2) Version(_ context.Context, bin string, _ []string) (string, error) {
	// Discover 在拿到 path 后才调 Version(path,...),但我们 fake 下不关心 path/args;
	// 通过 path 反查 BinaryName。setup 时把 path→bin 也存进 paths,这里反查。
	for b, p := range f.paths {
		if p == bin {
			if out, ok := f.vers[b]; ok {
				return extractVersion(out), nil
			}
		}
	}
	return "", errNotFound
}

// errNotFound 一个稳定的「未找到」哨兵 error(fakeProbe2 用)。
var errNotFound = mkNotFound()

func mkNotFound() error { return &notFoundErr{} }

type notFoundErr struct{}

func (*notFoundErr) Error() string { return "not found in fake probe" }

// stubSource 测试用 ReleaseSource,返回预设版本(可注入失败)。
type stubSource struct {
	v   string
	err error
}

func (s stubSource) Latest(_ context.Context) (Release, error) {
	if s.err != nil {
		return Release{}, s.err
	}
	return Release{Version: s.v}, nil
}

// TestExtractVersion 校验版本提取启发式覆盖主流输出形态。
func TestExtractVersion(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"opencode version 0.5.123\n", "0.5.123"},
		{"omp 1.2.3\n(build abc)\n", "1.2.3"},
		{"v3.0.0\n", "v3.0.0"},
		{"Version: 2.0.1-beta", "2.0.1-beta"},
		{"1.0", "1.0"},
		{"", ""},                 // 空 → 提取不到
		{"no version here!", ""}, // 无数字 token → 空
		{"ver 2.0 (build 9)", "2.0"},
		{"x.y.z 1.2.3", "1.2.3"}, // 取首个含数字段;x.y.z 无数字 → 跳过
	}
	for _, c := range cases {
		got := extractVersion(c.in)
		if got != c.want {
			t.Errorf("extractVersion(%q)=%q, want %q", c.in, got, c.want)
		}
	}
}

// TestCompareVersions 校验版本比较的数值语义 + 字符串 fallback。
func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.0.0", "1.0.0", 0},
		{"1.2.3", "1.2.4", -1},
		{"1.2.4", "1.2.3", 1},
		// 数值段优于字符串(10 > 9,不是 "10" < "9")。
		{"1.10.0", "1.9.0", 1},
		{"1.9.0", "1.10.0", -1},
		// 段数不同:短的较小(1.2 < 1.2.1)。
		{"1.2", "1.2.1", -1},
		{"1.2.1", "1.2", 1},
		// 前导 v 归一化。
		{"v1.0.0", "1.0.0", 0},
		{"V2.0", "2.0", 0},
		// 混合段(数值 vs 字符串)→ 字符串比较。
		{"1.2.3-beta", "1.2.3-rc", -1}, // "3-beta" < "3-rc"(字符串:'b'<'r');因非全数字段
	}
	for _, c := range cases {
		got := compareVersions(c.a, c.b)
		if got != c.want {
			t.Errorf("compareVersions(%q,%q)=%d, want %d", c.a, c.b, got, c.want)
		}
	}
}

// TestDiscover_BasicAndInstalledFields 用注入 Probe/Source 校验 Discovered 的派生字段:
// Installed/Path/InstalledVersion 命中;UpgradeAvailable 仅在「已装 + 有最新 + 当前<最新」时为真。
func TestDiscover_BasicAndInstalledFields(t *testing.T) {
	// backup + 还原全局 Probe/Registry,免污染其它测试。
	prevProbe := currentProbe()
	prevReg := Registry
	t.Cleanup(func() {
		SetProbe(prevProbe)
		Registry = prevReg
	})

	// 改 Registry:opencode 已装 + 旧版本 + 有新版;omp 未装 + 无 Source。
	// 用 absolute path 作伪可执行路径(Discover 不真跑它,只填字段)。
	opencodePath := "/fake/bin/opencode"
	Registry = []Spec{
		{
			ID:         "opencode",
			BinaryName: "opencode",
			Source:     stubSource{v: "1.5.0"},
		},
		{
			ID:         "omp",
			BinaryName: "omp",
			// 无 Source
		},
	}
	SetProbe(fakeProbe2{
		paths: map[string]string{"opencode": opencodePath},
		vers:  map[string]string{"opencode": "opencode version 1.4.0\n"},
	})

	out := Discover(context.Background())
	if len(out) != 2 {
		t.Fatalf("expected 2 entries, got %d: %+v", len(out), out)
	}

	// opencode:命中。
	oc := out[0]
	if oc.ID != "opencode" || !oc.Installed || oc.Path != opencodePath {
		t.Fatalf("opencode discovery wrong: %+v", oc)
	}
	if oc.InstalledVersion != "1.4.0" {
		t.Fatalf("opencode InstalledVersion=%q, want 1.4.0", oc.InstalledVersion)
	}
	if oc.LatestVersion != "1.5.0" {
		t.Fatalf("opencode LatestVersion=%q, want 1.5.0", oc.LatestVersion)
	}
	if !oc.UpgradeAvailable {
		t.Fatalf("opencode UpgradeAvailable=false, want true (1.4.0 < 1.5.0)")
	}
	// Name/Command 必须从 Supported 复制(单一事实源),不是空。
	if oc.Name == "" || oc.Command == "" {
		t.Fatalf("opencode Name/Command not copied from Supported: %+v", oc)
	}

	// opencode 同版本 → UpgradeAvailable=false。
	t.Run("same version", func(t *testing.T) {
		Registry[0].Source = stubSource{v: "1.4.0"}
		out2 := Discover(context.Background())
		if out2[0].UpgradeAvailable {
			t.Fatalf("UpgradeAvailable=true for same version, want false")
		}
	})

	// omp:未装。
	if out[1].Installed {
		t.Fatalf("omp should not be installed: %+v", out[1])
	}
	if out[1].LatestVersion != "" {
		t.Fatalf("omp LatestVersion=%q, want empty (no Source)", out[1].LatestVersion)
	}
	if out[1].UpgradeAvailable {
		t.Fatalf("omp UpgradeAvailable=true, want false")
	}
}

// TestDiscover_SourceErrorIgnored Source 报错时 LatestVersion 降级为空、不抛异常。
func TestDiscover_SourceErrorIgnored(t *testing.T) {
	prevProbe := currentProbe()
	prevReg := Registry
	t.Cleanup(func() {
		SetProbe(prevProbe)
		Registry = prevReg
	})
	Registry = []Spec{
		{ID: "opencode", BinaryName: "opencode", Source: stubSource{err: errNotFound}},
	}
	SetProbe(fakeProbe2{
		paths: map[string]string{"opencode": "/x/opencode"},
		vers:  map[string]string{"opencode": "1.0.0"},
	})
	out := Discover(context.Background())
	if !out[0].Installed || out[0].InstalledVersion != "1.0.0" {
		t.Fatalf("installed fields should be filled despite Source error: %+v", out[0])
	}
	if out[0].LatestVersion != "" {
		t.Fatalf("LatestVersion should be empty on Source error, got %q", out[0].LatestVersion)
	}
	if out[0].UpgradeAvailable {
		t.Fatalf("UpgradeAvailable should be false when LatestVersion empty")
	}
}

// TestDiscover_ProbeMissingBinary Probe 找不到二进制 → Installed=false、空版本,不崩。
func TestDiscover_ProbeMissingBinary(t *testing.T) {
	prevProbe := currentProbe()
	prevReg := Registry
	t.Cleanup(func() {
		SetProbe(prevProbe)
		Registry = prevReg
	})
	Registry = []Spec{
		{ID: "opencode", BinaryName: "opencode", Source: stubSource{v: "1.0.0"}},
	}
	SetProbe(fakeProbe2{paths: map[string]string{}, vers: map[string]string{}})
	out := Discover(context.Background())
	if out[0].Installed {
		t.Fatalf("Installed=true but binary missing")
	}
	if out[0].LatestVersion != "1.0.0" {
		t.Fatalf("LatestVersion should still be filled (Source independent of Probe): %q", out[0].LatestVersion)
	}
	if out[0].UpgradeAvailable {
		t.Fatalf("UpgradeAvailable=true when not installed")
	}
}

// TestGitHubSource_LatestHitsAPIAndParsesTag 用 httptest 起 mock GitHub API,
// 校验 GitHubSource 正确 GET /releases/latest + 解析 tag_name + 去前导 v。
func TestGitHubSource_LatestHitsAPIAndParsesTag(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/releases/latest") {
			t.Errorf("unexpected path: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if ua := r.Header.Get("User-Agent"); ua == "" {
			t.Errorf("missing User-Agent (GitHub API requires it)")
		}
		_ = json.NewEncoder(w).Encode(ghReleaseResp{TagName: "v1.2.3"})
	}))
	defer srv.Close()

	// 把 GitHubSource 的目标 URL 指到 mock:通过临时替换 ghBaseURL(包级变量,测试注入)。
	prev := ghBaseURL
	ghBaseURL = srv.URL + "/repos"
	t.Cleanup(func() { ghBaseURL = prev })

	g := &GitHubSource{Repo: "sst/opencode"}
	rel, err := g.Latest(context.Background())
	if err != nil {
		t.Fatalf("Latest failed: %v", err)
	}
	if rel.Version != "1.2.3" {
		t.Fatalf("Latest.Version=%q, want 1.2.3 (trim leading v)", rel.Version)
	}
}

// TestGitHubSource_HTTPErrorNonOK 503/404 等返 error(不假装成功)。
func TestGitHubSource_HTTPErrorNonOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "rate limited", http.StatusForbidden)
	}))
	defer srv.Close()

	prev := ghBaseURL
	ghBaseURL = srv.URL + "/repos"
	t.Cleanup(func() { ghBaseURL = prev })

	g := &GitHubSource{Repo: "sst/opencode"}
	if _, err := g.Latest(context.Background()); err == nil {
		t.Fatalf("expect error on HTTP 403")
	}
}
