package chat

// export.go: ExportSession renders a session's full conversation to text.
//
// Two formats are supported:
//   - jsonl: one JSON object per line. The first line is session meta
//     (type="session"); every subsequent line is a message (type="message")
//     in ascending seq order. Machine-readable, easy to post-process / re-import.
//   - txt: human-readable plain text (AGENTS.md §4.4: never dumps raw structured
//     formats). user/thought/agent/tool/plan each get their own section; tool
//     extracts the main text instead of emitting the toolAccum JSON.

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jessonchan/monkey-deck/internal/acp"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// ExportSession renders sessionID's full conversation to text.
// format: "jsonl" (one JSON per line) / "txt" (human-readable). Empty string is
// treated as "txt". The returned string is downloaded client-side via a Blob
// (the frontend composes the file name).
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

// exportSessionMeta is the session meta carried on the first jsonl line.
type exportSessionMeta struct {
	Type    string `json:"type"` // always "session"
	ID      string `json:"id"`
	Title   string `json:"title"`
	Harness string `json:"harness"`
	Model   string `json:"model"`
	Created int64  `json:"createdAt"`
}

// exportMessageRecord is the jsonl record for a single message.
type exportMessageRecord struct {
	Type       string `json:"type"` // always "message"
	Seq        int64  `json:"seq"`
	Role       string `json:"role"`           // user/agent/thought/tool/plan
	Kind       string `json:"kind,omitempty"` // agent_message_chunk/agent_thought_chunk/tool_call/plan/...
	Content    string `json:"content"`        // raw content (tool/plan hold JSON text)
	ToolCallID string `json:"toolCallId,omitempty"`
	CreatedAt  int64  `json:"createdAt"`
}

func exportJSONL(se *store.Session, msgs []store.Message) string {
	var b strings.Builder
	// First line: session meta.
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

// exportTxt renders the conversation as human-readable plain text.
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

// writeTxtMessage renders a single message as human-readable text. For tool/plan
// the content is JSON; we extract the main text here (AGENTS.md §4.4).
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

// writeSection writes a `─── Title ───` section header.
func writeSection(b *strings.Builder, title string) {
	fmt.Fprintf(b, "─── %s ────────────\n", title)
}

// writeToolSection renders a tool call: parses the toolAccum JSON and extracts
// the title/status/input/output main text. On parse failure it degrades to the
// raw content (best-effort, never drops data).
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

// writePlanSection renders a plan: parses the []PlanEntry list into a checklist.
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

// extractMainText pulls the "main text" out of a tool's rawInput/rawOutput
// (AGENTS.md §4.4). A string is returned as-is; objects / anything else become
// pretty-printed JSON text. No information is dropped.
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

// indent prepends two spaces to every line (used for input/output bodies).
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

// formatMillis renders Unix milliseconds as local-time RFC3339 (with timezone,
// readable across machines).
func formatMillis(ms int64) string {
	if ms <= 0 {
		return "-"
	}
	return time.UnixMilli(ms).Local().Format(time.RFC3339)
}
