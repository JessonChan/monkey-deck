package remote

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func stubAsset(body, contentType string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", contentType)
		_, _ = io.WriteString(w, body)
	})
}

func doReq(t *testing.T, h http.Handler, path string, acceptGzip bool, extra ...[2]string) *http.Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if acceptGzip {
		req.Header.Set("Accept-Encoding", "gzip")
	}
	for _, kv := range extra {
		req.Header.Set(kv[0], kv[1])
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Result()
}

func TestHashedAssetsGetImmutablePrivate(t *testing.T) {
	h := assetCache{next: stubAsset("js-body", "application/javascript")}
	resp := doReq(t, h, "/assets/index-Ab12Cd34.js", false)
	if cc := resp.Header.Get("Cache-Control"); cc != "private, max-age=31536000, immutable" {
		t.Fatalf("hashed asset Cache-Control = %q", cc)
	}
}

func TestShellDocumentsNeverCachedLong(t *testing.T) {
	for _, p := range []string{"/", "/index.html", "/wails/custom.js"} {
		h := assetCache{next: stubAsset("x", "text/html")}
		if cc := doReq(t, h, p, false).Header.Get("Cache-Control"); cc != "no-cache" {
			t.Fatalf("%s Cache-Control = %q, want no-cache", p, cc)
		}
	}
}

func TestPublicMetadataShortCache(t *testing.T) {
	h := assetCache{next: stubAsset("{}", "application/manifest+json")}
	for _, p := range []string{"/manifest.webmanifest", "/icons/icon-192.png", "/harness-icons/omp.svg"} {
		if cc := doReq(t, h, p, false).Header.Get("Cache-Control"); cc != "private, max-age=86400" {
			t.Fatalf("%s Cache-Control = %q", p, cc)
		}
	}
}

func TestGzipAppliedToTextualTypesOnly(t *testing.T) {
	big := strings.Repeat("a", 4096)
	cases := []struct {
		path     string
		wantGz   bool
		ct       string
	}{
		{"/assets/index-X.js", true, "application/javascript"},
		{"/assets/index-X.css", true, "text/css"},
		{"/assets/Inter-Medium.ttf", true, "font/ttf"},
		{"/assets/logo-X.png", false, "image/png"},
		{"/assets/font-X.woff2", false, "font/woff2"},
	}
	for _, c := range cases {
		h := assetCache{next: stubAsset(big, c.ct)}
		resp := doReq(t, h, c.path, true)
		enc := resp.Header.Get("Content-Encoding")
		if c.wantGz && enc != "gzip" {
			t.Fatalf("%s: Content-Encoding = %q, want gzip", c.path, enc)
		}
		if !c.wantGz && enc == "gzip" {
			t.Fatalf("%s: unexpectedly gzipped", c.path)
		}
		if c.wantGz && resp.Header.Get("Vary") != "Accept-Encoding" {
			t.Fatalf("%s: missing Vary: Accept-Encoding", c.path)
		}
	}
}

func TestSmallBodySkipsGzip(t *testing.T) {
	h := assetCache{next: stubAsset("tiny", "application/javascript")}
	resp := doReq(t, h, "/assets/small-X.js", true)
	if resp.Header.Get("Content-Encoding") == "gzip" {
		t.Fatal("body below minCompressSize must ship identity")
	}
}

func TestNoGzipWithoutAcceptEncoding(t *testing.T) {
	big := strings.Repeat("b", 4096)
	h := assetCache{next: stubAsset(big, "application/javascript")}
	resp := doReq(t, h, "/assets/index-X.js", false)
	if resp.Header.Get("Content-Encoding") == "gzip" {
		t.Fatal("client without Accept-Encoding: gzip got identity body")
	}
}

func TestRangeRequestSkipsGzip(t *testing.T) {
	big := strings.Repeat("c", 4096)
	h := assetCache{next: stubAsset(big, "application/javascript")}
	resp := doReq(t, h, "/assets/video-X.js", true, [2]string{"Range", "bytes=0-99"})
	if resp.Header.Get("Content-Encoding") == "gzip" {
		t.Fatal("Range request must not be gzipped (offsets are byte positions)")
	}
}

func TestNon200PassesThroughBody(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	})
	h := assetCache{next: inner}
	resp := doReq(t, h, "/assets/missing.js", true)
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if resp.Header.Get("Content-Encoding") == "gzip" {
		t.Fatal("error response must not be gzipped")
	}
}

func TestGzipBodyRoundTrips(t *testing.T) {
	big := strings.Repeat("payload-", 512) // 4 KB
	h := assetCache{next: stubAsset(big, "application/javascript")}
	resp := doReq(t, h, "/assets/index-X.js", true)
	gz, err := gzip.NewReader(resp.Body)
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	out, err := io.ReadAll(gz)
	if err != nil {
		t.Fatalf("read gzipped body: %v", err)
	}
	if string(out) != big {
		t.Fatalf("round-trip mismatch: %d bytes", len(out))
	}
}
