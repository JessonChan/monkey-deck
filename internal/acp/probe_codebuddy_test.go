//go:build integration

package acp

// probe_codebuddy_test.go — real-harness probe for `codebuddy --acp`
// (v2.141.0): its initialize response omits the optional agentInfo field,
// which used to nil-panic the probe (see probe_fakeagent_test.go for the
// mocked regression). Verifies the real harness passes the full conformance
// probe after the nil-safe fix.
//
// go test -tags=integration -run TestProbeCodebuddyACP -v ./internal/acp/ -timeout 300s

import (
	"context"
	"os/exec"
	"testing"
	"time"
)

func TestProbeCodebuddyACP(t *testing.T) {
	if _, err := exec.LookPath("codebuddy"); err != nil {
		t.Skip("codebuddy not installed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	rep := ProbeHarness(ctx, "codebuddy --acp")
	t.Logf("\n%s", rep.Summary())
	if rep.Error != "" {
		t.Fatalf("probe error: %s", rep.Error)
	}
	if !rep.CanAdd() {
		t.Fatalf("expected CanAdd=true for codebuddy --acp")
	}
}
