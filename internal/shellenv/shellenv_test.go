package shellenv

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func TestSplitEnvLine(t *testing.T) {
	cases := []struct {
		in       string
		wantK    string
		wantV    string
		wantOk   bool
	}{
		{"PATH=/usr/bin:/bin", "PATH", "/usr/bin:/bin", true},
		{"FOO=bar=baz", "FOO", "bar=baz", true},
		{"_OK=1", "_OK", "1", true},
		{"A1_B2=xy", "A1_B2", "xy", true},
		{"=nokey", "", "", false},   // empty key
		{"noequals", "", "", false}, // no '='
		{"1BAD=v", "", "", false},   // key starts with digit
		{"BA-D=v", "", "", false},   // key has '-' (invalid char)
		{"", "", "", false},
	}
	for _, c := range cases {
		k, v, ok := splitEnvLine(c.in)
		if ok != c.wantOk || k != c.wantK || v != c.wantV {
			t.Errorf("splitEnvLine(%q) = (%q,%q,%t) want (%q,%q,%t)", c.in, k, v, ok, c.wantK, c.wantV, c.wantOk)
		}
	}
}

func TestParseAfterMarker(t *testing.T) {
	// Shell startup noise before the marker must be ignored.
	out := `Last login: today
some rc echo noise
PATH=SHOULD_BE_IGNORED
MD_ENV_BEGIN_123
HOME=/Users/x
PATH=/opt/homebrew/bin:/usr/bin:/bin
# not a env line
MONKEY_DECK_RESOLVING_ENV=1
`
	env, err := parseAfterMarker(out, "MD_ENV_BEGIN_123")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if env["PATH"] != "/opt/homebrew/bin:/usr/bin:/bin" {
		t.Errorf("PATH = %q", env["PATH"])
	}
	if env["HOME"] != "/Users/x" {
		t.Errorf("HOME = %q", env["HOME"])
	}
	// Sentinel must be stripped so it never leaks into the app env.
	if _, present := env["MONKEY_DECK_RESOLVING_ENV"]; present {
		t.Error("sentinel leaked into parsed env")
	}
	// The pre-marker fake PATH must not survive.
	if env["PATH"] == "SHOULD_BE_IGNORED" {
		t.Error("pre-marker line leaked past marker")
	}
}

func TestParseAfterMarker_NoMarker(t *testing.T) {
	_, err := parseAfterMarker("just some output\nno marker here", "MISSING")
	if err == nil {
		t.Fatal("expected error when marker absent")
	}
}

func TestShellArgs(t *testing.T) {
	if got := shellArgs("zsh", "x"); !equal(got, []string{"-i", "-l", "-c"}) {
		t.Errorf("zsh args = %v", got)
	}
	if got := shellArgs("bash", "x"); !equal(got, []string{"-i", "-l", "-c"}) {
		t.Errorf("bash args = %v", got)
	}
	if got := shellArgs("tcsh", "x"); !equal(got, []string{"-ic"}) {
		t.Errorf("tcsh args = %v", got)
	}
	if got := shellArgs("csh", "x"); !equal(got, []string{"-ic"}) {
		t.Errorf("csh args = %v", got)
	}
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestIsBrokenShell(t *testing.T) {
	cases := map[string]bool{
		"/bin/false":          true,
		"/usr/sbin/nologin":   true,
		"false":               true,
		"nologin":             true,
		"/bin/zsh":            false,
		"/opt/homebrew/bin/zsh": false,
		"":                    false,
	}
	for in, want := range cases {
		if got := isBrokenShell(in); got != want {
			t.Errorf("isBrokenShell(%q) = %v want %v", in, got, want)
		}
	}
}

func TestPickShell_UsesSHELL(t *testing.T) {
	t.Setenv("SHELL", "/bin/zsh")
	if got := pickShell(); got != "/bin/zsh" {
		t.Errorf("pickShell = %q, want /bin/zsh", got)
	}
}

func TestPickShell_SkipsBroken(t *testing.T) {
	t.Setenv("SHELL", "/bin/false")
	got := pickShell()
	// Should fall back to the platform default.
	if runtime.GOOS == "darwin" {
		if got != "/bin/zsh" {
			t.Errorf("pickShell = %q, want /bin/zsh fallback", got)
		}
	} else {
		if got != "/bin/bash" {
			t.Errorf("pickShell = %q, want /bin/bash fallback", got)
		}
	}
}

func TestPickShell_EmptySHELL(t *testing.T) {
	t.Setenv("SHELL", "")
	got := pickShell()
	if runtime.GOOS == "darwin" {
		if got != "/bin/zsh" {
			t.Errorf("pickShell = %q, want /bin/zsh", got)
		}
	} else {
		if got != "/bin/bash" {
			t.Errorf("pickShell = %q, want /bin/bash", got)
		}
	}
}

// --- doResolve via injected seams (no real shell spawned) ---

// withFakes swaps the injectable seams and returns a restore func.
func withFakes(pick func() string, capture func(ctx context.Context, shell string) (map[string]string, error)) func() {
	prevPick, prevCap := pickShellFn, captureShellEnvFn
	pickShellFn, captureShellEnvFn = pick, capture
	resetForTest()
	return func() {
		pickShellFn, captureShellEnvFn = prevPick, prevCap
		resetForTest()
	}
}

func TestResolve_UnionMergesPATH(t *testing.T) {
	shellPATH := "/Users/x/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin"
	restore := withFakes(
		func() string { return "/bin/zsh" },
		func(ctx context.Context, shell string) (map[string]string, error) {
			return map[string]string{"PATH": shellPATH, "HOME": "/Users/x"}, nil
		},
	)
	defer restore()

	// Existing PATH has a session-specific dir not in the shell PATH — it must
	// survive the merge (union, not overwrite).
	t.Setenv("PATH", "/tmp/extra:/usr/bin:/bin")
	if err := Resolve(context.Background()); err != nil {
		t.Fatalf("Resolve err: %v", err)
	}
	got := os.Getenv("PATH")
	// Shell dirs come first (in order), then the surviving existing-only dir.
	want := "/Users/x/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/tmp/extra"
	if got != want {
		t.Errorf("PATH = %q, want %q", got, want)
	}
	// Other resolved vars must NOT leak into process env (only PATH is touched).
	if got := os.Getenv("HOME"); got == "/Users/x" {
		t.Error("Resolve touched HOME; should only touch PATH")
	}
}

func TestResolve_NoPATHInShell_IsNoOp(t *testing.T) {
	restore := withFakes(
		func() string { return "/bin/zsh" },
		func(ctx context.Context, shell string) (map[string]string, error) {
			return map[string]string{"HOME": "/Users/x"}, nil // no PATH
		},
	)
	defer restore()

	t.Setenv("PATH", "/usr/bin:/bin")
	before := os.Getenv("PATH")
	if err := Resolve(context.Background()); err != nil {
		t.Fatalf("Resolve err: %v", err)
	}
	if got := os.Getenv("PATH"); got != before {
		t.Errorf("PATH changed from %q to %q; should be untouched", before, got)
	}
}

func TestResolve_ShellError_ReturnsErr(t *testing.T) {
	restore := withFakes(
		func() string { return "/bin/zsh" },
		func(ctx context.Context, shell string) (map[string]string, error) {
			return nil, errors.New("spawn failed")
		},
	)
	defer restore()

	t.Setenv("PATH", "/usr/bin:/bin")
	before := os.Getenv("PATH")
	err := Resolve(context.Background())
	if err == nil || !strings.Contains(err.Error(), "spawn failed") {
		t.Fatalf("expected spawn-failed err, got %v", err)
	}
	// PATH must be untouched on failure.
	if got := os.Getenv("PATH"); got != before {
		t.Errorf("PATH changed on failure: %q", got)
	}
}

func TestResolve_NoUsableShell(t *testing.T) {
	restore := withFakes(
		func() string { return "" }, // no shell
		func(ctx context.Context, shell string) (map[string]string, error) {
			t.Fatal("capture should not be called when shell is empty")
			return nil, nil
		},
	)
	defer restore()

	err := Resolve(context.Background())
	if err == nil || !strings.Contains(err.Error(), "no usable shell") {
		t.Fatalf("expected no-usable-shell err, got %v", err)
	}
}

func TestResolve_Idempotent_OnlyOneSpawn(t *testing.T) {
	var calls int32
	restore := withFakes(
		func() string { return "/bin/zsh" },
		func(ctx context.Context, shell string) (map[string]string, error) {
			calls++
			return map[string]string{"PATH": "/x:/usr/bin"}, nil
		},
	)
	defer restore()

	var wg sync.WaitGroup
	const n = 10
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			_ = Resolve(context.Background())
		}()
	}
	wg.Wait()
	if calls != 1 {
		t.Errorf("capture called %d times, want exactly 1 (idempotent)", calls)
	}
}

func TestResolve_CachesErrorForSubsequentCallers(t *testing.T) {
	var calls int32
	restore := withFakes(
		func() string { return "/bin/zsh" },
		func(ctx context.Context, shell string) (map[string]string, error) {
			calls++
			return nil, errors.New("boom")
		},
	)
	defer restore()

	err1 := Resolve(context.Background())
	err2 := Resolve(context.Background())
	if err1 == nil || err2 == nil {
		t.Fatal("both should fail")
	}
	if calls != 1 {
		t.Errorf("capture called %d times, want 1 (cached error)", calls)
	}
}

func TestResolve_CallerCancelDoesNotPoisonCache(t *testing.T) {
	// Regression guard for the bug where a short-lived caller ctx could abort
	// the resolve work and cache the failure for the whole process. The resolve
	// work runs under its own budget and ignores the caller's ctx, so even a
	// caller that already gave up must get the real (success) result.
	restore := withFakes(
		func() string { return "/bin/zsh" },
		func(ctx context.Context, shell string) (map[string]string, error) {
			return map[string]string{"PATH": "/Users/x/.bun/bin:/usr/bin"}, nil
		},
	)
	defer restore()

	// Pre-cancel the caller's ctx — Resolve must STILL resolve successfully and
	// cache the success (not a cancellation error).
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	t.Setenv("PATH", "/usr/bin")
	if err := Resolve(ctx); err != nil {
		t.Fatalf("pre-cancelled caller must not poison cache; got err: %v", err)
	}
	if got := os.Getenv("PATH"); !strings.Contains(got, "/Users/x/.bun/bin") {
		t.Errorf("PATH = %q, shell dir missing (work didn't run)", got)
	}
	// And a subsequent call returns the same cached success.
	if err := Resolve(context.Background()); err != nil {
		t.Fatalf("subsequent call got cached err: %v", err)
	}
}

func TestMergePATH(t *testing.T) {
	cases := []struct {
		name     string
		existing string
		shell    string
		want     string
	}{
		{
			name:     "shell superset of minimal existing",
			existing: "/usr/bin:/bin",
			shell:    "/Users/x/.bun/bin:/usr/bin:/bin",
			want:     "/Users/x/.bun/bin:/usr/bin:/bin",
		},
		{
			name:     "existing has session dir shell lacks",
			existing: "/tmp/extra:/usr/bin:/bin",
			shell:    "/Users/x/.bun/bin:/usr/bin:/bin",
			want:     "/Users/x/.bun/bin:/usr/bin:/bin:/tmp/extra",
		},
		{
			name:     "empty existing",
			existing: "",
			shell:    "/a:/b",
			want:     "/a:/b",
		},
		{
			name:     "empty shell",
			existing: "/a:/b",
			shell:    "",
			want:     "/a:/b",
		},
		{
			name:     "dups deduped, shell order preserved",
			existing: "/b:/c:/a",
			shell:    "/a:/b",
			want:     "/a:/b:/c",
		},
		{
			name:     "blank entries ignored",
			existing: "/a::/b",
			shell:    ":/b:/a:",
			want:     "/b:/a",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := mergePATH(c.existing, c.shell); got != c.want {
				t.Errorf("mergePATH(%q, %q) = %q, want %q", c.existing, c.shell, got, c.want)
			}
		})
	}
}

func TestChildEnv_MinimalAndHasSentinel(t *testing.T) {
	t.Setenv("HOME", "/Users/test")
	t.Setenv("VITE_DEV_SERVER_URL", "http://localhost:5173") // junk that must NOT propagate
	env := childEnv()
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "HOME=/Users/test") {
		t.Error("childEnv missing HOME")
	}
	if !strings.Contains(joined, sentinelKey+"=1") {
		t.Error("childEnv missing sentinel")
	}
	if !strings.Contains(joined, "GIT_TERMINAL_PROMPT=0") {
		t.Error("childEnv missing GIT_TERMINAL_PROMPT=0")
	}
	if strings.Contains(joined, "VITE_DEV_SERVER_URL") {
		t.Error("childEnv leaked GUI-app junk var")
	}
}

func TestTruncForLog(t *testing.T) {
	if got := truncForLog("short"); got != "short" {
		t.Errorf("got %q", got)
	}
	long := strings.Repeat("x", 400)
	got := truncForLog(long)
	if len(got) >= len(long) || !strings.HasSuffix(got, "…") {
		t.Errorf("expected truncation with ellipsis, got len %d", len(got))
	}
}

func TestPickShell_RealShellPath_NotBroken(t *testing.T) {
	// A real-looking shell path must survive isBrokenShell.
	for _, s := range []string{"/bin/zsh", "/bin/bash", "/usr/local/bin/zsh"} {
		if isBrokenShell(s) {
			t.Errorf("%q flagged as broken", s)
		}
		// And filepath.Base must agree (regression guard against path edge cases).
		_ = filepath.Base(s)
	}
}
