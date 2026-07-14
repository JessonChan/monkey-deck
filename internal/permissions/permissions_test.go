package permissions

import "testing"

func TestEngineDefaultRules(t *testing.T) {
	e := NewEngine(DefaultRules())

	cases := []struct {
		name string
		req  MatchRequest
		want string
	}{
		{
			name: "read 工具自动放行",
			req:  MatchRequest{ToolKind: "read", Locations: []string{"/tmp/a.go"}},
			want: LevelAllow,
		},
		{
			name: "search 工具自动放行(只读分组)",
			req:  MatchRequest{ToolKind: "search", Locations: []string{"/tmp"}},
			want: LevelAllow,
		},
		{
			name: "edit 工具需确认(写分组)",
			req:  MatchRequest{ToolKind: "edit", Locations: []string{"/tmp/a.go"}},
			want: LevelAsk,
		},
		{
			name: "delete 工具需确认(写分组)",
			req:  MatchRequest{ToolKind: "delete", Locations: []string{"/tmp/a.go"}},
			want: LevelAsk,
		},
		{
			name: "execute 普通命令需确认",
			req:  MatchRequest{ToolKind: "execute", RawInput: map[string]any{"command": "ls -la"}},
			want: LevelAsk,
		},
		{
			name: "rm -rf 被 deny 截走(优先级最高)",
			req:  MatchRequest{ToolKind: "execute", RawInput: map[string]any{"command": "rm -rf /tmp/x"}},
			want: LevelDeny,
		},
		{
			name: "rm -fr 同样 deny",
			req:  MatchRequest{ToolKind: "execute", RawInput: map[string]any{"command": "rm -fr /tmp/x"}},
			want: LevelDeny,
		},
		{
			name: "rm -Rf (大写 R) deny",
			req:  MatchRequest{ToolKind: "execute", RawInput: map[string]any{"command": "rm -Rf /tmp/x"}},
			want: LevelDeny,
		},
		{
			name: "mkfs deny",
			req:  MatchRequest{ToolKind: "execute", RawInput: map[string]any{"command": "mkfs.ext4 /dev/sda1"}},
			want: LevelDeny,
		},
		{
			name: "dd 写块设备 deny",
			req:  MatchRequest{ToolKind: "execute", RawInput: map[string]any{"command": "dd if=img.iso of=/dev/sdb"}},
			want: LevelDeny,
		},
		{
			name: "未知 kind 走 fallback",
			req:  MatchRequest{ToolKind: "switch_mode"},
			want: LevelAsk,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := e.Decide(c.req, LevelAsk)
			if got != c.want {
				t.Fatalf("Decide(%+v) = %q, want %q", c.req, got, c.want)
			}
		})
	}
}

func TestEnginePathPattern(t *testing.T) {
	rules := []Rule{
		{ID: "r1", ActionType: ActionWrite, PathPattern: "/etc/**", Level: LevelDeny, Enabled: true, SortOrder: 0},
		{ID: "r2", ActionType: ActionWrite, Level: LevelAsk, Enabled: true, SortOrder: 1},
	}
	e := NewEngine(rules)

	if got := e.Decide(MatchRequest{ToolKind: "edit", Locations: []string{"/etc/passwd"}}, LevelAsk); got != LevelDeny {
		t.Fatalf("edit under /etc 应 deny, got %s", got)
	}
	if got := e.Decide(MatchRequest{ToolKind: "edit", Locations: []string{"/tmp/a.go"}}, LevelAsk); got != LevelAsk {
		t.Fatalf("edit under /tmp 应 ask, got %s", got)
	}
	// 多 location 任一命中即算命中
	if got := e.Decide(MatchRequest{ToolKind: "edit", Locations: []string{"/tmp/a.go", "/etc/shadow"}}, LevelAsk); got != LevelDeny {
		t.Fatalf("触及 /etc 应 deny, got %s", got)
	}
}

func TestEngineUserAllowBash(t *testing.T) {
	// 用户加规则:execute 命令匹配 git → allow;排在默认 deny 危险命令之后、默认 ask 之前。
	rules := []Rule{
		{ID: "deny-danger", ActionType: ActionExec, CommandPattern: `\brm\s+-\w*r\w*f`, Level: LevelDeny, Enabled: true, SortOrder: 0},
		{ID: "allow-git", ActionType: ActionExec, CommandPattern: `^git `, Level: LevelAllow, Enabled: true, SortOrder: 1},
		{ID: "ask-exec", ActionType: ActionExec, Level: LevelAsk, Enabled: true, SortOrder: 2},
	}
	e := NewEngine(rules)

	if got := e.Decide(MatchRequest{ToolKind: "execute", RawInput: map[string]any{"command": "git status"}}, LevelAsk); got != LevelAllow {
		t.Fatalf("git 命令应 allow, got %s", got)
	}
	if got := e.Decide(MatchRequest{ToolKind: "execute", RawInput: map[string]any{"command": "rm -rf x"}}, LevelAsk); got != LevelDeny {
		t.Fatalf("rm -rf 应 deny, got %s", got)
	}
	if got := e.Decide(MatchRequest{ToolKind: "execute", RawInput: map[string]any{"command": "go test"}}, LevelAsk); got != LevelAsk {
		t.Fatalf("其它命令应 ask, got %s", got)
	}
}

func TestEngineEmptyFallback(t *testing.T) {
	e := NewEngine(nil) // 无规则
	if got := e.Decide(MatchRequest{ToolKind: "execute"}, LevelAsk); got != LevelAsk {
		t.Fatalf("空引擎应返回 fallback, got %s", got)
	}
	if got := e.Decide(MatchRequest{ToolKind: "execute"}, LevelAllow); got != LevelAllow {
		t.Fatalf("空引擎应返回 fallback(allow), got %s", got)
	}
}

func TestEngineDisabledRuleSkipped(t *testing.T) {
	rules := []Rule{
		{ID: "r1", ActionType: ActionRead, Level: LevelDeny, Enabled: false, SortOrder: 0},
		{ID: "r2", ActionType: ActionRead, Level: LevelAllow, Enabled: true, SortOrder: 1},
	}
	e := NewEngine(rules)
	if got := e.Decide(MatchRequest{ToolKind: "read"}, LevelAsk); got != LevelAllow {
		t.Fatalf("禁用规则应跳过, got %s", got)
	}
}

func TestEngineBadRegexSkipped(t *testing.T) {
	rules := []Rule{
		{ID: "bad", ActionType: ActionExec, CommandPattern: `(unclosed`, Level: LevelDeny, Enabled: true, SortOrder: 0},
		{ID: "ok", ActionType: ActionExec, Level: LevelAsk, Enabled: true, SortOrder: 1},
	}
	e := NewEngine(rules)
	// 非法正则不致崩溃,跳过 bad 规则后落到 ok(ask)
	got := e.Decide(MatchRequest{ToolKind: "execute", RawInput: map[string]any{"command": "ls"}}, LevelAllow)
	if got != LevelAsk {
		t.Fatalf("非法正则规则应跳过, got %s", got)
	}
}

func TestActionOfKind(t *testing.T) {
	cases := map[string]string{
		"read":        ActionRead,
		"READ":        ActionRead, // 大小写不敏
		"search":      ActionRead,
		"think":       ActionRead,
		"fetch":       ActionRead,
		"edit":        ActionWrite,
		"delete":      ActionWrite,
		"move":        ActionWrite,
		"execute":     ActionExec,
		"switch_mode": ActionOther,
		"":            ActionOther,
		"weird":       ActionOther,
	}
	for in, want := range cases {
		if got := ActionOfKind(in); got != want {
			t.Errorf("ActionOfKind(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExtractCommand(t *testing.T) {
	if got := ExtractCommand("ls -la"); got != "ls -la" {
		t.Errorf("string raw: got %q", got)
	}
	if got := ExtractCommand(map[string]any{"command": "git status"}); got != "git status" {
		t.Errorf("command key: got %q", got)
	}
	if got := ExtractCommand(map[string]any{"cmd": "echo hi"}); got != "echo hi" {
		t.Errorf("cmd key: got %q", got)
	}
	if got := ExtractCommand(map[string]any{"argv": []any{"go", "build", "./..."}}); got != "go build ./..." {
		t.Errorf("argv join: got %q", got)
	}
	if got := ExtractCommand(map[string]any{"foo": "bar"}); got != "" {
		t.Errorf("no command: got %q", got)
	}
	if got := ExtractCommand(42); got != "" {
		t.Errorf("non-string raw: got %q", got)
	}
}

func TestMatchPath(t *testing.T) {
	cases := []struct {
		pattern, path string
		want          bool
	}{
		{"/tmp/**", "/tmp", true},
		{"/tmp/**", "/tmp/a.go", true},
		{"/tmp/**", "/tmp/sub/a.go", true},
		{"/tmp/**", "/etc/passwd", false},
		{"*.go", "/tmp/a.go", true},
		{"*.go", "/tmp/a.txt", false},
		{"/etc", "/etc", true},
		{"/etc", "/etc/passwd", true},
		{"/etc", "/etc2/x", false},
		{"**", "/anything", true},
	}
	for _, c := range cases {
		if got := matchPath(c.pattern, c.path); got != c.want {
			t.Errorf("matchPath(%q,%q) = %v, want %v", c.pattern, c.path, got, c.want)
		}
	}
}
