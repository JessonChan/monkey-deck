package chat

// prompt_error_test.go: service-level behavior tests for Prompt error
// classification + N≤3 retry + emitError payload (#46 step 2).
//
// Factual basis: docs/worklog/2026-08-26-quota-exhaustion-probe-46.md — quota
// exhaustion ends as the JSON-RPC error response of session/prompt (harness
// alive, connection healthy), so the blanket teardown+reconnect is a triple
// error (kills a healthy harness / reconnects pointlessly / drops the reset
// moment). Three invariants are pinned here:
//  1. Quota exhaustion: no teardown, no reconnect, no queue auto-drain; the
//     error status carries provider_quota_exhausted + ResetAt/RootCause payload.
//  2. Transient error: auto-retry within the same turn (N≤promptRetryLimit);
//     on success the turn ends idle normally; once exhausted, the error
//     status carries provider_transient_error + RootCause/Attempts, and the
//     connection handling matches existing non-quota errors (teardown).
//  3. Peer disconnect / unknown error paths are unchanged (already pinned in
//     error_code_test.go; not repeated here).
//
// Note: errors are injected as plain-text errors (classification is
// text-anchored via full-text match on err.Error()), carrying the same text
// as the JSON string of *RequestError, so classification is identical — the
// chat package does not import the SDK directly (§2.1).

import (
	"errors"
	"testing"
	"time"
)

// quotaErrText is the provider quota-exhaustion text confirmed by the probe
// (verbatim from probe §A/§B).
const quotaErrText = "已达到 5 小时的使用上限。您的限额将在 2026-08-26 16:32:32 重置。"

// lastPayloadOf returns the last status payload in the recorder (thread-safe;
// reuses statusRecorder from reconnect_test.go so a bare struct is not caught
// by -race).
func lastPayloadOf(r *statusRecorder) StatusPayload {
	ss := r.snapshot()
	if len(ss) == 0 {
		return StatusPayload{}
	}
	return ss[len(ss)-1]
}

// waitFinalStatus polls until a final status arrives (skipping intermediate
// prompting) and asserts it equals want.
func waitFinalStatus(t *testing.T, r *statusRecorder, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if p := lastPayloadOf(r); p.Status != "" && p.Status != "prompting" {
			if p.Status != want {
				t.Fatalf("final status = %q (code=%q), want %q", p.Status, p.Code, want)
			}
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for final status %q, last = %+v", want, lastPayloadOf(r))
}

// TestRunPromptQuotaExhaustedKeepsConnection: quota exhaustion must take the
// new branch — the connection is kept (isActive), no retry (count==1), the
// queue is not auto-drained (the queued message is retained verbatim), and
// the error status carries the reset moment and root cause payload.
func TestRunPromptQuotaExhaustedKeepsConnection(t *testing.T) {
	svc, sessionID, fc := newTestService(t)
	svc.promptRetryBackoff = time.Millisecond // quota never retries; keep tests fast regardless
	fc.promptErr = errors.New(quotaErrText)

	// Queue one message: the quota branch must not auto-drain it (every
	// message would hit the same wall, each re-triggering the harness's
	// internal ~33s retry chain).
	if err := svc.EnqueueMessage(sessionID, "queued-1", nil); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	rec := captureStatuses(svc, sessionID)

	if err := svc.SendMessage(sessionID, "hello", nil); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitStarted(t, fc, 1)
	waitFinalStatus(t, rec, "error")

	lastPayload := lastPayloadOf(rec)
	if lastPayload.Code != ErrCodeProviderQuotaExhausted {
		t.Fatalf("Code = %q, want %q", lastPayload.Code, ErrCodeProviderQuotaExhausted)
	}
	if lastPayload.ResetAt != "2026-08-26 16:32:32" {
		t.Fatalf("ResetAt = %q, want the reset moment parsed from the provider message", lastPayload.ResetAt)
	}
	if lastPayload.RootCause != quotaErrText {
		t.Fatalf("RootCause = %q, want provider text %q", lastPayload.RootCause, quotaErrText)
	}
	if lastPayload.Attempts != 1 {
		t.Fatalf("Attempts = %d, want 1 (quota must not auto-retry)", lastPayload.Attempts)
	}

	// The connection must be kept: the JSON-RPC error response means the
	// harness is alive and the connection healthy (probe §B); teardown would
	// kill a healthy harness.
	if !svc.isActive(sessionID) {
		t.Fatal("session must stay active after quota exhaustion (connection preserved)")
	}
	// No auto-retry.
	if got := fc.count(); got != 1 {
		t.Fatalf("expected exactly 1 prompt attempt, got %d", got)
	}
	// Queue is not auto-drained: after a short wait the queued row is still
	// there and no new Prompt happened.
	time.Sleep(50 * time.Millisecond)
	rows, err := svc.st.ListQueueItems(svc.ctx, sessionID)
	if err != nil {
		t.Fatalf("list queue: %v", err)
	}
	if len(rows) != 1 || rows[0].Text != "queued-1" {
		t.Fatalf("queued item must be retained after quota error, got %+v", rows)
	}
	if got := fc.count(); got != 1 {
		t.Fatalf("queued message must NOT auto-send after quota error, got %d prompts", got)
	}
}

// TestRunPromptTransientRetryThenSuccess: a transient error auto-retries
// within the same turn; the third attempt succeeds → normal idle (retries are
// invisible to the frontend, no intermediate error status).
func TestRunPromptTransientRetryThenSuccess(t *testing.T) {
	svc, sessionID, fc := newTestService(t)
	svc.promptRetryBackoff = time.Millisecond
	fc.errSeq = []error{
		errors.New("AI_APICallError: 429 Too Many Requests"),
		errors.New("rate limit reached for requests, please retry later"),
		// Third attempt: errSeq exhausted + promptErr empty → normal block
		// flow (success).
	}

	rec := captureStatuses(svc, sessionID)

	if err := svc.SendMessage(sessionID, "hello", nil); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitStarted(t, fc, 3) // two failures + the third entering
	fc.release()          // release the third (successful) Prompt

	waitFinalStatus(t, rec, "idle")
	if p := lastPayloadOf(rec); p.Code != "" {
		t.Fatalf("recovered turn must carry no error code, got %q", p.Code)
	}
	if got := fc.count(); got != 3 {
		t.Fatalf("expected 3 prompt attempts (2 transient failures + 1 success), got %d", got)
	}
}

// TestRunPromptTransientRetriesExhausted: a transient error keeps failing →
// total attempts = 1 + promptRetryLimit (N≤3); the error status carries
// provider_transient_error + root cause + attempt count; connection handling
// matches existing non-quota errors (teardown).
func TestRunPromptTransientRetriesExhausted(t *testing.T) {
	svc, sessionID, fc := newTestService(t)
	svc.promptRetryBackoff = time.Millisecond
	fc.promptErr = errors.New("The operation timed out")

	rec := captureStatuses(svc, sessionID)

	if err := svc.SendMessage(sessionID, "hello", nil); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitFinalStatus(t, rec, "error")

	lastPayload := lastPayloadOf(rec)
	if lastPayload.Code != ErrCodeProviderTransient {
		t.Fatalf("Code = %q, want %q", lastPayload.Code, ErrCodeProviderTransient)
	}
	if lastPayload.RootCause != "The operation timed out" {
		t.Fatalf("RootCause = %q, want extracted cause", lastPayload.RootCause)
	}
	if want := 1 + promptRetryLimit; lastPayload.Attempts != want {
		t.Fatalf("Attempts = %d, want %d (1 initial + %d retries)", lastPayload.Attempts, want, promptRetryLimit)
	}
	if got := fc.count(); got != 1+promptRetryLimit {
		t.Fatalf("expected %d total prompt attempts, got %d", 1+promptRetryLimit, got)
	}
	// Connection handling matches other non-quota errors: teardown (the next
	// message reconnects via ensureLive).
	if svc.isActive(sessionID) {
		t.Fatal("session should be torn down after transient errors survived retries")
	}
}

// TestRunPromptQuotaDuringRetryStopsRetrying: hitting a quota error mid
// transient-retry → retrying stops immediately (quota is not retryable) and
// the quota branch is taken (connection kept).
func TestRunPromptQuotaDuringRetryStopsRetrying(t *testing.T) {
	svc, sessionID, fc := newTestService(t)
	svc.promptRetryBackoff = time.Millisecond
	fc.errSeq = []error{
		errors.New("503 Service Unavailable"),
		errors.New(quotaErrText), // second attempt: quota → no further retry
	}

	rec := captureStatuses(svc, sessionID)

	if err := svc.SendMessage(sessionID, "hello", nil); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitFinalStatus(t, rec, "error")

	lastPayload := lastPayloadOf(rec)
	if lastPayload.Code != ErrCodeProviderQuotaExhausted {
		t.Fatalf("Code = %q, want %q (quota must stop the retry loop immediately)", lastPayload.Code, ErrCodeProviderQuotaExhausted)
	}
	if lastPayload.Attempts != 2 {
		t.Fatalf("Attempts = %d, want 2 (one transient + one quota, no further retries)", lastPayload.Attempts)
	}
	if !svc.isActive(sessionID) {
		t.Fatal("session must stay active after quota exhaustion")
	}
}

// TestSendAndWaitSyncQuotaKeepsConnection: the synchronous driver path also
// must not tear down the connection on quota (probe §C: the triple error
// applies to the sync path alike).
func TestSendAndWaitSyncQuotaKeepsConnection(t *testing.T) {
	svc, sessionID, fc := newTestService(t)
	fc.promptErr = errors.New(quotaErrText)

	rec := captureStatuses(svc, sessionID)

	if _, err := svc.SendAndWaitSync(sessionID, "hello", nil); err == nil {
		t.Fatal("expected error from SendAndWaitSync on quota exhaustion")
	}
	lastPayload := lastPayloadOf(rec)
	if lastPayload.Status != "error" {
		t.Fatalf("status = %q, want error", lastPayload.Status)
	}
	if lastPayload.Code != ErrCodeProviderQuotaExhausted {
		t.Fatalf("Code = %q, want %q", lastPayload.Code, ErrCodeProviderQuotaExhausted)
	}
	if lastPayload.ResetAt == "" {
		t.Fatal("quota error payload must carry ResetAt")
	}
	if !svc.isActive(sessionID) {
		t.Fatal("session must stay active after quota exhaustion (sync path)")
	}
}
