// transcode.go: ffmpeg-based container transcoding for /api/stt inputs.
//
// Why (#24308 review P2): whisper-server's in-memory decoder is miniaudio +
// stb_vorbis (WAV/MP3/FLAC/Vorbis only — no ffmpeg fallback on the in-memory
// path unless built with WHISPER_COMMON_FFMPEG, which brew builds do not
// enable). MediaRecorder's default output (audio/webm;codecs=opus) and m4a
// uploads therefore reach /inference and die as an opaque 500. Here those
// containers are transcoded to 16 kHz mono PCM WAV — the one input shape the
// engine always accepts — before the multipart POST is built.
//
// Without ffmpeg: OGG is passed through (native Vorbis decode may still
// work); webm/m4a/aac are rejected with ErrUnsupportedAudioType (remote
// maps it to 415) carrying an install hint instead of a downstream 500.

package stt

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/jessonchan/monkey-deck/internal/shellenv"
)

// ffmpegCandidates are the transcoder binary names probed on PATH.
var ffmpegCandidates = []string{"ffmpeg"}

// transcodeTimeout bounds one ffmpeg run (generous for large payloads).
const transcodeTimeout = 2 * time.Minute

// maxTranscodeStderr caps captured ffmpeg stderr for error messages.
const maxTranscodeStderr = 2 * 1024

// needsTranscode reports whether whisper-server cannot decode the container
// natively: webm (opus), ISO-BMFF audio (m4a/AAC), raw AAC, and the OGG
// family (OGG-Opus fails natively; OGG-Vorbis would work, but the codec is
// not distinguishable without sniffing, so both take the ffmpeg path).
func needsTranscode(mt string) bool {
	switch mt {
	case "audio/webm", "audio/x-webm",
		"audio/mp4", "audio/m4a", "audio/x-m4a",
		"audio/aac", "audio/aacp",
		"audio/ogg", "audio/opus":
		return true
	}
	return false
}

// discoverFFmpegLocked resolves the ffmpeg binary: env override (MD_FFMPEG,
// mirrors MD_WHISPER_SERVER) > PATH lookup after merging the user's
// login-shell PATH (Finder launches, §5.4 #8). Only positive results are
// cached — a missing ffmpeg is re-probed so installing it needs no restart.
// Caller holds s.mu.
func (s *Service) discoverFFmpegLocked() string {
	if p := strings.TrimSpace(os.Getenv("MD_FFMPEG")); p != "" {
		return p
	}
	if s.ffmpegPath != "" {
		return s.ffmpegPath
	}
	_ = shellenv.Resolve(context.Background())
	for _, name := range ffmpegCandidates {
		if p, err := exec.LookPath(name); err == nil {
			s.ffmpegPath = p
			return p
		}
	}
	return ""
}

// ensureWav returns the audio as a whisper-native WAV, transcoding via
// ffmpeg when the container needs it. On success the caller rewrites the
// request MIME to audio/wav.
func (s *Service) ensureWav(ctx context.Context, mimeType string, audio []byte) ([]byte, error) {
	s.mu.Lock()
	ffmpeg := s.ffmpegFn()
	s.mu.Unlock()
	if ffmpeg == "" {
		if mimeType == "audio/ogg" {
			return audio, nil // native Vorbis decode may still work
		}
		return nil, fmt.Errorf(
			"%w %q: whisper-server cannot decode this container and no ffmpeg was found (install ffmpeg to enable webm/m4a/ogg)",
			ErrUnsupportedAudioType, mimeType)
	}
	wav, err := transcodeToWav(ctx, ffmpeg, audio)
	if err != nil {
		return nil, fmt.Errorf("transcode %q: %w", mimeType, err)
	}
	return wav, nil
}

// transcodeToWav runs ffmpeg: temp-file audio in → 16 kHz mono pcm_s16le
// WAV in a temp file. BOTH sides go through real files:
//
//   - Input (#24311 P1): pipe:0 is not seekable, and the MP4-family
//     demuxer must seek to the moov atom — which sits at the END of
//     conventionally muxed m4a/mp4 (default muxing, not faststart). On a
//     pipe, ffmpeg silently emits a zero-frame WAV and exits 0, bypassing
//     every error sentinel (webm/fMP4 are streaming containers and happen
//     to work, which is why the bug survived the first verification round).
//   - Output: a real file (not pipe:1) lets ffmpeg write correct RIFF
//     sizes.
//
// The product is validated, not trusted: exit 0 with a zero-frame WAV is
// the silent-truncation signature, caught here as the last line of defense
// (a generic error → 500, not a client 4xx — the cause is not attributable
// to the caller). The decoded size is checked via stat BEFORE reading, so
// an oversized decode cannot balloon host memory. A decode failure is
// returned as ErrUnsupportedAudioType so callers map it to 415 (bad
// input), while infrastructure failures stay generic errors.
func transcodeToWav(ctx context.Context, ffmpeg string, audio []byte) ([]byte, error) {
	in, err := os.CreateTemp("", "monkey-deck-stt-in-*.bin")
	if err != nil {
		return nil, fmt.Errorf("stt: create temp input: %w", err)
	}
	defer os.Remove(in.Name())
	if _, err := in.Write(audio); err != nil {
		in.Close()
		return nil, fmt.Errorf("stt: write temp input: %w", err)
	}
	if err := in.Close(); err != nil {
		return nil, fmt.Errorf("stt: close temp input: %w", err)
	}

	tmp, err := os.CreateTemp("", "monkey-deck-stt-*.wav")
	if err != nil {
		return nil, fmt.Errorf("stt: create temp wav: %w", err)
	}
	defer os.Remove(tmp.Name())
	tmp.Close()

	tctx, cancel := context.WithTimeout(ctx, transcodeTimeout)
	defer cancel()

	var stderr limitedBuffer
	cmd := exec.CommandContext(tctx, ffmpeg,
		"-hide_banner", "-loglevel", "error",
		"-i", in.Name(),
		"-vn", "-map", "0:a:0",
		"-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
		"-f", "wav", "-y", tmp.Name(),
	)
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if tctx.Err() != nil {
			return nil, fmt.Errorf("stt: ffmpeg transcode timed out after %s", transcodeTimeout)
		}
		// Spawn-side infrastructure failures (a broken MD_FFMPEG override,
		// missing binary, no execute permission) are server faults, not bad
		// audio: keep them generic (500) instead of a misleading 415
		// "could not decode" (#24311 P3-a). ENOENT covers path-style
		// overrides; exec.ErrNotFound covers bare names missing from PATH.
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrPermission) || errors.Is(err, exec.ErrNotFound) {
			return nil, fmt.Errorf("stt: run ffmpeg %q: %w", ffmpeg, err)
		}
		return nil, fmt.Errorf("%w: ffmpeg could not decode the audio (%v): %s",
			ErrUnsupportedAudioType, err, stderr.String())
	}
	info, err := os.Stat(tmp.Name())
	if err != nil {
		return nil, fmt.Errorf("stt: stat transcoded wav: %w", err)
	}
	if info.Size() > maxAudioBytes {
		return nil, fmt.Errorf(
			"%w: decoded WAV is %d bytes (limit %d) — trim the recording",
			ErrAudioTooLarge, info.Size(), maxAudioBytes)
	}
	wav, err := os.ReadFile(tmp.Name())
	if err != nil {
		return nil, fmt.Errorf("stt: read transcoded wav: %w", err)
	}
	if !wavHasAudioFrames(wav) {
		return nil, fmt.Errorf(
			"stt: ffmpeg exited successfully but the WAV has no audio frames (%d bytes) — possible silent truncation",
			len(wav))
	}
	return wav, nil
}

// wavHasAudioFrames reports whether buf is a RIFF/WAVE file whose data
// chunk carries at least one audio frame. ffmpeg can exit 0 while writing
// a structurally valid but zero-frame WAV (the silent-truncation signature
// behind #24311 P1), so the product is checked, not trusted.
func wavHasAudioFrames(buf []byte) bool {
	if len(buf) < 12 || string(buf[0:4]) != "RIFF" || string(buf[8:12]) != "WAVE" {
		return false
	}
	off := 12
	for off+8 <= len(buf) {
		id := string(buf[off : off+4])
		size := int(binary.LittleEndian.Uint32(buf[off+4 : off+8]))
		if id == "data" {
			return size > 0
		}
		off += 8 + size
		if size%2 == 1 {
			off++ // chunks are word-aligned
		}
	}
	return false
}

// limitedBuffer caps captured stderr so a pathological ffmpeg cannot balloon
// host memory; once full it keeps accepting writes but stores no more.
type limitedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.buf.Len() < maxTranscodeStderr {
		room := maxTranscodeStderr - b.buf.Len()
		b.buf.Write(p[:min(room, len(p))])
	}
	return len(p), nil
}

func (b *limitedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return strings.TrimSpace(b.buf.String())
}
