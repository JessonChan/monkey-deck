// fakeffmpeg is a test-only stand-in for ffmpeg used by the internal/stt
// unit tests (fake-binary strategy, AGENTS.md §5.1: never shell out to the
// real transcoder from unit tests — dev machines have one installed and
// tests must stay hermetic).
//
// It mirrors just the surface transcodeToWav relies on:
//
//   - reads the input file that follows -i (production passes a temp file;
//     if production ever regresses to pipe:0, the read fails and every
//     happy-path test fails loudly)
//   - writes a minimal RIFF/WAVE whose data chunk holds n filler bytes to
//     the last positional argument
//   - FAKE_WAV_BYTES=<n>: data chunk carries n filler bytes (decoded-size-cap tests)
//   - FAKE_WAV_EMPTY=1: data chunk size 0 with exit 0 (the silent-truncation
//     form real ffmpeg produces on non-seekable trailing-moov input, #24311 P1)
//   - FAKE_WAV_FAIL=1: exit 1 with a stderr line (decode-failure tests)
//
// The default data chunk length equals the input file length, so the
// transcript chain (fake whisper echoes byte count + filename) proves the
// pipeline transcoded before inference: audio.wav + wav length.
package main

import (
	"encoding/binary"
	"fmt"
	"os"
	"strconv"
)

func main() {
	if os.Getenv("FAKE_WAV_FAIL") != "" {
		fmt.Fprintln(os.Stderr, "fakeffmpeg: Invalid data found when processing input")
		os.Exit(1)
	}
	inPath := ""
	for i, a := range os.Args {
		if a == "-i" && i+1 < len(os.Args) {
			inPath = os.Args[i+1]
		}
	}
	in, err := os.ReadFile(inPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fakeffmpeg: read input:", err)
		os.Exit(1)
	}
	dataLen := len(in)
	if n, aerr := strconv.Atoi(os.Getenv("FAKE_WAV_BYTES")); aerr == nil && n >= 0 {
		dataLen = n
	}
	if os.Getenv("FAKE_WAV_EMPTY") != "" {
		dataLen = 0
	}
	out := os.Args[len(os.Args)-1]
	if werr := os.WriteFile(out, fakeWavBytes(dataLen), 0o644); werr != nil {
		fmt.Fprintln(os.Stderr, "fakeffmpeg: write output:", werr)
		os.Exit(1)
	}
}

// fakeWavBytes builds a minimal 16 kHz mono pcm_s16le RIFF/WAVE whose data
// chunk holds n filler bytes. Must stay in sync with fakeWav in
// transcode_test.go (byte-identical output).
func fakeWavBytes(n int) []byte {
	wav := make([]byte, 44+n)
	copy(wav[0:4], "RIFF")
	binary.LittleEndian.PutUint32(wav[4:8], uint32(36+n))
	copy(wav[8:12], "WAVE")
	copy(wav[12:16], "fmt ")
	binary.LittleEndian.PutUint32(wav[16:20], 16)  // fmt chunk size
	binary.LittleEndian.PutUint16(wav[20:22], 1)   // PCM
	binary.LittleEndian.PutUint16(wav[22:24], 1)   // mono
	binary.LittleEndian.PutUint32(wav[24:28], 16000)
	binary.LittleEndian.PutUint32(wav[28:32], 32000) // byte rate
	binary.LittleEndian.PutUint16(wav[32:34], 2)     // block align
	binary.LittleEndian.PutUint16(wav[34:36], 16)    // bits per sample
	copy(wav[36:40], "data")
	binary.LittleEndian.PutUint32(wav[40:44], uint32(n))
	for i := 44; i < len(wav); i++ {
		wav[i] = 'w'
	}
	return wav
}
