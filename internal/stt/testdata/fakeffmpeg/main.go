// fakeffmpeg is a test-only stand-in for ffmpeg used by the internal/stt
// unit tests (fake-binary strategy, AGENTS.md §5.1: never shell out to the
// real transcoder from unit tests — dev machines have one installed and
// tests must stay hermetic).
//
// It mirrors just the surface transcodeToWav relies on:
//
//   - reads the whole stdin payload (the compressed audio)
//   - writes the "decoded WAV" to the last positional argument
//   - FAKE_WAV_BYTES=<n>: emit n filler bytes instead (decoded-size-cap tests)
//   - FAKE_WAV_FAIL=1: exit 1 with a stderr line (decode-failure tests)
//
// The default output "fakewav:<n>\n" encodes the exact stdin length, so the
// transcript chain (fake whisper echoes byte count + filename) proves the
// pipeline transcoded before inference: audio.wav + fakewav length.
package main

import (
	"fmt"
	"io"
	"os"
	"strconv"
)

func main() {
	in, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fakeffmpeg: read stdin:", err)
		os.Exit(1)
	}
	if os.Getenv("FAKE_WAV_FAIL") != "" {
		fmt.Fprintln(os.Stderr, "fakeffmpeg: Invalid data found when processing input")
		os.Exit(1)
	}
	out := os.Args[len(os.Args)-1]
	var payload []byte
	if n, aerr := strconv.Atoi(os.Getenv("FAKE_WAV_BYTES")); aerr == nil && n >= 0 {
		payload = make([]byte, n)
		for i := range payload {
			payload[i] = 'w'
		}
	} else {
		payload = []byte(fmt.Sprintf("fakewav:%d\n", len(in)))
	}
	if werr := os.WriteFile(out, payload, 0o644); werr != nil {
		fmt.Fprintln(os.Stderr, "fakeffmpeg: write output:", werr)
		os.Exit(1)
	}
}
