package stt

// transcode_integration_test.go: real-ffmpeg acceptance matrix (#24311).
//
// The hermetic tests (transcode_test.go) prove the wiring against a fake;
// this file proves the production transcode path against the REAL
// transcoder, using the input-form matrix the #24310 review used to expose
// the P1: pipe input silently truncates trailing-moov m4a while webm and
// faststart containers happen to work — sampling only the two ends (happy
// path + garbage) misses the middle (§5.3). Build tag per §5.1: the
// default suite and CI skip it; run locally with:
//
//	go test -tags integration -run TestTranscodeRealFFmpeg -v ./internal/stt/

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// genAudio synthesizes a 60s sine test input with the real ffmpeg (lavfi).
// Encoder unavailability skips — this matrix is about demuxer shapes, not
// codec coverage.
func genAudio(t *testing.T, ffmpeg, out string, args ...string) []byte {
	t.Helper()
	cmd := exec.Command(ffmpeg, append([]string{
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=60",
	}, append(append([]string{}, args...), out)...)...)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("generate %s: %v: %s (encoder unavailable?)", filepath.Base(out), err, b)
	}
	audio, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("read generated %s: %v", out, err)
	}
	return audio
}

// wavDataLen extracts the data chunk byte count from a RIFF/WAVE (kept
// independent from wavHasAudioFrames on purpose: the matrix must not
// validate production with production's own walker).
func wavDataLen(t *testing.T, wav []byte) int {
	t.Helper()
	if len(wav) < 12 || string(wav[:4]) != "RIFF" || string(wav[8:12]) != "WAVE" {
		t.Fatalf("not a RIFF/WAVE container: %d bytes, head %q", len(wav), wav[:min(12, len(wav))])
	}
	off := 12
	for off+8 <= len(wav) {
		id := string(wav[off : off+4])
		size := int(binary.LittleEndian.Uint32(wav[off+4 : off+8]))
		if id == "data" {
			return size
		}
		off += 8 + size
		if size%2 == 1 {
			off++
		}
	}
	t.Fatal("no data chunk in wav")
	return 0
}

// TestTranscodeRealFFmpegInputMatrix: every legal-but-unfavorable input
// form must decode to a full-length WAV — 16 kHz mono pcm_s16le means
// 32000 data bytes per second of source audio (±10% codec priming).
// The P1 shape (trailing-moov m4a, well past ffmpeg's ~128KB pipe buffer)
// is the headline case; garbage must fail as ErrUnsupportedAudioType.
func TestTranscodeRealFFmpegInputMatrix(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("real ffmpeg not found on PATH")
	}
	dir := t.TempDir()

	trailing := genAudio(t, ffmpeg, filepath.Join(dir, "trailing.m4a"),
		"-ac", "1", "-c:a", "aac", "-b:a", "64k")
	// Fixture guard: prove the file really carries moov-at-end (the P1
	// shape) — a faststart remux would silently invalidate the headline case.
	moovAt := bytes.LastIndex(trailing, []byte("moov"))
	mdatAt := bytes.LastIndex(trailing, []byte("mdat"))
	if moovAt < 0 || mdatAt < 0 || moovAt < mdatAt {
		t.Fatalf("fixture is not trailing-moov (moov@%d, mdat@%d, %d bytes)", moovAt, mdatAt, len(trailing))
	}

	fast := genAudio(t, ffmpeg, filepath.Join(dir, "fast.m4a"),
		"-ac", "1", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart")
	webm := genAudio(t, ffmpeg, filepath.Join(dir, "sine.webm"),
		"-ac", "1", "-c:a", "libopus", "-b:a", "32k")

	cases := []struct {
		name    string
		audio   []byte
		wantErr error
	}{
		{name: "trailing-moov m4a (P1 shape, >128KB)", audio: trailing},
		{name: "faststart m4a", audio: fast},
		{name: "webm/opus", audio: webm},
		{name: "garbage", audio: bytes.Repeat([]byte("not a media container at all, really. "), 64),
			wantErr: ErrUnsupportedAudioType},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wav, err := transcodeToWav(context.Background(), ffmpeg, tc.audio)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("err = %v, want %v", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("transcodeToWav: %v", err)
			}
			if !wavHasAudioFrames(wav) {
				t.Fatalf("product validation rejected a real decode: %d bytes", len(wav))
			}
			if got := float64(wavDataLen(t, wav)) / 32000.0; got < 54 || got > 66 {
				t.Fatalf("decoded duration = %.1fs, want 60s ±10%% (silent truncation?)", got)
			}
		})
	}
}
