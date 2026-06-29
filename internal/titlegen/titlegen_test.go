package titlegen

import (
	"testing"
)

func TestBuildContext(t *testing.T) {
	got := BuildContext("\n\n  hello   world  \n\nline two\n\n\nline three")
	if got != "hello world\nline two\nline three" {
		t.Fatalf("unexpected: %q", got)
	}
	long := ""
	for i := 0; i < 20; i++ {
		long += "line\n"
	}
	count := 0
	for _, c := range BuildContext(long) {
		if c == '\n' {
			count++
		}
	}
	if count+1 > maxCtxLines {
		t.Fatalf("expected <= %d lines, got %d", maxCtxLines, count+1)
	}
}

func TestNormalize(t *testing.T) {
	cases := []struct{ in, want string }{
		{"**加粗** _斜体_ `code`", "加粗 斜体 code"},
		{"# 标题\n正文", "标题 正文"},
		{"- 列表项\n- 第二", "列表项 第二"},
		{"```js\nfoo()\n```", "foo()"},
		{"title: 这是标题", "这是标题"},
		{"标题：冒号中文", "冒号中文"},
		{`"带引号"`, "带引号"},
		{"> 引用块内容", "引用块内容"},
		{"", "fallback"},
	}
	for _, c := range cases {
		if got := Normalize(c.in, "fallback"); got != c.want {
			t.Errorf("Normalize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestNormalizeLengthCap(t *testing.T) {
	long := ""
	for i := 0; i < 100; i++ {
		long += "字"
	}
	got := Normalize(long, "")
	if len([]rune(got)) > maxChars {
		t.Fatalf("length not capped: %d runes", len([]rune(got)))
	}
}

func TestFallbackTitle(t *testing.T) {
	if got := FallbackTitle("帮我修复 README 里的拼写错误", "新对话"); got != "帮我修复 README 里的拼写错误" {
		t.Fatalf("unexpected: %q", got)
	}
	if FallbackTitle("", "新对话") != "新对话" {
		t.Fatalf("empty input should return fallback")
	}
	if got := FallbackTitle("```\n/command do stuff\n```", ""); got != "/command do stuff" {
		t.Fatalf("code fence should be unwrapped: %q", got)
	}
}
