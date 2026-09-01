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

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
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
	if !strings.Contains(rep.Fork.NewID.Note, "fake-sess-2") {
		t.Fatalf("expected fork id fake-sess-2 in NewID.Note, got %q", rep.Fork.NewID.Note)
	}
}

// forkRows returns the eight P3 report rows keyed by human-readable name.
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
