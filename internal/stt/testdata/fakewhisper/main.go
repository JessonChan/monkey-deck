// fakewhisper is a test-only stand-in for whisper.cpp's whisper-server used
// by the internal/stt unit tests ("fake binary" strategy, AGENTS.md §5.1:
// never launch the real engine from unit tests).
//
// It implements just the surface the sidecar pipeline talks to:
//
//	GET  /health    → 200 {"status":"success"}
//	POST /inference → 200 {"text":"fake:<model-base>:<n-bytes>:<filename>"}
//
// The transcript encodes the model file the server was started with, the
// uploaded audio length, and the uploaded filename, so tests can assert the
// whole pipeline (model selection, byte pass-through, MIME→extension mapping)
// from the returned text alone.
package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"path/filepath"
)

func main() {
	model := flag.String("m", "", "model path (recorded into transcripts)")
	flag.String("model", "", "model path alias (unused, accepted for CLI compat)")
	host := flag.String("host", "127.0.0.1", "listen host")
	port := flag.Int("port", 8178, "listen port")
	flag.Parse()

	modelBase := filepath.Base(*model)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"success"}`)
	})
	mux.HandleFunc("/inference", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		if err := r.ParseMultipartForm(64 << 20); err != nil {
			http.Error(w, "bad multipart: "+err.Error(), http.StatusBadRequest)
			return
		}
		file, hdr, err := r.FormFile("file")
		if err != nil {
			http.Error(w, "missing file field: "+err.Error(), http.StatusBadRequest)
			return
		}
		n, readErr := countBytes(file)
		name := "audio.wav"
		if hdr != nil {
			name = hdr.Filename
		}
		if readErr != nil {
			http.Error(w, "read file: "+readErr.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"text":%q}`, fmt.Sprintf("fake:%s:%d:%s", modelBase, n, name))
	})

	addr := fmt.Sprintf("%s:%d", *host, *port)
	log.Printf("fakewhisper listening on %s (model=%s)", addr, modelBase)
	log.Fatal(http.ListenAndServe(addr, mux))
}

// countBytes drains the part and returns its length.
func countBytes(r io.Reader) (int64, error) {
	return io.Copy(io.Discard, r)
}
