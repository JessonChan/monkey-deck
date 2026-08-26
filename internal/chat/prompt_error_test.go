package chat

// prompt_error_test.go:Prompt 错误分类 + N≤3 重试 + emitError payload 的
// service 级行为测试(#46 步骤 2)。
//
// 事实基础:docs/worklog/2026-08-26-quota-exhaustion-probe-46.md——配额耗尽以
// session/prompt 的 JSON-RPC error response 收场(harness 活着、连接健康),
// 一刀切 teardown+重连是三重错误(误杀健康 harness / 无意义重连 / 丢失重置时刻)。
// 钉死三条不变量:
//  1. 配额耗尽:不 teardown、不重连、不续发队列;error 状态携带
//     provider_quota_exhausted + ResetAt/RootCause payload。
//  2. 瞬态错误:同 turn 内自动重试(N≤promptRetryLimit),成功则正常 idle;
//     耗尽后 error 状态携带 provider_transient_error + RootCause/Attempts,
//     连接处置与既有非配额错误一致(teardown)。
//  3. peer 断连 / 未知错误路径原样(error_code_test.go 已钉死,此处不重复)。
//
// 注:错误注入用纯文本 error(分类是文本锚定,err.Error() 全文匹配),与
// *RequestError 的 JSON 串含同一文本,分类结果一致——chat 包不直接 import SDK(§2.1)。

import (
	"errors"
	"testing"
	"time"
)

// quotaErrText 是探针实证的配额耗尽 provider 文本(probe §A/§B 原文)。
const quotaErrText = "已达到 5 小时的使用上限。您的限额将在 2026-08-26 16:32:32 重置。"

// lastPayloadOf 返回 recorder 里最后一条 status payload(线程安全;复用
// reconnect_test.go 的 statusRecorder,避免裸 struct 被 -race 抓)。
func lastPayloadOf(r *statusRecorder) StatusPayload {
	ss := r.snapshot()
	if len(ss) == 0 {
		return StatusPayload{}
	}
	return ss[len(ss)-1]
}

// waitFinalStatus 轮询等终态(跳过中间 prompting),断言为 want。
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

// TestRunPromptQuotaExhaustedKeepsConnection:配额耗尽必须走新分支——
// 连接保留(isActive)、不重试(count==1)、不续发队列(排队消息原样保留)、
// error 状态携带重置时刻与根因 payload。
func TestRunPromptQuotaExhaustedKeepsConnection(t *testing.T) {
	svc, sessionID, fc := newTestService(t)
	svc.promptRetryBackoff = time.Millisecond // quota never retries; keep tests fast regardless
	fc.promptErr = errors.New(quotaErrText)

	// 排队一条消息:配额分支不得自动续发(每条都会撞同一堵墙,各触发
	// harness 内部 ~33s 重试链)。
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

	// 连接必须保留:JSON-RPC error response 到达 = harness 活着、连接健康
	// (probe §B);teardown 会误杀健康 harness。
	if !svc.isActive(sessionID) {
		t.Fatal("session must stay active after quota exhaustion (connection preserved)")
	}
	// 无自动重试。
	if got := fc.count(); got != 1 {
		t.Fatalf("expected exactly 1 prompt attempt, got %d", got)
	}
	// 队列不自动续发:等一小段时间后排阧行仍在、也没有新 Prompt。
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

// TestRunPromptTransientRetryThenSuccess:瞬态错误在同 turn 内自动重试,
// 第三次尝试成功 → 正常 idle(重试对前端不可见,无中间 error 状态)。
func TestRunPromptTransientRetryThenSuccess(t *testing.T) {
	svc, sessionID, fc := newTestService(t)
	svc.promptRetryBackoff = time.Millisecond
	fc.errSeq = []error{
		errors.New("AI_APICallError: 429 Too Many Requests"),
		errors.New("rate limit reached for requests, please retry later"),
		// 第三次:errSeq 耗尽 + promptErr 空 → 正常 block 流程(成功)。
	}

	rec := captureStatuses(svc, sessionID)

	if err := svc.SendMessage(sessionID, "hello", nil); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitStarted(t, fc, 3) // 两次失败 + 第三次进入
	fc.release()          // 放行第三次(成功的)Prompt

	waitFinalStatus(t, rec, "idle")
	if p := lastPayloadOf(rec); p.Code != "" {
		t.Fatalf("recovered turn must carry no error code, got %q", p.Code)
	}
	if got := fc.count(); got != 3 {
		t.Fatalf("expected 3 prompt attempts (2 transient failures + 1 success), got %d", got)
	}
}

// TestRunPromptTransientRetriesExhausted:瞬态错误持续失败 → 总尝试次数
// = 1 + promptRetryLimit(N≤3);error 状态携带 provider_transient_error +
// 根因 + 尝试次数;连接处置与既有非配额错误一致(teardown)。
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
	// 连接处置与其它非配额错误一致:teardown(下条消息 ensureLive 重连)。
	if svc.isActive(sessionID) {
		t.Fatal("session should be torn down after transient errors survived retries")
	}
}

// TestRunPromptQuotaDuringRetryStopsRetrying:瞬态重试途中撞上配额错误 →
// 立即停止重试(配额不可重试)、走配额分支(连接保留)。
func TestRunPromptQuotaDuringRetryStopsRetrying(t *testing.T) {
	svc, sessionID, fc := newTestService(t)
	svc.promptRetryBackoff = time.Millisecond
	fc.errSeq = []error{
		errors.New("503 Service Unavailable"),
		errors.New(quotaErrText), // 第二次:配额 → 不再重试
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

// TestSendAndWaitSyncQuotaKeepsConnection:同步驱动路径同样不因配额拆连接
// (probe §C:三重错误对 sync 路径同样成立)。
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
