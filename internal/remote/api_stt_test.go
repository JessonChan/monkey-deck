package remote

// api_stt_test.go: /api/stt endpoint behavior against a stub Transcriber —
// auth gating, both request shapes, payload validation, and error mapping.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/stt"
)

// stubTranscriber records the last (audio, mime) and replies per plan.
type stubTranscriber struct {
	mu    chan struct{}
	audio []byte
	mime  string
	calls int
	reply func(audio []byte, mime string) (string, error)
}

func newStubTranscriber(reply func([]byte, string) (string, error)) *stubTranscriber {
	return &stubTranscriber{mu: make(chan struct{}, 1), reply: reply}
}

func (s *stubTranscriber) Transcribe(_ context.Context, audio []byte, mime string) (string, error) {
	s.mu <- struct{}{}
	s.audio, s.mime = audio, mime
	s.calls++
	<-s.mu
	return s.reply(audio, mime)
}

// startSTTServer boots a remote server with the given transcriber.
func startSTTServer(t *testing.T, tr Transcriber) string {
	t.Helper()
	bindingHit := new(bool)
	s := New(Options{
		Transport: stubTransport{hit: bindingHit},
		Assets: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("<html>app</html>"))
		}),
		Token:       func() string { return "secret-token" },
		EventNames:  []string{"chat:event"},
		Transcriber: tr,
	})
	if err := s.Start(0); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(s.Stop)
	return "http://127.0.0.1:" + strings.TrimPrefix(s.Addr(), "0.0.0.0:")
}

func postSTT(t *testing.T, url, contentType string, body io.Reader) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url+"/api/stt", body)
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Authorization", "Bearer secret-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func decodeSTT(t *testing.T, resp *http.Response) map[string]string {
	t.Helper()
	defer resp.Body.Close()
	var m map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return m
}

// TestSTTAuthGated: /api/stt sits behind the standard auth wall.
func TestSTTAuthGated(t *testing.T) {
	base := startSTTServer(t, newStubTranscriber(func(b []byte, _ string) (string, error) { return "hi", nil }))
	resp, err := http.Post(base+"/api/stt", "audio/wav", strings.NewReader("x"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated /api/stt = %d, want 401", resp.StatusCode)
	}
}

// TestSTTRawBody: audio/* body → transcriber sees exact bytes + mime.
func TestSTTRawBody(t *testing.T) {
	tr := newStubTranscriber(func(b []byte, m string) (string, error) {
		return "echo:" + m + ":" + string(b), nil
	})
	base := startSTTServer(t, tr)

	resp := postSTT(t, base, "audio/webm", bytes.NewReader([]byte("WEBMDATA")))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("raw body = %d, want 200", resp.StatusCode)
	}
	m := decodeSTT(t, resp)
	if m["text"] != "echo:audio/webm:WEBMDATA" {
		t.Fatalf("text = %q", m["text"])
	}
	if string(tr.audio) != "WEBMDATA" || tr.mime != "audio/webm" || tr.calls != 1 {
		t.Fatalf("transcriber saw (%q,%q,%d)", tr.mime, tr.audio, tr.calls)
	}
}

// TestSTTMultipart: FormData file field → transcriber sees the part bytes and
// the part's Content-Type.
func TestSTTMultipart(t *testing.T) {
	tr := newStubTranscriber(func(b []byte, m string) (string, error) {
		return fmt.Sprintf("%s:%d", m, len(b)), nil
	})
	base := startSTTServer(t, tr)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "speech.wav")
	_, _ = fw.Write(bytes.Repeat([]byte("a"), 4096))
	_ = mw.Close()

	// CreateFormFile omits a part Content-Type; the endpoint then infers the
	// mime from the filename — this exercises that fallback.
	resp := postSTT(t, base, mw.FormDataContentType(), &buf)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("multipart = %d, want 200", resp.StatusCode)
	}
	m := decodeSTT(t, resp)
	if m["text"] != "audio/wav:4096" {
		t.Fatalf("text = %q, want audio/wav:4096", m["text"])
	}
}

// TestSTTValidation: method, content type, empty body, and transcriber-side
// rejections map to the right statuses.
func TestSTTValidation(t *testing.T) {
	base := startSTTServer(t, newStubTranscriber(func(b []byte, _ string) (string, error) { return "x", nil }))

	// GET → 405 with Allow header.
	req, _ := http.NewRequest(http.MethodGet, base+"/api/stt", nil)
	req.Header.Set("Authorization", "Bearer secret-token")
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode != http.StatusMethodNotAllowed || resp.Header.Get("Allow") != http.MethodPost {
		t.Fatalf("GET = %v/%d (Allow=%q), want 405/POST", err, resp.StatusCode, resp.Header.Get("Allow"))
	}

	// Wrong content type.
	if resp := postSTT(t, base, "text/plain", strings.NewReader("hi")); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("text/plain = %d, want 400", resp.StatusCode)
	}

	// Empty audio body.
	if resp := postSTT(t, base, "audio/wav", strings.NewReader("")); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty body = %d, want 400", resp.StatusCode)
	}
}

// TestSTTErrorMapping: backend sentinels → 503, generic failures → 500, both
// as JSON error envelopes; nil transcriber → 503.
func TestSTTErrorMapping(t *testing.T) {
	base := startSTTServer(t, newStubTranscriber(func(_ []byte, _ string) (string, error) {
		return "", stt.ErrNoModel
	}))
	if resp := postSTT(t, base, "audio/wav", strings.NewReader("x")); resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("ErrNoModel = %d, want 503", resp.StatusCode)
	} else if m := decodeSTT(t, resp); m["error"] == "" {
		t.Fatal("503 must carry a JSON error message")
	}

	base2 := startSTTServer(t, newStubTranscriber(func(_ []byte, _ string) (string, error) {
		return "", errors.New("sidecar exploded")
	}))
	if resp := postSTT(t, base2, "audio/wav", strings.NewReader("x")); resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("generic error = %d, want 500", resp.StatusCode)
	}

	base3 := startSTTServer(t, nil)
	if resp := postSTT(t, base3, "audio/wav", strings.NewReader("x")); resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("nil transcriber = %d, want 503", resp.StatusCode)
	}
}

// TestSTTMimeByFilename: multipart parts without a Content-Type fall back to
// the filename extension.
func TestSTTMimeByFilename(t *testing.T) {
	cases := map[string]string{
		"a.wav": "audio/wav", "a.mp3": "audio/mpeg", "a.flac": "audio/flac",
		"a.ogg": "audio/ogg", "a.m4a": "audio/mp4", "a.webm": "audio/webm",
		"a.txt": "",
	}
	for name, want := range cases {
		if got := mimeByFilename(name); got != want {
			t.Errorf("mimeByFilename(%q) = %q, want %q", name, got, want)
		}
	}
}
