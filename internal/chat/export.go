package chat

// export.go:ExportSession 把一个 session 的完整对话导出为文本。
//
// 支持两种格式:
//   - jsonl: 每行一个 JSON 对象。第一行是 session 元信息(type="session"),
//     之后每行是一条消息(type="message"),按 seq 升序。机器可读,便于二次处理/导入。
//   - txt: 人话可读的纯文本(§4.4:不裸露结构化格式),user/thought/agent/tool/plan
//     各自分节,tool 抽取主文本而非吐 JSON。

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jessonchan/monkey-deck/internal/acp"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// ExportSession 把 sessionID 的完整对话导出为文本。
// format: "jsonl"(每行一个 JSON)/ "txt"(人话可读)。空串按 "txt" 处理。
// 返回的字符串由前端用 Blob 下载落盘(文件名由前端拼)。
func (s *ChatService) ExportSession(sessionID, format string) (string, error) {
	se, err := s.st.GetSession(s.ctx, sessionID)
	if err != nil {
		return "", fmt.Errorf("get session: %w", err)
	}
	if se == nil {
		return "", fmt.Errorf("session not found: %s", sessionID)
	}
	msgs, err := s.st.ListMessages(s.ctx, sessionID)
	if err != nil {
		return "", fmt.Errorf("list messages: %w", err)
	}
	switch format {
	case "jsonl":
		return exportJSONL(se, msgs), nil
	case "txt", "":
		return exportTxt(se, msgs), nil
	default:
		return "", fmt.Errorf("unsupported export format %q (want jsonl or txt)", format)
	}
}

// exportSessionMeta 是 jsonl 首行的 session 元信息。
type exportSessionMeta struct {
	Type    string `json:"type"`    // 恒 "session"
	ID      string `json:"id"`
	Title   string `json:"title"`
	Harness string `json:"harness"`
	Model   string `json:"model"`
	Created int64  `json:"createdAt"`
}

// exportMessageRecord 是 jsonl 每条消息对应的行。
type exportMessageRecord struct {
	Type      string `json:"type"` // 恒 "message"
	Seq       int64  `json:"seq"`
	Role      string `json:"role"`            // user/agent/thought/tool/plan
	Kind      string `json:"kind,omitempty"`  // agent_message_chunk/agent_thought_chunk/tool_call/plan/...
	Content   string `json:"content"`         // 原始内容(tool/plan 是 JSON 文本)
	ToolCallID string `json:"toolCallId,omitempty"`
	CreatedAt int64  `json:"createdAt"`
}

func exportJSONL(se *store.Session, msgs []store.Message) string {
	var b strings.Builder
	// 首行:session 元信息。
	meta, _ := json.Marshal(exportSessionMeta{
		Type: "session", ID: se.ID, Title: se.Title, Harness: se.Harness, Model: se.Model, Created: se.CreatedAt,
	})
	b.Write(meta)
	b.WriteByte('\n')
	for _, m := range msgs {
		rec, _ := json.Marshal(exportMessageRecord{
			Type:       "message",
			Seq:        m.Seq,
			Role:       m.Role,
			Kind:       m.Kind,
			Content:    m.Content,
			ToolCallID: m.ToolCallID,
			CreatedAt:  m.CreatedAt,
		})
		b.Write(rec)
		b.WriteByte('\n')
	}
	return b.String()
}

// exportTxt 把对话渲染为人话可读的纯文本。
func exportTxt(se *store.Session, msgs []store.Message) string {
	var b strings.Builder
	title := se.Title
	if strings.TrimSpace(title) == "" {
		title = "New chat"
	}
	fmt.Fprintf(&b, "# %s\n", title)
	fmt.Fprintf(&b, "# Session ID: %s\n", se.ID)
	fmt.Fprintf(&b, "# Agent: %s", se.Harness)
	if se.Model != "" {
		fmt.Fprintf(&b, "  ·  Model: %s", se.Model)
	}
	b.WriteByte('\n')
	fmt.Fprintf(&b, "# Created: %s\n", formatMillis(se.CreatedAt))
	b.WriteString("\n")

	if len(msgs) == 0 {
		b.WriteString("(no messages)\n")
		return b.String()
	}
	for _, m := range msgs {
		writeTxtMessage(&b, m)
		b.WriteString("\n")
	}
	return b.String()
}

// writeTxtMessage 渲染一条消息为人话文本。tool/plan 的 content 是 JSON,这里抽主文本(§4.4)。
func writeTxtMessage(b *strings.Builder, m store.Message) {
	switch m.Role {
	case "user":
		writeSection(b, "You")
		b.WriteString(nonEmpty(m.Content))
	case "agent":
		writeSection(b, "Assistant")
		b.WriteString(nonEmpty(m.Content))
	case "thought":
		writeSection(b, "Thinking")
		b.WriteString(nonEmpty(m.Content))
	case "tool":
		writeToolSection(b, m.Content)
	case "plan":
		writePlanSection(b, m.Content)
	default:
		writeSection(b, titleCase(m.Role))
		b.WriteString(nonEmpty(m.Content))
	}
}

// writeSection 写一个 `─── Title ───` 分节头。
func writeSection(b *strings.Builder, title string) {
	fmt.Fprintf(b, "─── %s ────────────\n", title)
}

// writeToolSection 渲染 tool call:解析 toolAccum JSON,抽 title/status/input/output 主文本。
// 解析失败时降级展示原始内容(best-effort,不丢数据)。
func writeToolSection(b *strings.Builder, content string) {
	var ta toolAccum
	if err := json.Unmarshal([]byte(content), &ta); err != nil {
		writeSection(b, "Tool")
		b.WriteString(content)
		b.WriteByte('\n')
		return
	}
	title := ta.Title
	if strings.TrimSpace(title) == "" {
		title = "Tool"
	}
	writeSection(b, title)
	if ta.Kind != "" {
		fmt.Fprintf(b, "kind:   %s\n", ta.Kind)
	}
	if ta.Status != "" {
		fmt.Fprintf(b, "status: %s\n", ta.Status)
	}
	if s := extractMainText(ta.RawInput); s != "" {
		b.WriteString("input:\n")
		b.WriteString(indent(s))
		b.WriteByte('\n')
	}
	if s := extractMainText(ta.RawOutput); s != "" {
		b.WriteString("output:\n")
		b.WriteString(indent(s))
		b.WriteByte('\n')
	}
}

// writePlanSection 渲染 plan:解析 PlanEntry 列表为 checklist。
func writePlanSection(b *strings.Builder, content string) {
	var entries []acp.PlanEntry
	if err := json.Unmarshal([]byte(content), &entries); err != nil || len(entries) == 0 {
		writeSection(b, "Plan")
		b.WriteString(content)
		b.WriteByte('\n')
		return
	}
	writeSection(b, "Plan")
	for _, e := range entries {
		mark := "[ ]"
		if e.Status == "completed" {
			mark = "[x]"
		} else if e.Status == "in_progress" {
			mark = "[~]"
		}
		fmt.Fprintf(b, "%s %s\n", mark, e.Content)
	}
}

// extractMainText 从 tool 的 rawInput/rawOutput 抽「主文本」(§4.4)。
// string → 原样;对象/其它 → 转 JSON 文本(可读缩进)。不丢弃任何信息。
func extractMainText(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	body, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return string(body)
}

// indent 给每行加两个空格缩进(用于 input/output 体)。
func indent(s string) string {
	if s == "" {
		return ""
	}
	lines := strings.Split(s, "\n")
	for i, ln := range lines {
		lines[i] = "  " + ln
	}
	return strings.Join(lines, "\n")
}

func nonEmpty(s string) string {
	if strings.TrimSpace(s) == "" {
		return "(empty)\n"
	}
	if !strings.HasSuffix(s, "\n") {
		return s + "\n"
	}
	return s
}

func titleCase(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// formatMillis 把 Unix 毫秒渲染成本地时间的 RFC3339(含时区,跨机器可读)。
func formatMillis(ms int64) string {
	if ms <= 0 {
		return "-"
	}
	return time.UnixMilli(ms).Local().Format(time.RFC3339)
}
