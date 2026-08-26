package acp

// prompt_error.go: Prompt error root-cause extraction + classification (#46).
//
// Factual basis: docs/worklog/2026-08-26-quota-exhaustion-probe-46.md (live wire
// probe against opencode v1.18.23 + mock 429 provider). When the LLM provider
// rejects a turn (e.g. 5-hour usage limit), the harness retries internally
// (5x exponential backoff, invisible on the wire) and finally surfaces the
// failure as the JSON-RPC error response of session/prompt:
//
//	{"code":-32603,
//	 "message":"Internal error: 已达到 5 小时的使用上限。您的限额将在 2026-08-26 16:32:32 重置。",
//	 "data":{"service":"session","errorName":"APIError"}}
//
// Key implications for classification:
//   - A JSON-RPC error response means the harness process is ALIVE and the
//     connection is healthy (the peer answered). Only IsPeerDisconnected-class
//     errors justify teardown/reconnect.
//   - The quota message carries the reset timestamp inline — everything the UI
//     needs is in-band; no extra API call required. The stable anchor is the
//     reset-moment text (§5.3: anchor on protocol-stable signals), NOT
//     data.errorName=="APIError" (weak: other API errors share it).
//   - Error text language depends on the provider (zh for bigmodel, en for
//     Anthropic/OpenAI-style providers); both variants are anchored.

import (
	"errors"
	"regexp"
	"strings"

	"github.com/coder/acp-go-sdk"
)

// PromptErrorClass is the classification of a Prompt failure. The class drives
// the handling policy in internal/chat (teardown/reconnect vs keep-alive,
// auto-retry vs report immediately).
type PromptErrorClass string

const (
	// PromptErrPeerDisconnected: harness process crashed / transport broken.
	// Must tear down and reconnect (existing §3.3 semantics).
	PromptErrPeerDisconnected PromptErrorClass = "peer_disconnected"
	// PromptErrQuotaExhausted: provider usage/quota limit exhausted. The
	// connection is healthy; respawning cannot restore quota. Not retryable
	// client-side (reset is typically hours away).
	PromptErrQuotaExhausted PromptErrorClass = "quota_exhausted"
	// PromptErrTransient: transient provider/network failure (429/5xx/timeout/
	// connection blips) — a bounded client-side auto-retry is worthwhile.
	PromptErrTransient PromptErrorClass = "transient"
	// PromptErrFatal: everything else. Unknown semantics: keep the existing
	// conservative teardown+reconnect handling.
	PromptErrFatal PromptErrorClass = "fatal"
)

// PromptErrorInfo is the diagnosis of one Prompt error.
type PromptErrorInfo struct {
	// Class is the classification result (never empty for a non-nil error).
	Class PromptErrorClass
	// RootCause is the human-readable core of the error with protocol wrapping
	// stripped (e.g. the raw provider quota message, or the embedded OS error
	// for locally-wrapped transport failures). Intended for UI display (§4.4);
	// never a raw JSON blob when a better text exists.
	RootCause string
	// ResetAt is the provider-side quota reset time as raw text (provider local
	// time, e.g. "2026-08-26 16:32:32"), extracted from the message when
	// present. Passed through verbatim to avoid timezone misinterpretation —
	// the provider text is already what the user should see. Empty when absent.
	ResetAt string
	// Retryable reports whether a bounded client-side auto-retry is worthwhile
	// (true only for PromptErrTransient).
	Retryable bool
}

// quotaPatterns anchor "usage/quota limit exhausted" errors. The zh pattern is
// the empirically observed bigmodel form (probe §A/§B); en patterns cover
// Anthropic/OpenAI-style phrasing. "rate limit" is deliberately NOT here —
// short-window rate limits are transient, not quota exhaustion.
var quotaPatterns = []*regexp.Regexp{
	regexp.MustCompile(`已达到.{0,64}(?:使用上限|限额).{0,128}重置`),
	regexp.MustCompile(`(?i)usage limit`),
	regexp.MustCompile(`(?i)quota[ _-]?(?:exceeded|exhausted|hit|reached)`),
	regexp.MustCompile(`(?i)exceeded (?:[a-z]+ ){0,2}quota`),
}

// transientPatterns anchor retryable transient failures. These match provider
// HTTP/network failure texts that may survive the harness-internal retries.
var transientPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)rate[ _-]?limit`),
	regexp.MustCompile(`\b429\b`),
	regexp.MustCompile(`(?i)\b(?:502|503|504)\b`),
	regexp.MustCompile(`(?i)time[ _-]?out|timed out`),
	regexp.MustCompile(`(?i)temporarily (?:unavailable|failed)`),
	regexp.MustCompile(`(?i)overloaded`),
	regexp.MustCompile(`(?i)econnreset|econnrefused|socket hang up|fetch failed|network (?:error|failure)|connection (?:reset|refused)`),
	regexp.MustCompile(`(?i)server (?:error|unavailable)`),
}

// resetTimePatterns extract the quota reset moment, most precise first:
//  1. numeric datetime "2026-08-26 16:32:32" / "2026-08-26T16:32:32" (zh + ISO).
//  2. english "resets at 9am" / "reset on Monday" tail capture (best effort).
var resetTimePatterns = []*regexp.Regexp{
	regexp.MustCompile(`\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?`),
	regexp.MustCompile(`(?i)resets?(?: at| on)? ([^.,;。\n]{1,32})`),
}

// DiagnosePromptError classifies a Prompt error and extracts its root cause.
// Pure function (no I/O) — unit-testable without a real harness (§5.1).
// Classification order: peer-disconnected (established transport signal) →
// quota (provider-limit anchors) → transient (retryable anchors) → fatal.
// nil maps to PromptErrFatal so callers can classify unconditionally.
func DiagnosePromptError(err error) PromptErrorInfo {
	if err == nil {
		return PromptErrorInfo{Class: PromptErrFatal}
	}
	info := PromptErrorInfo{RootCause: promptRootCause(err)}
	// Match against the full error string: for *RequestError it embeds the
	// message (and data) as JSON, so both zh/en anchors hit regardless of
	// where the provider text sits.
	full := err.Error()
	switch {
	case IsPeerDisconnected(err):
		info.Class = PromptErrPeerDisconnected
	case matchAny(quotaPatterns, full):
		info.Class = PromptErrQuotaExhausted
		info.ResetAt = extractResetAt(full)
	case matchAny(transientPatterns, full):
		info.Class = PromptErrTransient
		info.Retryable = true
	default:
		info.Class = PromptErrFatal
	}
	return info
}

// promptRootCause extracts the human-readable core of the error:
//   - *RequestError with a real message: the message with the generic
//     "Internal error: " prefix stripped (the quota text lives there).
//   - *RequestError wrapping a local OS failure (SDK toReqErr: message is the
//     generic "Internal error", the payload is data.error): data.error.
//   - anything else: err.Error() as-is.
func promptRootCause(err error) string {
	var re *acp.RequestError
	if !errors.As(err, &re) {
		return err.Error()
	}
	msg := strings.TrimSpace(re.Message)
	msg = strings.TrimSpace(strings.TrimPrefix(msg, "Internal error:"))
	if msg == "" || msg == "Internal error" {
		if embedded := dataErrorString(re.Data); embedded != "" {
			return embedded
		}
	}
	if msg == "" {
		return err.Error()
	}
	return msg
}

// dataErrorString pulls the "error" string out of a RequestError's data field
// (SDK wraps local OS errors as {"error": "<os error text>"}).
func dataErrorString(data any) string {
	m, ok := data.(map[string]any)
	if !ok {
		return ""
	}
	if s, ok := m["error"].(string); ok {
		return s
	}
	return ""
}

func matchAny(patterns []*regexp.Regexp, s string) bool {
	for _, p := range patterns {
		if p.MatchString(s) {
			return true
		}
	}
	return false
}

// extractResetAt returns the first reset-time text found, or "".
func extractResetAt(s string) string {
	for _, p := range resetTimePatterns {
		if m := p.FindStringSubmatch(s); m != nil {
			// Tail-capture variants expose group 1; the datetime variant has
			// no capture group — handle both.
			if len(m) > 1 {
				return strings.TrimSpace(m[1])
			}
			return strings.TrimSpace(m[0])
		}
	}
	return ""
}
