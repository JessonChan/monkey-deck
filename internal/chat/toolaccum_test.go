package chat

import (
	"encoding/json"
	"strings"
	"testing"
)

// 回归(AGENTS.md §5.3):toolAccum 字段曾全是非导出小写,encoding/json 只序列化导出字段,
// 导致 persistTurn 的 json.Marshal 产出 "{}"。前端历史恢复时 JSON.parse("{}") 得到空对象,
// tool 卡片 title/status 全空(状态标签 fallback 成破折号「—」)、rawInput/rawOutput 缺失
// (展开空壳,点不开)。修复=字段导出 + json tag。
func TestToolAccumSerializesAllFields(t *testing.T) {
	tc := toolAccum{
		ID:        "tc1",
		Title:     "read file",
		Status:    "completed",
		Kind:      "read",
		RawInput:  map[string]any{"path": "/tmp/x"},
		RawOutput: map[string]any{"output": "hello"},
	}
	b, err := json.Marshal(tc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(b)
	if s == "{}" {
		t.Fatalf("marshal produced empty object — fields not exported")
	}
	for _, want := range []string{
		`"id":"tc1"`, `"title":"read file"`, `"status":"completed"`,
		`"kind":"read"`, `"rawInput":`, `"rawOutput":`,
	} {
		if !strings.Contains(s, want) {
			t.Fatalf("marshal missing %s\ngot: %s", want, s)
		}
	}
}
