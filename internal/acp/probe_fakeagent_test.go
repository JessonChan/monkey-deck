package acp

// probe_fakeagent_test.go — regression test for the codebuddy nil-panic bug,
// extended with the #172 fork-probe scenarios (P2 undeclared forced-fork +
// P3 declared roundtrip).
//
// A harness whose initialize response omits the optional agentInfo field used
// to crash ProbeHarness with a nil-pointer dereference at rep.AgentName =
// initResp.AgentInfo.Name; Wails3 recovered the panic into a binding
// CallError, surfacing as "自检失败" in the add-harness modal.
//
// The tests re-execute the test binary itself as a minimal fake ACP harness
// (classic exec helper-process pattern; no real harness, no key, no network —
// §5.1). Scenario is selected via MD_FAKE_HARNESS_MODE (inherited by the
// re-executed child):
//
//	"" / "undeclared" — agentInfo omitted, NO sessionCapabilities: the probe's
//	forced fork (P2) must anchor the wire error -32601 and the roundtrip rows
//	must all be N/A.
//	"declared" — fork/list/resume advertised + loadSession: the full P3
//	roundtrip must pass all eight report rows (new id distinct, source still
//	promptable, new id listed, resumable, configOptions/modes echoed, cwd
//	semantics recorded, chain forked, concurrent prompts both end_turn).
//	"busy-fork" — #191: concurrent dispatch + slow turns (6 chunks, 400ms
//	apart, messageId mt-<n>, text s<n>-<i>) so the busy-fork probe can fork
//	mid-turn; fork snapshots the source transcript at the fork instant;
//	session/load|resume replays the transcript before responding.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestProbeHarnessOmittedAgentInfo(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// NewRunner splits the command on whitespace (no quoting), so a test
	// binary path with spaces cannot be spawned.
	if strings.ContainsAny(exe, " \t") {
		t.Skipf("test binary path contains spaces: %s", exe)
	}
	t.Setenv("MD_FAKE_HARNESS_CHILD", "1")
	// MD_FAKE_HARNESS_MODE left empty → undeclared scenario (no fork capability).

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	rep := ProbeHarness(ctx, fmt.Sprintf("%s -test.run=^TestFakeAgentHelper$ --", exe))

	if rep.Error != "" {
		t.Fatalf("probe error: %s", rep.Error)
	}
	if !rep.Initialized.Pass {
		t.Fatalf("initialized check failed: %+v", rep.Initialized)
	}
	if !rep.CanAdd() {
		t.Fatalf("expected CanAdd=true, got report:\n%s", rep.Summary())
	}
	if rep.AgentName != "" {
		t.Fatalf("expected empty AgentName (agentInfo omitted on the wire), got %q", rep.AgentName)
	}
	if rep.Initialized.Note != "agent=(未自报) protocol=1" {
		t.Fatalf("expected readable fallback in Initialized.Note, got %q", rep.Initialized.Note)
	}
	if !rep.Streamed.Pass || !rep.EmitsMessageId {
		t.Fatalf("expected streamed chunks with messageId, got report:\n%s", rep.Summary())
	}

	// #172 P1/P2: undeclared → forced-fork anchors -32601 in the report and
	// every roundtrip row is explicitly N/A (never silently omitted).
	if rep.Fork.Declared {
		t.Fatalf("expected fork undeclared for the minimal fake, got declared")
	}
	if !strings.Contains(rep.Fork.Force, "-32601") {
		t.Fatalf("expected forced-fork -32601 anchored in report, got force=%q class=%q", rep.Fork.Force, rep.Fork.ForceClass)
	}
	if rep.Fork.ForceClass != "method-not-found" {
		t.Fatalf("expected ForceClass=method-not-found, got %q", rep.Fork.ForceClass)
	}
	for name, cr := range forkRows(&rep.Fork) {
		if !strings.HasPrefix(cr.Note, "N/A") {
			t.Fatalf("fork row %s = %+v, want N/A note (undeclared skips roundtrip)", name, cr)
		}
	}
}

// TestProbeHarnessDeclaredFork — #172 P3: a fork-capable fake agent must pass
// the full declared roundtrip (six questions + chain + concurrent prompts).
func TestProbeHarnessDeclaredFork(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if strings.ContainsAny(exe, " \t") {
		t.Skipf("test binary path contains spaces: %s", exe)
	}
	t.Setenv("MD_FAKE_HARNESS_CHILD", "1")
	t.Setenv("MD_FAKE_HARNESS_MODE", "declared")

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	rep := ProbeHarness(ctx, fmt.Sprintf("%s -test.run=^TestFakeAgentHelper$ --", exe))

	if rep.Error != "" {
		t.Fatalf("probe error: %s", rep.Error)
	}
	if !rep.CanAdd() {
		t.Fatalf("expected CanAdd=true, got report:\n%s", rep.Summary())
	}
	if !rep.Fork.Declared {
		t.Fatalf("expected fork declared, got report:\n%s", rep.Summary())
	}
	if rep.Fork.Force != "" {
		t.Fatalf("declared agent must not be force-forked, got %q", rep.Fork.Force)
	}
	if rep.Fork.Error != "" {
		t.Fatalf("fork probe self-error: %s", rep.Fork.Error)
	}
	for name, cr := range forkRows(&rep.Fork) {
		if !cr.Pass {
			t.Fatalf("fork row %s failed: %+v\nreport:\n%s", name, cr, rep.Summary())
		}
	}
	// #191: the busy-fork section runs BEFORE the P3 roundtrip and mints
	// fake-sess-2 (mid-turn fork); the P3 idle fork is therefore fake-sess-3.
	if !strings.Contains(rep.Fork.NewID.Note, "fake-sess-3") {
		t.Fatalf("expected P3 fork id fake-sess-3 in NewID.Note, got %q", rep.Fork.NewID.Note)
	}
}

// forkRows returns the report rows keyed by human-readable name: the eight P3
// roundtrip rows plus the four #191 busy-fork rows.
func forkRows(f *ForkReport) map[string]CheckResult {
	return map[string]CheckResult{
		"newId":       f.NewID,
		"sourceAlive": f.SourceAlive,
		"inList":      f.InList,
		"resumable":   f.Resumable,
		"echo":        f.Echo,
		"cwd":         f.Cwd,
		"chain":       f.Chain,
		"concurrent":  f.Concurrent,
		"busyFork":    f.BusyFork,
		"busySnap":    f.BusySnap,
		"busySrcOk":   f.BusySrcOK,
		"busyForkUse": f.BusyForkUse,
	}
}

// TestResumeChatSessionUndeclaredResumeWorks — CodeBuddy-like harness that
// implements session/resume but omits the capability declaration (under-declare).
// The recovery path must NOT hard-fail on the declaration gate; it attempts
// session/resume anyway and succeeds. Regression for the CodeBuddy
// "resume session: harness does not advertise sessionCapabilities.resume" error.
func TestResumeChatSessionUndeclaredResumeWorks(t *testing.T) {
	cs := resumeAgainstFake(t, "undeclared-resume-works")
	defer cs.Close()
	if cs == nil {
		t.Fatal("expected a ChatSession (resume succeeded without declaration)")
	}
}

// TestResumeChatSessionFallsBackToLoad — a harness that neither declares nor
// implements session/resume (RPC fails with -32601) but declares loadSession.
// The recovery path must degrade to session/load (context-preserving) instead
// of failing the reopen and dropping conversation history.
func TestResumeChatSessionFallsBackToLoad(t *testing.T) {
	cs := resumeAgainstFake(t, "load-only")
	defer cs.Close()
	if cs == nil {
		t.Fatal("expected a ChatSession recovered via session/load fallback")
	}
}

// resumeAgainstFake spawns the fake harness child in the given mode and drives
// ResumeChatSession for the seeded fake session. Returns the resulting
// ChatSession (or fails the test on error).
func resumeAgainstFake(t *testing.T, mode string) *ChatSession {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if strings.ContainsAny(exe, " \t") {
		t.Skipf("test binary path contains spaces: %s", exe)
	}
	t.Setenv("MD_FAKE_HARNESS_CHILD", "1")
	t.Setenv("MD_FAKE_HARNESS_MODE", mode)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	runner := NewRunner(fmt.Sprintf("%s -test.run=^TestFakeAgentHelper$ --", exe), nil)
	cs, err := runner.ResumeChatSession(ctx, t.TempDir(), "fake-sess-1", nil, func(SessionEvent) {}, nil, nil)
	if err != nil {
		t.Fatalf("ResumeChatSession (mode=%s): %v", mode, err)
	}
	return cs
}

// TestFakeAgentHelper is not a real test: with MD_FAKE_HARNESS_CHILD=1 it acts
// as the fake harness child process; without the env var it returns
// immediately so normal test runs are unaffected.
func TestFakeAgentHelper(t *testing.T) {
	if os.Getenv("MD_FAKE_HARNESS_CHILD") != "1" {
		return
	}
	fakeAgentMain()
	// Exit before the testing framework prints its PASS banner — stdout is
	// the JSON-RPC channel and must stay clean.
	os.Exit(0)
}

// fakeAgentMain speaks a minimal ACP JSON-RPC dialect on stdio (newline-
// delimited JSON, matching the SDK's bufio.Scanner framing).
//
// Scenario via MD_FAKE_HARNESS_MODE ("" / "undeclared" | "declared"):
//
//	undeclared — initialize advertises NO sessionCapabilities (and omits
//	agentInfo); session/fork falls through to the default method-not-found
//	branch so the probe's forced fork anchors -32601 on the wire.
//	declared — initialize advertises fork/list/resume/close + loadSession;
//	session/new returns one model configOption + mode state, which fork /
//	load / resume / set_config echo verbatim (⑤ consistency); session/fork
//	mints fake-sess-N; session/list enumerates minted ids; prompt answers any
//	known session.
//
// Prompt answers are positional: the 2nd prompt is the probe's cancel probe
// (the client arms session/cancel on its first update) and gets
// stopReason=cancelled; every other prompt ends with end_turn. Everything
// unknown gets -32601.
func fakeAgentMain() {
	if os.Getenv("MD_FAKE_HARNESS_MODE") == "busy-fork" {
		fakeAgentBusyForkMain()
		return
	}
	declared := os.Getenv("MD_FAKE_HARNESS_MODE") == "declared"
	// Scenario knobs (beyond the two fork-probe modes):
	//   undeclared-resume-works — CodeBuddy-like: resume NOT declared in
	//     initialize, but the session/resume RPC actually succeeds (under-declare).
	//   load-only — resume NOT declared AND session/resume fails on the wire, but
	//     loadSession is declared and session/load succeeds (the true fallback case).
	// Both default to false for the ""/undeclared and "declared" modes.
	mode := os.Getenv("MD_FAKE_HARNESS_MODE")
	resumeWorks := declared || mode == "undeclared-resume-works"
	loadWorks := declared || mode == "undeclared-resume-works" || mode == "load-only"
	loadDeclared := declared || mode == "undeclared-resume-works" || mode == "load-only"

	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	out := bufio.NewWriter(os.Stdout)
	enc := func(v any) {
		b, _ := json.Marshal(v)
		out.Write(b)
		out.WriteByte('\n')
		_ = out.Flush()
	}

	type rpcMsg struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			SessionId string `json:"sessionId"`
		} `json:"params"`
	}

	// Session registry: session/new seeds fake-sess-1; declared forks mint
	// fake-sess-N. nextID doubles as the deterministic enumeration bound for
	// session/list (ids 1..nextID-1 that are still open).
	sessions := map[string]bool{"fake-sess-1": true}
	nextID := 2
	prompts := 0

	// sessionConfig (declared mode only): one model select + one mode state,
	// echoed verbatim by fork/load/resume/set_config responses.
	sessionConfig := func() (opts []any, modes any) {
		if !declared {
			return []any{}, nil
		}
		opts = []any{map[string]any{
			"type":         "select",
			"id":           "model",
			"name":         "Model",
			"category":     "model",
			"currentValue": "fake-model",
			"options":      []any{map[string]any{"value": "fake-model", "name": "Fake Model"}},
		}}
		modes = map[string]any{
			"currentModeId": "code",
			"availableModes": []any{
				map[string]any{"id": "code", "name": "Code"},
			},
		}
		return opts, modes
	}
	withModes := func(result map[string]any) map[string]any {
		if _, modes := sessionConfig(); modes != nil {
			result["modes"] = modes
		}
		return result
	}

	for sc.Scan() {
		var m rpcMsg
		if json.Unmarshal(sc.Bytes(), &m) != nil || m.Method == "" || len(m.ID) == 0 {
			continue // notification or malformed line: nothing to answer
		}
		defaultErr := func() {
			enc(map[string]any{
				"jsonrpc": "2.0",
				"id":      m.ID,
				"error":   map[string]any{"code": -32601, "message": "method not found: " + m.Method},
			})
		}
		switch m.Method {
		case "initialize":
			sessCaps := map[string]any{}
			if declared {
				sessCaps = map[string]any{
					"fork":   map[string]any{},
					"list":   map[string]any{},
					"resume": map[string]any{},
					"close":  map[string]any{},
				}
			}
			enc(map[string]any{
				"jsonrpc": "2.0",
				"id":      m.ID,
				"result": map[string]any{
					"protocolVersion": 1,
					// agentInfo intentionally omitted — the regression scenario.
					"agentCapabilities": map[string]any{
						"loadSession":         loadDeclared,
						"promptCapabilities":  map[string]any{},
						"sessionCapabilities": sessCaps,
					},
				},
			})
		case "session/new":
			opts, _ := sessionConfig()
			enc(map[string]any{
				"jsonrpc": "2.0",
				"id":      m.ID,
				"result":  withModes(map[string]any{"sessionId": "fake-sess-1", "configOptions": opts}),
			})
		case "session/prompt":
			prompts++
			stop := "end_turn"
			if prompts == 2 {
				stop = "cancelled" // cancel probe expects stopReason=cancelled
			}
			sid := m.Params.SessionId
			if sid == "" {
				sid = "fake-sess-1"
			}
			enc(map[string]any{
				"jsonrpc": "2.0",
				"method":  "session/update",
				"params": map[string]any{
					"sessionId": sid,
					"update": map[string]any{
						"sessionUpdate": "agent_message_chunk",
						"content":       map[string]any{"type": "text", "text": "OK"},
						"messageId":     fmt.Sprintf("m%d", prompts),
					},
				},
			})
			enc(map[string]any{
				"jsonrpc": "2.0",
				"id":      m.ID,
				"result":  map[string]any{"stopReason": stop},
			})
		case "session/fork":
			if !declared {
				defaultErr() // undeclared: wire-level method-not-found (P2 anchor)
				continue
			}
			if !sessions[m.Params.SessionId] {
				enc(map[string]any{
					"jsonrpc": "2.0",
					"id":      m.ID,
					"error":   map[string]any{"code": -32602, "message": "unknown session: " + m.Params.SessionId},
				})
				continue
			}
			id := fmt.Sprintf("fake-sess-%d", nextID)
			nextID++
			sessions[id] = true
			opts, _ := sessionConfig()
			enc(map[string]any{
				"jsonrpc": "2.0",
				"id":      m.ID,
				"result":  withModes(map[string]any{"sessionId": id, "configOptions": opts}),
			})
		case "session/list":
			if !declared {
				defaultErr()
				continue
			}
			ids := make([]string, 0, len(sessions))
			for id := range sessions {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			list := make([]any, 0, len(ids))
			for _, id := range ids {
				list = append(list, map[string]any{"sessionId": id, "cwd": "/tmp/fake-agent"})
			}
			enc(map[string]any{
				"jsonrpc": "2.0",
				"id":      m.ID,
				"result":  map[string]any{"sessions": list},
			})
		case "session/resume":
			if !resumeWorks {
				defaultErr()
				continue
			}
			if !sessions[m.Params.SessionId] {
				enc(map[string]any{
					"jsonrpc": "2.0",
					"id":      m.ID,
					"error":   map[string]any{"code": -32602, "message": "unknown session: " + m.Params.SessionId},
				})
				continue
			}
			opts, _ := sessionConfig()
			enc(map[string]any{
				"jsonrpc": "2.0",
				"id":      m.ID,
				"result":  withModes(map[string]any{"configOptions": opts}),
			})
		case "session/load":
			if !loadWorks {
				defaultErr()
				continue
			}
			if !sessions[m.Params.SessionId] {
				enc(map[string]any{
					"jsonrpc": "2.0",
					"id":      m.ID,
					"error":   map[string]any{"code": -32602, "message": "unknown session: " + m.Params.SessionId},
				})
				continue
			}
			opts, _ := sessionConfig()
			enc(map[string]any{
				"jsonrpc": "2.0",
				"id":      m.ID,
				"result":  withModes(map[string]any{"configOptions": opts}),
			})
		case "session/set_config_option":
			if !declared {
				defaultErr()
				continue
			}
			opts, _ := sessionConfig()
			enc(map[string]any{
				"jsonrpc": "2.0",
				"id":      m.ID,
				"result":  withModes(map[string]any{"configOptions": opts}),
			})
		case "session/close":
			if !declared {
				defaultErr()
				continue
			}
			delete(sessions, m.Params.SessionId)
			enc(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{}})
		default:
			defaultErr()
		}
	}
}

// TestProbeHarnessBusyFork — #191: the busy-fork scenario (source turn in
// flight). The fake streams a slow turn; the probe forks mid-turn and must
// observe: ① fork RPC succeeds; ② the fork's replayed context contains the
// IN-FLIGHT partial reply (busy turn = turn 3 after main+cancel probes, so the
// snapshot carries "s3-*" chunks but not the final "s3-6"); ③ the source turn
// completes undisturbed (end_turn, full output); ④ a serial prompt on the
// fork row works. The P3 rows must stay green on the same session afterwards.
func TestProbeHarnessBusyFork(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if strings.ContainsAny(exe, " \t") {
		t.Skipf("test binary path contains spaces: %s", exe)
	}
	t.Setenv("MD_FAKE_HARNESS_CHILD", "1")
	t.Setenv("MD_FAKE_HARNESS_MODE", "busy-fork")

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	rep := ProbeHarness(ctx, fmt.Sprintf("%s -test.run=^TestFakeAgentHelper$ --", exe))

	if rep.Error != "" {
		t.Fatalf("probe error: %s", rep.Error)
	}
	if !rep.CanAdd() {
		t.Fatalf("expected CanAdd=true, got report:\n%s", rep.Summary())
	}
	if !rep.Fork.Declared {
		t.Fatalf("expected fork declared, got report:\n%s", rep.Summary())
	}
	if rep.Fork.Error != "" {
		t.Fatalf("fork probe self-error: %s", rep.Fork.Error)
	}
	// Row notes are the worklog evidence for the four-item measurement.
	t.Logf("busy-fork(#191): ①fork=%+v\n②snap=%+v\n③src=%+v\n④use=%+v",
		rep.Fork.BusyFork, rep.Fork.BusySnap, rep.Fork.BusySrcOK, rep.Fork.BusyForkUse)
	// ① mid-turn fork RPC succeeded.
	if !rep.Fork.BusyFork.Pass {
		t.Fatalf("busy fork failed: %+v\nreport:\n%s", rep.Fork.BusyFork, rep.Summary())
	}
	// ② snapshot point includes the in-flight partial (s3-* prefix, not s3-6).
	if !rep.Fork.BusySnap.Pass {
		t.Fatalf("busy snapshot check failed: %+v", rep.Fork.BusySnap)
	}
	if !strings.Contains(rep.Fork.BusySnap.Note, "s3-1") || strings.Contains(rep.Fork.BusySnap.Note, "s3-6") {
		t.Fatalf("snapshot must contain the in-flight partial (s3-1, not s3-6), got %q", rep.Fork.BusySnap.Note)
	}
	// ③ source turn undisturbed: end_turn + full output (s3-6 in the tail).
	if !rep.Fork.BusySrcOK.Pass || !strings.Contains(rep.Fork.BusySrcOK.Note, "s3-6") {
		t.Fatalf("source turn disturbed: %+v", rep.Fork.BusySrcOK)
	}
	// ④ serial prompt on the fork row works.
	if !rep.Fork.BusyForkUse.Pass {
		t.Fatalf("fork row unusable after busy fork: %+v", rep.Fork.BusyForkUse)
	}
	// The P3 idle roundtrip must stay green on the same session afterwards.
	for name, cr := range forkRows(&rep.Fork) {
		if !cr.Pass {
			t.Fatalf("fork row %s failed: %+v\nreport:\n%s", name, cr, rep.Summary())
		}
	}
}

// fakeAgentBusyForkMain speaks the same minimal ACP dialect as the declared
// scenario, modeling a BUSY source (#191 busy-fork probe):
//
//   - Requests dispatch concurrently (one goroutine each), so session/fork can
//     arrive while a turn is streaming; shared state + the stdout writer are
//     mutex-guarded.
//   - Turns are slow: 6 agent_message_chunk updates, text "s<n>-<i>" (n = turn
//     seq), 400ms apart, all sharing messageId "mt-<n>"; session/cancel aborts
//     the in-flight turn with stopReason=cancelled (the probe's cancel probe).
//   - Each session carries a transcript of streamed chunks. session/fork
//     snapshots the source transcript AT THE FORK INSTANT into the fork, and
//     session/load|resume replays the transcript before responding — that
//     replay is the client-side observation surface for the fork's context
//     snapshot point.
func fakeAgentBusyForkMain() {
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	out := bufio.NewWriter(os.Stdout)

	type transEntry struct{ text, msgID string }
	var (
		stMu     sync.Mutex
		outMu    sync.Mutex
		sessions = map[string]*[]transEntry{"fake-sess-1": {}}
		cancels  = map[string]chan struct{}{}
		nextID   = 2
		turnSeq  = 0
	)
	enc := func(v any) {
		b, _ := json.Marshal(v)
		outMu.Lock()
		out.Write(b)
		out.WriteByte('\n')
		_ = out.Flush()
		outMu.Unlock()
	}
	errResp := func(id json.RawMessage, code int, msg string) {
		enc(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": msg}})
	}
	opts := func() []any {
		return []any{map[string]any{
			"type": "select", "id": "model", "name": "Model", "category": "model",
			"currentValue": "fake-model",
			"options":      []any{map[string]any{"value": "fake-model", "name": "Fake Model"}},
		}}
	}
	withModes := func(result map[string]any) map[string]any {
		result["modes"] = map[string]any{
			"currentModeId":  "code",
			"availableModes": []any{map[string]any{"id": "code", "name": "Code"}},
		}
		return result
	}

	for sc.Scan() {
		var m struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params struct {
				SessionId string `json:"sessionId"`
			} `json:"params"`
		}
		if json.Unmarshal(sc.Bytes(), &m) != nil || m.Method == "" {
			continue
		}
		// session/cancel is a notification: abort the session's in-flight turn.
		if m.Method == "session/cancel" {
			stMu.Lock()
			ch := cancels[m.Params.SessionId]
			stMu.Unlock()
			if ch != nil {
				close(ch)
			}
			continue
		}
		if len(m.ID) == 0 {
			continue
		}
		go func() {
			switch m.Method {
			case "initialize":
				enc(map[string]any{
					"jsonrpc": "2.0",
					"id":      m.ID,
					"result": map[string]any{
						"protocolVersion": 1,
						"agentCapabilities": map[string]any{
							"loadSession":        true,
							"promptCapabilities": map[string]any{},
							"sessionCapabilities": map[string]any{
								"fork": map[string]any{}, "list": map[string]any{},
								"resume": map[string]any{}, "close": map[string]any{},
							},
						},
					},
				})
			case "session/new":
				enc(map[string]any{
					"jsonrpc": "2.0",
					"id":      m.ID,
					"result":  withModes(map[string]any{"sessionId": "fake-sess-1", "configOptions": opts()}),
				})
			case "session/prompt":
				sid := m.Params.SessionId
				if sid == "" {
					sid = "fake-sess-1"
				}
				stMu.Lock()
				tr, ok := sessions[sid]
				if !ok {
					stMu.Unlock()
					errResp(m.ID, -32602, "unknown session: "+sid)
					return
				}
				turnSeq++
				n := turnSeq
				cancel := make(chan struct{})
				cancels[sid] = cancel
				stMu.Unlock()
				msgID := fmt.Sprintf("mt-%d", n)
				stop := "end_turn"
			loop:
				for i := 1; i <= 6; i++ {
					text := fmt.Sprintf("s%d-%d", n, i)
					stMu.Lock()
					*tr = append(*tr, transEntry{text, msgID})
					stMu.Unlock()
					enc(map[string]any{
						"jsonrpc": "2.0",
						"method":  "session/update",
						"params": map[string]any{
							"sessionId": sid,
							"update": map[string]any{
								"sessionUpdate": "agent_message_chunk",
								"content":       map[string]any{"type": "text", "text": text},
								"messageId":     msgID,
							},
						},
					})
					select {
					case <-cancel:
						stop = "cancelled"
						break loop
					case <-time.After(400 * time.Millisecond):
					}
				}
				stMu.Lock()
				delete(cancels, sid)
				stMu.Unlock()
				enc(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{"stopReason": stop}})
			case "session/fork":
				stMu.Lock()
				src, ok := sessions[m.Params.SessionId]
				if !ok {
					stMu.Unlock()
					errResp(m.ID, -32602, "unknown session: "+m.Params.SessionId)
					return
				}
				// Snapshot the source transcript at the fork instant: chunks
				// streamed AFTER this point belong to the source alone.
				snap := append([]transEntry(nil), *src...)
				id := fmt.Sprintf("fake-sess-%d", nextID)
				nextID++
				sessions[id] = &snap
				stMu.Unlock()
				enc(map[string]any{
					"jsonrpc": "2.0",
					"id":      m.ID,
					"result":  withModes(map[string]any{"sessionId": id, "configOptions": opts()}),
				})
			case "session/list":
				stMu.Lock()
				ids := make([]string, 0, len(sessions))
				for id := range sessions {
					ids = append(ids, id)
				}
				stMu.Unlock()
				sort.Strings(ids)
				list := make([]any, 0, len(ids))
				for _, id := range ids {
					list = append(list, map[string]any{"sessionId": id, "cwd": "/tmp/fake-agent"})
				}
				enc(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{"sessions": list}})
			case "session/load", "session/resume":
				stMu.Lock()
				tr, ok := sessions[m.Params.SessionId]
				if !ok {
					stMu.Unlock()
					errResp(m.ID, -32602, "unknown session: "+m.Params.SessionId)
					return
				}
				replay := append([]transEntry(nil), *tr...)
				stMu.Unlock()
				// Replay history BEFORE the response (deterministic window).
				for _, e := range replay {
					enc(map[string]any{
						"jsonrpc": "2.0",
						"method":  "session/update",
						"params": map[string]any{
							"sessionId": m.Params.SessionId,
							"update": map[string]any{
								"sessionUpdate": "agent_message_chunk",
								"content":       map[string]any{"type": "text", "text": e.text},
								"messageId":     e.msgID,
							},
						},
					})
				}
				enc(map[string]any{
					"jsonrpc": "2.0",
					"id":      m.ID,
					"result":  withModes(map[string]any{"configOptions": opts()}),
				})
			case "session/set_config_option":
				enc(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{"configOptions": opts()}})
			case "session/close":
				stMu.Lock()
				delete(sessions, m.Params.SessionId)
				if ch := cancels[m.Params.SessionId]; ch != nil {
					delete(cancels, m.Params.SessionId)
				}
				stMu.Unlock()
				enc(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{}})
			default:
				errResp(m.ID, -32601, "method not found: "+m.Method)
			}
		}()
	}
}
