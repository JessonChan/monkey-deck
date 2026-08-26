package acp

// prompt_error_test.go: pure-function tests for the Prompt error classifier
// (#46). Anchored on the empirically observed wire forms from
// docs/worklog/2026-08-26-quota-exhaustion-probe-46.md (§A real events, §B
// live wire probe) — no real harness needed (§5.1).

import (
	"errors"
	"fmt"
	"testing"

	"github.com/coder/acp-go-sdk"
)

// quotaRequestError builds the exact wire form the SDK produces for the
// probed quota-exhaustion turn (probe §B.2: session/prompt JSON-RPC error).
func quotaRequestError() *acp.RequestError {
	return &acp.RequestError{
		Code:    -32603,
		Message: "Internal error: 已达到 5 小时的使用上限。您的限额将在 2026-08-26 16:32:32 重置。",
		Data:    map[string]any{"service": "session", "errorName": "APIError"},
	}
}

// TestDiagnoseQuotaExhaustedZh: the real bigmodel quota text (probe §A, two
// production events 14:59 / 19:43) must classify as quota, carry the reset
// moment, and NOT be client-retryable.
func TestDiagnoseQuotaExhaustedZh(t *testing.T) {
	info := DiagnosePromptError(quotaRequestError())
	if info.Class != PromptErrQuotaExhausted {
		t.Fatalf("class = %q, want %q", info.Class, PromptErrQuotaExhausted)
	}
	if info.ResetAt != "2026-08-26 16:32:32" {
		t.Fatalf("ResetAt = %q, want %q", info.ResetAt, "2026-08-26 16:32:32")
	}
	if info.Retryable {
		t.Fatal("quota exhaustion must not be client-retryable (reset is hours away)")
	}
	// Root cause must be the provider text with the generic wrapper stripped,
	// not the raw JSON blob (§4.4).
	want := "已达到 5 小时的使用上限。您的限额将在 2026-08-26 16:32:32 重置。"
	if info.RootCause != want {
		t.Fatalf("RootCause = %q, want %q", info.RootCause, want)
	}
}

// TestDiagnoseQuotaExhaustedVariants: second real event text + common english
// phrasings must classify as quota (probe §D: anchor on the limit/reset text,
// zh and en variants).
func TestDiagnoseQuotaExhaustedVariants(t *testing.T) {
	variants := []error{
		// Second production event (19:43), different reset moment.
		&acp.RequestError{
			Code:    -32603,
			Message: "Internal error: 已达到 5 小时的使用上限。您的限额将在 2026-08-26 21:32:49 重置。",
			Data:    map[string]any{"service": "session", "errorName": "APIError"},
		},
		errors.New("AI_APICallError: You have reached your usage limit. Your limit will reset at 2026-08-27 09:00:00 (UTC+8)."),
		errors.New("quota exceeded for this API key"),
		fmt.Errorf("wrapped: %w", errors.New("You exceeded your current quota, please check your plan and billing details")),
	}
	for _, err := range variants {
		if info := DiagnosePromptError(err); info.Class != PromptErrQuotaExhausted {
			t.Fatalf("class = %q for %v, want %q", info.Class, err, PromptErrQuotaExhausted)
		}
	}
}

// TestDiagnoseResetAtExtraction: reset text extraction, datetime and
// best-effort english tail forms.
func TestDiagnoseResetAtExtraction(t *testing.T) {
	cases := []struct {
		err  error
		want string
	}{
		{quotaRequestError(), "2026-08-26 16:32:32"},
		{errors.New("usage limit reached; resets at 9am"), "9am"},
		{errors.New("usage limit reached; limit will reset on Monday"), "Monday"},
		{errors.New("usage limit reached"), ""}, // no reset info in text
	}
	for _, c := range cases {
		if got := DiagnosePromptError(c.err).ResetAt; got != c.want {
			t.Fatalf("ResetAt = %q for %v, want %q", got, c.err, c.want)
		}
	}
}

// TestDiagnosePeerDisconnected: both transport-failure signals must keep
// classifying as peer-disconnected (classification priority over quota/
// transient; §3.3 reconnect semantics preserved).
func TestDiagnosePeerDisconnected(t *testing.T) {
	cases := []error{
		errors.New("peer disconnected before response"),
		// SDK toReqErr-wrapped broken pipe: signal buried in data (§5.4 #2).
		&acp.RequestError{
			Code:    -32603,
			Message: "Internal error",
			Data:    map[string]any{"error": "write |1: broken pipe"},
		},
	}
	for _, err := range cases {
		info := DiagnosePromptError(err)
		if info.Class != PromptErrPeerDisconnected {
			t.Fatalf("class = %q for %v, want %q", info.Class, err, PromptErrPeerDisconnected)
		}
		if info.Retryable {
			t.Fatal("peer disconnect must not be in-turn retryable (handled by teardown+reconnect)")
		}
	}
	// Broken-pipe root cause: the embedded OS error, not the generic message.
	info := DiagnosePromptError(cases[1])
	if info.RootCause != "write |1: broken pipe" {
		t.Fatalf("RootCause = %q, want embedded OS error text", info.RootCause)
	}
}

// TestDiagnoseTransient: retryable anchors classify as transient; distinct
// from quota (short-window "rate limit" is transient, not quota exhaustion).
func TestDiagnoseTransient(t *testing.T) {
	cases := []error{
		errors.New("AI_APICallError: 429 Too Many Requests"),
		errors.New("rate limit reached for requests, please retry later"),
		errors.New("The operation timed out"),
		errors.New("503 Service Unavailable"),
		&acp.RequestError{Code: -32603, Message: "Internal error: temporarily unavailable"},
		errors.New("fetch failed: ECONNREFUSED 127.0.0.1:8765"),
		errors.New("socket hang up"),
	}
	for _, err := range cases {
		info := DiagnosePromptError(err)
		if info.Class != PromptErrTransient {
			t.Fatalf("class = %q for %v, want %q", info.Class, err, PromptErrTransient)
		}
		if !info.Retryable {
			t.Fatalf("transient must be retryable: %v", err)
		}
	}
}

// TestDiagnoseFatalAndNil: unrelated errors and nil stay fatal / non-retryable
// (§5.4 probe §D boundary: unknown errors keep the existing handling).
func TestDiagnoseFatalAndNil(t *testing.T) {
	for _, err := range []error{nil, errors.New("something failed")} {
		info := DiagnosePromptError(err)
		if info.Class != PromptErrFatal {
			t.Fatalf("class = %q for %v, want %q", info.Class, err, PromptErrFatal)
		}
		if info.Retryable {
			t.Fatal("fatal must not be retryable")
		}
	}
}
