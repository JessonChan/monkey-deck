package chat

// browse_test.go: web directory browser bindings (#128) — BrowseRoots /
// BrowseDir are pure read-only fs listings, so they are tested against
// temp directories without any store or harness (§5.1/§5.2).

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/config"
)

func newBrowseTestService(t *testing.T) *ChatService {
	t.Helper()
	return NewChatService(&config.Config{DataDir: t.TempDir()})
}

func TestBrowseRootsIncludesHomeAndRoot(t *testing.T) {
	s := newBrowseTestService(t)
	roots, err := s.BrowseRoots()
	if err != nil {
		t.Fatalf("BrowseRoots: %v", err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no home dir: %v", err)
	}
	var hasHome, hasSlash bool
	seen := map[string]int{}
	for _, r := range roots {
		seen[r.Path]++
		if r.Path == home {
			hasHome = true
			if r.Name != "~" {
				t.Errorf("home root name = %q, want ~", r.Name)
			}
		}
		if r.Path == "/" {
			hasSlash = true
		}
	}
	if !hasHome {
		t.Errorf("roots missing home %q: %+v", home, roots)
	}
	if !hasSlash {
		t.Errorf("roots missing filesystem root \"/\": %+v", roots)
	}
	for p, n := range seen {
		if n > 1 {
			t.Errorf("duplicate root path %q appears %d times", p, n)
		}
	}
}

func TestBrowseDirListsSubdirsSortedDirsOnly(t *testing.T) {
	s := newBrowseTestService(t)
	base := t.TempDir()
	// Mix of dirs and files in non-sorted creation order; names chosen so
	// case-insensitive ordering differs from creation order.
	for _, d := range []string{"zeta", "Alpha", "beta", ".hidden"} {
		if err := os.Mkdir(filepath.Join(base, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(base, "afile.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := s.BrowseDir(base)
	if err != nil {
		t.Fatalf("BrowseDir: %v", err)
	}
	if res.Path != base {
		t.Errorf("Path = %q, want %q", res.Path, base)
	}
	var names []string
	for _, d := range res.Dirs {
		names = append(names, d.Name)
		if d.Path != filepath.Join(base, d.Name) {
			t.Errorf("entry %q path = %q, want %q", d.Name, d.Path, filepath.Join(base, d.Name))
		}
	}
	want := []string{".hidden", "Alpha", "beta", "zeta"}
	if len(names) != len(want) {
		t.Fatalf("dirs = %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("dirs = %v, want %v (dirs-only + case-insensitive sort)", names, want)
		}
	}
}

func TestBrowseDirParentAndRoot(t *testing.T) {
	s := newBrowseTestService(t)
	base := t.TempDir()
	sub := filepath.Join(base, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	res, err := s.BrowseDir(sub)
	if err != nil {
		t.Fatalf("BrowseDir(sub): %v", err)
	}
	if res.Parent != base {
		t.Errorf("Parent = %q, want %q", res.Parent, base)
	}

	// Navigating above home must keep working up to the filesystem root,
	// where Parent becomes empty.
	cur := base
	for i := 0; i < 64; i++ {
		res, err := s.BrowseDir(cur)
		if err != nil {
			t.Fatalf("BrowseDir(%q): %v", cur, err)
		}
		if res.Parent == "" {
			if cur != "/" && runtime.GOOS != "windows" {
				t.Errorf("empty Parent at non-root %q", cur)
			}
			return
		}
		cur = res.Parent
	}
	t.Fatal("walked 64 levels without reaching the filesystem root")
}

func TestBrowseDirRejectsRelativeAndMissing(t *testing.T) {
	s := newBrowseTestService(t)
	if _, err := s.BrowseDir("relative/path"); err == nil {
		t.Error("relative path accepted, want error")
	}
	if _, err := s.BrowseDir(""); err == nil {
		t.Error("empty path accepted, want error")
	}
	missing := filepath.Join(t.TempDir(), "nope")
	if _, err := s.BrowseDir(missing); err == nil {
		t.Error("missing path accepted, want error")
	}
	file := filepath.Join(t.TempDir(), "f.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.BrowseDir(file); err == nil {
		t.Error("plain file accepted, want error")
	}
}

func TestBrowseDirFollowsDirSymlinksSkipsBroken(t *testing.T) {
	s := newBrowseTestService(t)
	base := t.TempDir()
	target := filepath.Join(base, "target")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(base, "alias")); err != nil {
		t.Skipf("symlink: %v", err)
	}
	if err := os.Symlink(filepath.Join(base, "gone"), filepath.Join(base, "broken")); err != nil {
		t.Skipf("symlink: %v", err)
	}
	res, err := s.BrowseDir(base)
	if err != nil {
		t.Fatalf("BrowseDir: %v", err)
	}
	names := map[string]bool{}
	for _, d := range res.Dirs {
		names[d.Name] = true
	}
	if !names["alias"] {
		t.Errorf("dir symlink missing from listing: %v", res.Dirs)
	}
	if names["broken"] {
		t.Errorf("broken symlink listed as descendable: %v", res.Dirs)
	}
}
