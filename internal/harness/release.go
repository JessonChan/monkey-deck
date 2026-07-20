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
	"os/exec"
	"regexp"
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

// CommandSource 跑一条外部命令查 harness 最新版本(委派给 harness 自己的 update --check 之类命令)。
//
// 为什么优先委派(§5.3 外部事实先验证 + §5.3 成熟库优先):harness 自己最清楚发布渠道
// (npm/brew/curl/自建 CDN 等),我们替它操心会做不全 —— opencode 自带 `opencode upgrade
// --method npm|bun|brew|curl|...`,omp 自带 `omp update --check`(原生 check-only)。
// 绕开它们手搓 GitHub API 会与包管理器打架(写死 curl 在用户 npm 全局装的 opencode 旁再装一份)
// 或干脆漏接(omp 之前 Source=nil,永远查不到最新版本)。
//
// 解析策略(§5.3 找不变量,禁用「输出第几行」启发式):
//   - Pattern 非 nil:用其**单 capture group** 锚定提取(如 `New version available:\s*(\S+)`)。
//     协议稳定标识是关键词本身,与输出顺序、stderr 混入(oclif perf 日志)无关。
//   - Pattern nil:回退 extractVersion(取首行首个含数字 token,与本地版本同形),向后兼容简单命令。
//
// 「已是最新」时 omp 输出无 "New version" 行,Pattern 不匹配 → 返 error
// → Discover 把 LatestVersion 留空 → 前端显示「已是最新」徽章(自然自洽)。
type CommandSource struct {
	Cmd     []string         // [name, args...] 形如 {"omp","update","--check"}
	Pattern *regexp.Regexp   // 可选:单 capture group 提取最新版本号;空 = 回退 extractVersion
}

// Latest 跑配置的命令,按 Pattern(或 extractVersion 回退)解析输出里的最新版本号。
// 命令非 0 退出、或解析不到版本号,都返 error(不假装成功)。
func (c CommandSource) Latest(ctx context.Context) (Release, error) {
	if len(c.Cmd) == 0 {
		return Release{}, fmt.Errorf("command source: empty cmd")
	}
	cmd := exec.CommandContext(ctx, c.Cmd[0], c.Cmd[1:]...)
	cmd.Stdin = nil // 不连 stdin(否则 hang)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return Release{}, fmt.Errorf("command source(%s): %w: %s", c.Cmd[0], err, string(out))
	}
	s := string(out)
	var v string
	if c.Pattern != nil {
		if m := c.Pattern.FindStringSubmatch(s); len(m) >= 2 {
			v = strings.TrimSpace(m[1])
		}
	} else {
		v = extractVersion(s)
	}
	if v == "" {
		return Release{}, fmt.Errorf("command source(%s): no version in output", c.Cmd[0])
	}
	return Release{Version: v}, nil
}
