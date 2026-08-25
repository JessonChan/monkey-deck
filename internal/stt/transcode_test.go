package stt

// transcode_test.go: container-transcoding behavior against the FAKE ffmpeg
// binary (testdata/fakeffmpeg, compiled on the fly — never the real
// transcoder, §5.1) plus the fake whisper-server from stt_test.go. The fake
// chain encodes everything needed into the transcript: the length of the
// input file production hands to ffmpeg (-i <tmpfile>), the .wav filename,
// and the byte count whisper received.

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// buildFakeFFmpeg compiles testdata/fakeffmpeg into a temp binary.
func buildFakeFFmpeg(t *testing.T) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "fakeffmpeg")
	cmd := exec.Command("go", "build", "-o", out, "./testdata/fakeffmpeg")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fakeffmpeg: %v: %s", err, b)
	}
	return out
}

// fakeWav mirrors testdata/fakeffmpeg's output byte-for-byte: a minimal
// RIFF/WAVE whose data chunk holds n filler bytes.
func fakeWav(n int) []byte {
	wav := make([]byte, 44+n)
	copy(wav[0:4], "RIFF")
	binary.LittleEndian.PutUint32(wav[4:8], uint32(36+n))
	copy(wav[8:12], "WAVE")
	copy(wav[12:16], "fmt ")
	binary.LittleEndian.PutUint32(wav[16:20], 16)
	binary.LittleEndian.PutUint16(wav[20:22], 1)
	binary.LittleEndian.PutUint16(wav[22:24], 1)
	binary.LittleEndian.PutUint32(wav[24:28], 16000)
	binary.LittleEndian.PutUint32(wav[28:32], 32000)
	binary.LittleEndian.PutUint16(wav[32:34], 2)
	binary.LittleEndian.PutUint16(wav[34:36], 16)
	copy(wav[36:40], "data")
	binary.LittleEndian.PutUint32(wav[40:44], uint32(n))
	for i := 44; i < len(wav); i++ {
		wav[i] = 'w'
	}
	return wav
}

// TestTranscribeTranscodesUnsupportedContainers: webm/m4a/ogg inputs go
// through ffmpeg and arrive at whisper as WAV — the transcript must carry
// the ffmpeg output length and the audio.wav filename, not the original
// bytes/container.
func TestTranscribeTranscodesUnsupportedContainers(t *testing.T) {
	for _, mt := range []string{"audio/webm", "audio/m4a", "audio/mp4", "audio/ogg", "audio/opus"} {
		t.Run(mt, func(t *testing.T) {
			t.Setenv("MD_FFMPEG", buildFakeFFmpeg(t))
			svc := newTestService(t, defaultModelID)
			audio := []byte("compressed-container-bytes")

			got, err := svc.Transcribe(context.Background(), audio, mt+";codecs=opus")
			if err != nil {
				t.Fatalf("Transcribe(%s): %v", mt, err)
			}
			want := fmt.Sprintf("fake:%s:%d:audio.wav", modelByID(defaultModelID).File, len(fakeWav(len(audio))))
			if got != want {
				t.Fatalf("transcript = %q, want %q (transcoded WAV path)", got, want)
			}
		})
	}
}

// TestTranscribeNoFFmpegRejectsWebm: without ffmpeg, containers whisper
// cannot decode are refused up front with ErrUnsupportedAudioType (remote
// maps 415) — never passed through to die as an inference 500.
func TestTranscribeNoFFmpegRejectsWebm(t *testing.T) {
	svc := newTestService(t, defaultModelID)
	svc.ffmpegFn = func() string { return "" } // hermetic: ignore any real ffmpeg

	for _, mt := range []string{"audio/webm", "audio/m4a", "audio/aac"} {
		if _, err := svc.Transcribe(context.Background(), []byte("x"), mt); !errors.Is(err, ErrUnsupportedAudioType) {
			t.Fatalf("Transcribe(%s) err = %v, want ErrUnsupportedAudioType", mt, err)
		}
	}
	if st := svc.STTStatus(); st.SidecarRunning {
		t.Fatal("container rejection must not start a sidecar")
	}
}

// TestTranscribeOggNoFFmpegPassthrough: OGG is the lone no-ffmpeg exception
// (native Vorbis decode may still work) — the original bytes reach whisper
// under the .ogg name.
func TestTranscribeOggNoFFmpegPassthrough(t *testing.T) {
	svc := newTestService(t, defaultModelID)
	svc.ffmpegFn = func() string { return "" }

	audio := []byte("OggS-vorbis-bytes")
	got, err := svc.Transcribe(context.Background(), audio, "audio/ogg")
	if err != nil {
		t.Fatalf("Transcribe: %v", err)
	}
	if want := fakeTranscript(defaultModelID, len(audio)); got != want {
		t.Fatalf("transcript = %q, want %q (passthrough %q)", got, want, "audio.ogg")
	}
}

// TestTranscribeFFmpegDecodeFailure: ffmpeg rejecting the bytes (garbage
// labeled as webm) is a client error — ErrUnsupportedAudioType with the
// ffmpeg stderr tail, not a 5xx-shaped generic error.
func TestTranscribeFFmpegDecodeFailure(t *testing.T) {
	t.Setenv("MD_FFMPEG", buildFakeFFmpeg(t))
	t.Setenv("FAKE_WAV_FAIL", "1")
	svc := newTestService(t, defaultModelID)

	_, err := svc.Transcribe(context.Background(), []byte("not-really-webm"), "audio/webm")
	if !errors.Is(err, ErrUnsupportedAudioType) {
		t.Fatalf("err = %v, want ErrUnsupportedAudioType", err)
	}
	if !strings.Contains(err.Error(), "Invalid data") {
		t.Fatalf("err should carry the ffmpeg stderr tail: %v", err)
	}
}

// TestTranscribeDecodedWAVTooLarge: a compressed payload under the input cap
// whose decoded WAV exceeds maxAudioBytes is rejected with
// ErrAudioTooLarge (413), not pushed into the engine.
func TestTranscribeDecodedWAVTooLarge(t *testing.T) {
	t.Setenv("MD_FFMPEG", buildFakeFFmpeg(t))
	t.Setenv("FAKE_WAV_BYTES", fmt.Sprintf("%d", maxAudioBytes+1))
	svc := newTestService(t, defaultModelID)

	_, err := svc.Transcribe(context.Background(), []byte("small-opus-blob"), "audio/webm")
	if !errors.Is(err, ErrAudioTooLarge) {
		t.Fatalf("err = %v, want ErrAudioTooLarge", err)
	}
	if st := svc.STTStatus(); st.SidecarRunning {
		t.Fatal("oversize decode must not start a sidecar")
	}
}

// TestTranscribeFFmpegSilentTruncation: the exit-0 zero-frame WAV form
// (what real ffmpeg produces when a trailing-moov m4a/mp4 hits a
// non-seekable input) must be caught by the product validation instead of
// silently flowing to whisper as an empty transcript source. The error is
// generic (500) — the cause is not attributable to the caller's audio.
// (#24311 P1)
func TestTranscribeFFmpegSilentTruncation(t *testing.T) {
	t.Setenv("MD_FFMPEG", buildFakeFFmpeg(t))
	t.Setenv("FAKE_WAV_EMPTY", "1")
	svc := newTestService(t, defaultModelID)

	_, err := svc.Transcribe(context.Background(), []byte("trailing-moov-m4a-bytes"), "audio/m4a")
	if err == nil {
		t.Fatal("exit-0 zero-frame WAV must be rejected, not passed to whisper")
	}
	if errors.Is(err, ErrUnsupportedAudioType) || errors.Is(err, ErrAudioTooLarge) {
		t.Fatalf("silent truncation is not a client fault: %v", err)
	}
	if !strings.Contains(err.Error(), "no audio frames") {
		t.Fatalf("error should describe the truncation: %v", err)
	}
	if st := svc.STTStatus(); st.SidecarRunning {
		t.Fatal("truncated transcode must not start a sidecar")
	}
}

// TestWavHasAudioFrames: the truncation net — only a RIFF/WAVE whose data
// chunk is non-empty counts as audio-bearing.
func TestWavHasAudioFrames(t *testing.T) {
	if !wavHasAudioFrames(fakeWav(4)) {
		t.Error("valid wav with a 4-byte data chunk: want true")
	}
	// An odd-sized chunk before "data" must not desync the walk (RIFF
	// chunks are word-aligned: one pad byte follows an odd size).
	walk := append(fakeWav(0)[:12], "LIST"...)
	walk = append(walk, 3, 0, 0, 0, 'a', 'b', 'c', 0)
	walk = append(walk, "data"...)
	walk = append(walk, 4, 0, 0, 0, 1, 2, 3, 4)
	if !wavHasAudioFrames(walk) {
		t.Error("data chunk after an odd-sized chunk: want true (word-aligned walk)")
	}
	// WAV with a fmt chunk and a LIST chunk but no data chunk at all.
	noData := append(fakeWav(0)[:36], "LIST"...)
	noData = append(noData, 4, 0, 0, 0, 'a', 'b', 'c', 'd')
	for name, buf := range map[string][]byte{
		"zero data chunk (truncation signature)": fakeWav(0),
		"not a riff container":                   []byte("fakewav:42\n"),
		"too short":                              []byte("RIFF"),
		"no data chunk":                          noData,
	} {
		if wavHasAudioFrames(buf) {
			t.Errorf("%s: want false", name)
		}
	}
}

// TestNeedsTranscode: the container gate — whisper-native types pass, the
// rest route to ffmpeg.
func TestNeedsTranscode(t *testing.T) {
	for _, mt := range []string{"audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/flac", "audio/x-zebra"} {
		if needsTranscode(mt) {
			t.Errorf("needsTranscode(%q) = true, want false (natively decodable)", mt)
		}
	}
	for _, mt := range []string{"audio/webm", "audio/x-webm", "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac", "audio/ogg", "audio/opus"} {
		if !needsTranscode(mt) {
			t.Errorf("needsTranscode(%q) = false, want true", mt)
		}
	}
}

// TestStartupWiresFFmpegFn: ServiceStartup installs the default resolver;
// MD_FFMPEG wins over PATH discovery (mirrors MD_WHISPER_SERVER).
func TestStartupWiresFFmpegFn(t *testing.T) {
	fake := buildFakeFFmpeg(t)
	t.Setenv("MD_FFMPEG", fake)
	svc := newTestService(t)
	svc.mu.Lock()
	got := svc.ffmpegFn()
	svc.mu.Unlock()
	if got != fake {
		t.Fatalf("ffmpegFn() = %q, want env override %q", got, fake)
	}
}
