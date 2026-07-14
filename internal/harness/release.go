// release.go:上游发布源 —— 查「最新版本」。
//
// ReleaseSource 是接口(§5.3 成熟库优先 + 接口注入):生产用 GitHubSource 打 GitHub API,
// 单测注入 mock(返回固定 Release),不真打网络。
package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Release 一个上游发布版本的最小描述。
type Release struct {
	Version string // 不带前导 v(与本地 InstalledVersion 同形,便于比较)
}

// ReleaseSource 能查「某 harness 的最新发布版本」。
// 实现须是并发安全的(LatestVersion 会被多个 harness 并行查)。
type ReleaseSource interface {
	Latest(ctx context.Context) (Release, error)
}

// GitHubSource 从 GitHub Releases(/releases/latest)查最新版本。
//
// 用 v3 REST API(免鉴权有 60/小时/IP 限额,桌面应用够用)。失败不致命:
// Discovered 会把空 LatestVersion 视为「查不到」,前端只显示本地版本。
type GitHubSource struct {
	Repo string // "owner/repo",如 "sst/opencode"
}

// ghReleaseResp GitHub /releases/latest 响应里我们关心的字段。
type ghReleaseResp struct {
	TagName string `json:"tag_name"` // 形如 "v1.2.3" 或 "1.2.3"
}

// 默认 HTTP 客户端:适中超时(网络慢时不应阻塞 discovery 太久)。
var ghClient = &http.Client{Timeout: 10 * time.Second}

// ghBaseURL GitHub API 根(默认 https://api.github.com)。
// 包级变量是为测试可注入(指向 httptest server);生产不要改。
var ghBaseURL = "https://api.github.com"

// Latest 查 GitHub 最新 release。网络/解析失败返 error;Discovered 据此降级。
func (g *GitHubSource) Latest(ctx context.Context) (Release, error) {
	if g.Repo == "" {
		return Release{}, fmt.Errorf("github source: empty repo")
	}
	url := ghBaseURL + "/repos/" + g.Repo + "/releases/latest"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return Release{}, fmt.Errorf("github source: %w", err)
	}
	// GitHub API 强制要求 User-Agent,否则 403。
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "monkey-deck")
	resp, err := ghClient.Do(req)
	if err != nil {
		return Release{}, fmt.Errorf("github source(%s): %w", g.Repo, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, resp.Body)
		return Release{}, fmt.Errorf("github source(%s): status %d", g.Repo, resp.StatusCode)
	}
	var body ghReleaseResp
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return Release{}, fmt.Errorf("github source(%s): decode: %w", g.Repo, err)
	}
	return Release{Version: trimLeadingV(strings.TrimSpace(body.TagName))}, nil
}

// trimLeadingV 去版本号前导 v/V("v1.2.3" → "1.2.3";"1.2.3" 不变)。
// 用于把 GitHub tag_name 归一化到与本地 `<bin> --version` 输出同形,便于 compareVersions。
func trimLeadingV(v string) string {
	if len(v) > 0 && (v[0] == 'v' || v[0] == 'V') {
		return v[1:]
	}
	return v
}
