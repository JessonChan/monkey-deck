package chat

// Web directory browser (#128): read-only bindings that let remote browser /
// PWA clients pick a project directory without a host-native dialog.
// PickDirectory opens a native OS dialog on the desktop host, which does
// nothing visible over the remote connection (same class of problem as the
// PickFiles paperclip, AGENTS.md §1.8) — the frontend branches on
// isRemoteClient() and opens DirBrowserModal instead, driven by these two
// bindings. Strictly read-only: listing directories only, no file content,
// no writes.

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// BrowseEntry is one row of the web directory browser: a display name plus
// the absolute path it points at.
type BrowseEntry struct {
	Name string `json:"name"`
	Path string `json:"path"` // absolute path
}

// BrowseDirResult is the BrowseDir response: the resolved directory, its
// parent (empty at the filesystem root, so the frontend knows to fall back
// to the roots view), and its immediate subdirectories.
type BrowseDirResult struct {
	Path   string        `json:"path"`
	Parent string        `json:"parent"`
	Dirs   []BrowseEntry `json:"dirs"`
}

// BrowseRoots lists the starting locations for the web directory browser:
// the user's home directory first (where code projects usually live), then
// mounted volumes (macOS) or the filesystem root. Read-only.
func (s *ChatService) BrowseRoots() ([]BrowseEntry, error) {
	var roots []BrowseEntry
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		roots = append(roots, BrowseEntry{Name: "~", Path: home})
	}
	roots = append(roots, volumeRoots()...)
	// Deduplicate by path (e.g. a volume whose path resolves to "/" on some
	// setups); first occurrence wins, preserving the home-first order.
	seen := map[string]struct{}{}
	out := roots[:0]
	for _, r := range roots {
		if _, dup := seen[r.Path]; dup {
			continue
		}
		seen[r.Path] = struct{}{}
		out = append(out, r)
	}
	return out, nil
}

// volumeRoots lists mount points below the home directory: on macOS the
// /Volumes children (external drives + the boot volume), plus the filesystem
// root itself on every platform.
func volumeRoots() []BrowseEntry {
	var out []BrowseEntry
	if runtime.GOOS == "darwin" {
		if vols, err := os.ReadDir("/Volumes"); err == nil {
			for _, v := range vols {
				full := filepath.Join("/Volumes", v.Name())
				if st, err := os.Stat(full); err == nil && st.IsDir() {
					out = append(out, BrowseEntry{Name: v.Name(), Path: full})
				}
			}
			sort.Slice(out, func(i, j int) bool {
				return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
			})
		}
	}
	return append(out, BrowseEntry{Name: "/", Path: "/"})
}

// BrowseDir lists the immediate subdirectories of dir (an absolute path),
// sorted case-insensitively by name. Hidden (dot-prefixed) directories are
// included — the native picker shows them too, and project roots like
// ~/.config/... are legitimate picks (§5.3: no information loss). Symlinks
// that resolve to directories are descendable (broken ones are skipped), the
// same way native pickers treat them. The returned Path is the cleaned
// absolute path; Parent is empty when dir is the filesystem root. Read-only.
func (s *ChatService) BrowseDir(dir string) (*BrowseDirResult, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return nil, fmt.Errorf("empty path")
	}
	if !filepath.IsAbs(dir) {
		return nil, fmt.Errorf("not an absolute path: %s", dir)
	}
	abs := filepath.Clean(dir)
	info, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("not a directory: %s", abs)
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return nil, err
	}
	dirs := make([]BrowseEntry, 0, len(entries))
	for _, e := range entries {
		isDir := e.IsDir()
		if e.Type()&os.ModeSymlink != 0 {
			st, err := os.Stat(filepath.Join(abs, e.Name()))
			if err != nil || !st.IsDir() {
				continue // broken symlink or points at a non-directory
			}
			isDir = true
		}
		if !isDir {
			continue
		}
		dirs = append(dirs, BrowseEntry{Name: e.Name(), Path: filepath.Join(abs, e.Name())})
	}
	sort.Slice(dirs, func(i, j int) bool {
		return strings.ToLower(dirs[i].Name) < strings.ToLower(dirs[j].Name)
	})
	parent := ""
	if up := filepath.Dir(abs); up != abs {
		parent = up
	}
	return &BrowseDirResult{Path: abs, Parent: parent, Dirs: dirs}, nil
}
