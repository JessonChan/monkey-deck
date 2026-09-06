//go:build integration

package acp

// codexacp_integration_test.go — #196 phase-3 bridge verification: the codex-cli
// catalog entry's pinned ACPCommand ("codex-acp", Zed's adapter, bare command) is
// the spawn form Discover/ensureCatalogHarness now materialize. Tier-1 = spawn +
// initialize via the standard conformance probe; skip-if-missing, same contract as
// probe_codebuddy_test.go. The `codex` binary itself was matrix-judged unusable
// (immediate exit — not ACP-speaking), so this adapter is the only channel.
//
// go test -tags=integration -run TestProbeCodexACP -v ./internal/acp/ -timeout 300s

import (
	"context"
	"os/exec"
	"testing"
	"time"
)

func TestProbeCodexACP(t *testing.T) {
	if _, err := exec.LookPath("codex-acp"); err != nil {
		t.Skip("codex-acp adapter not installed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	rep := ProbeHarness(ctx, "codex-acp")
	t.Logf("\n%s", rep.Summary())
	if rep.Error != "" {
		t.Fatalf("probe error: %s", rep.Error)
	}
	if !rep.CanAdd() {
		t.Fatalf("expected CanAdd=true for codex-acp")
	}
}
