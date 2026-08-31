package remote

import (
	"bytes"
	"compress/gzip"
	"net/http"
	"strings"
)

// assetCache wraps the shared asset handler for the REMOTE surface only (the
// webview reads the embedded FS through its internal scheme handler and never
// crosses this code — AGENTS.md §3.1 desktop zero-regression). Two jobs:
//
//  1. Immutable caching for content-hashed files. Vite emits
//     `/assets/<name>-<hash>.<ext>`; a fingerprint in the name makes the URL
//     itself the version, so the browser may cache forever ("immutable"). The
//     wails assetserver sets no Cache-Control at all (v3.0.0-alpha2.106,
//     assetserver.go has the header code commented out), which made every PWA
//     cold start re-download the whole shell.
//
//  2. Conditional gzip for textual types. Same reason: the wails handler
//     serves everything uncompressed; the JS entry is ~1.6 MB.
//
// Load-bearing invariants (worklog 2026-08-31):
//   - index.html and /wails/custom.js must NEVER get long-lived caching —
//     caching index.html would freeze clients on an old shell after an update
//     (zombie shell), and custom.js is the WS bootstrap we hot-fix.
//   - manifest + icons are served from / (unhashed public names) — short
//     cache only.
//   - Responses are behind cookie auth (server.go auth middleware); we use
//     `private` so shared caches never store authenticated bytes.

// WithAssetCache wraps the shared asset handler with remote-only caching and
// conditional gzip (see assetCache doc for the invariants).
func WithAssetCache(next http.Handler) http.Handler { return assetCache{next: next} }

type assetCache struct{ next http.Handler }

// compressibleExts: textual types plus UNCOMPRESSED font containers (TTF/OTF
// are bare glyf/loca tables — gzip saves ~40-60%). woff/woff2/png/etc. are
// already compressed and are excluded (CPU for <3%).
var compressibleExts = map[string]bool{
	".js": true, ".mjs": true, ".css": true, ".html": true, ".svg": true,
	".json": true, ".map": true, ".xml": true, ".txt": true,
	".ttf": true, ".otf": true, ".eot": true,
}

// minCompressSize: gzip has ~18 bytes of header overhead; smaller bodies can
// grow. Everything below 1 KB ships as-is.
const minCompressSize = 1024

func extOf(p string) string {
	if i := strings.LastIndex(p, "."); i >= 0 {
		return strings.ToLower(p[i:])
	}
	return ""
}

func (a assetCache) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rw := &peekWriter{ResponseWriter: w}
	a.next.ServeHTTP(rw, r)
	if rw.status != 0 && rw.status != http.StatusOK {
		w.WriteHeader(rw.status) // error/redirect status from the inner handler
		_, _ = w.Write(rw.buf.Bytes())
		return
	}
	path := r.URL.Path
	switch {
	case path == "/" || path == "/index.html" || path == "/wails/custom.js":
		// The shell documents must always revalidate — see invariants above.
		w.Header().Set("Cache-Control", "no-cache")
	case strings.HasPrefix(path, "/assets/"):
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	case path == "/manifest.webmanifest" || strings.HasPrefix(path, "/icons/") ||
		strings.HasPrefix(path, "/harness-icons/"):
		// Public by design (pairing exemption in server.go auth); names are
		// stable, content effectively static — a day is plenty and keeps
		// icon tweaks rolling out.
		w.Header().Set("Cache-Control", "private, max-age=86400")
	default:
		// Fonts (unhashed /Inter-Medium.ttf) and anything else: revalidate.
		w.Header().Set("Cache-Control", "no-cache")
	}
	// Conditional gzip. Range requests must stay identity (offsets are byte
	// positions into the uncompressed body).
	acceptsGzip := strings.Contains(r.Header.Get("Accept-Encoding"), "gzip")
	if !acceptsGzip || rw.buf.Len() < minCompressSize || r.Header.Get("Range") != "" {
		if rw.buf.Len() > 0 {
			_, _ = w.Write(rw.buf.Bytes())
		}
		return
	}
	if !compressibleExts[extOf(path)] {
		_, _ = w.Write(rw.buf.Bytes())
		return
	}
	w.Header().Set("Content-Encoding", "gzip")
	w.Header().Set("Vary", "Accept-Encoding")
	w.Header().Del("Content-Length")
	gz := gzip.NewWriter(w)
	_, _ = gz.Write(rw.buf.Bytes())
	_ = gz.Close()
}

// peekWriter buffers the body (bounded: dist assets are single files, largest
// ~1.7 MB) and records the status so the wrapper can decide after the fact.
type peekWriter struct {
	http.ResponseWriter
	status int
	buf    bytes.Buffer
}

func (p *peekWriter) WriteHeader(code int) { p.status = code }

func (p *peekWriter) Write(b []byte) (int, error) { return p.buf.Write(b) }
