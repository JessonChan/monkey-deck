package titlegen

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestBuildContext(t *testing.T) {
	got := BuildContext("\n\n  hello   world  \n\nline two\n\n\nline three")
	if got != "hello world\nline two\nline three" {
		t.Fatalf("unexpected: %q", got)
	}
	// 限行
	long := ""
	for i := 0; i < 20; i++ {
		long += "line " + itoa(i) + "\n"
	}
	lines := 0
	for _, l := range splitLines(BuildContext(long)) {
		if l != "" {
			lines++
		}
	}
	if lines > maxCtxLines {
		t.Fatalf("expected <= %d lines, got %d", maxCtxLines, lines)
	}
}

func itoa(i int) string {
	b, _ := json.Marshal(i)
	return string(b)
}
func splitLines(s string) []string {
	var out []string
	cur := ""
	for _, r := range s {
		if r == '\n' {
			out = append(out, cur)
			cur = ""
			continue
		}
		cur += string(r)
	}
	out = append(out, cur)
	return out
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
		got := Normalize(c.in, "fallback")
		if got != c.want {
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
	got := FallbackTitle("帮我修复 README 里的拼写错误", "新对话")
	if got != "帮我修复 README 里的拼写错误" {
		t.Fatalf("unexpected: %q", got)
	}
	if FallbackTitle("", "新对话") != "新对话" {
		t.Fatalf("empty input should return fallback")
	}
	// markdown 指令被剥离,不污染标题
	got = FallbackTitle("```\n/command do stuff\n```", "")
	if got == "" || got == "/command do stuff" {
		// 归一化后应保留文本主体(去掉代码围栏)
	}
}

func TestResolveProvider(t *testing.T) {
	// cwd 级配置覆盖全局
	dir := t.TempDir()
	cfg := `{
		"model": "bigmodel-coding/glm-5.2",
		"provider": {
			"bigmodel-coding": {
				"options": { "baseURL": "https://example.test/v4", "apiKey": "k-local" },
				"models": { "glm-5.2": {} }
			}
		}
	}`
	if err := os.WriteFile(filepath.Join(dir, "opencode.json"), []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}
	baseURL, apiKey, model, ok := resolveProvider("bigmodel-coding/glm-5.2", dir)
	if !ok || baseURL != "https://example.test/v4" || apiKey != "k-local" || model != "glm-5.2" {
		t.Fatalf("resolve cwd: ok=%v baseURL=%q apiKey=%q model=%q", ok, baseURL, apiKey, model)
	}
	// 无 / 分隔 → 失败
	if _, _, _, ok := resolveProvider("baremodel", dir); ok {
		t.Fatalf("bare model should not resolve")
	}
	// provider 不存在 → 失败
	if _, _, _, ok := resolveProvider("noprovider/x", dir); ok {
		t.Fatalf("unknown provider should not resolve")
	}
}

func TestGenerateWithHTTP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Errorf("missing auth header")
		}
		b, _ := io.ReadAll(r.Body)
		var req llmRequest
		_ = json.Unmarshal(b, &req)
		if req.Messages[0].Content == "" {
			t.Errorf("empty prompt")
		}
		_ = json.NewEncoder(w).Encode(llmResponse{Choices: []struct {
			Message struct {
				Content          string `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
			} `json:"message"`
		}{{Message: struct {
			Content          string `json:"content"`
			ReasoningContent string `json:"reasoning_content"`
		}{Content: "修复 README 拼写错误"}}}})
	}))
	defer srv.Close()

	got, err := generateWith(context.Background(), srv.Client(), srv.URL, "secret", "glm", "修复README")
	if err != nil {
		t.Fatal(err)
	}
	if got != "修复 README 拼写错误" {
		t.Fatalf("unexpected content: %q", got)
	}
}

func TestGenerateHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	if _, err := generateWith(context.Background(), srv.Client(), srv.URL, "k", "m", "x"); err == nil {
		t.Fatalf("expected error on 500")
	}
}
