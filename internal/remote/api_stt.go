// api_stt.go: the /api/stt endpoint on the embedded remote server (#131).
//
// Remote browser / PWA clients cannot use the webview binding path the
// desktop UI uses; they POST recorded audio here instead. Same auth as the
// rest of the surface (session cookie or Bearer token — never exempted).
//
// Accepted request shapes (pick whichever the client finds convenient):
//   - raw body: any audio/* Content-Type, body = audio bytes
//   - multipart/form-data with a "file" field (browser FormData)
//
// Responses are JSON: {"text": "..."} on 200, {"error": "..."} on failure.
package remote

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/jessonchan/monkey-deck/internal/stt"
)

// maxSTTBody caps the accepted audio payload (mirrors the stt package's own
// decoded-audio cap, with multipart overhead headroom).
const maxSTTBody = 32 << 20

// Transcriber bridges /api/stt to the STT backend. Implemented by
// *stt.Service; kept as an interface so the remote package stays testable
// with a stub (and does not require a live sidecar).
type Transcriber interface {
	Transcribe(ctx context.Context, audio []byte, mime string) (string, error)
}

// handleSTT is the /api/stt mux entry.
func (s *Server) handleSTT(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeSTTError(w, http.StatusMethodNotAllowed, "POST only")
		return
	}
	if s.opts.Transcriber == nil {
		writeSTTError(w, http.StatusServiceUnavailable, "STT not available")
		return
	}

	audio, mime, err := readSTTBody(w, r)
	if err != nil {
		return // readSTTBody already wrote the error response
	}

	text, terr := s.opts.Transcriber.Transcribe(r.Context(), audio, mime)
	if terr != nil {
		switch {
		case errors.Is(terr, stt.ErrServerNotFound), errors.Is(terr, stt.ErrNoModel):
			writeSTTError(w, http.StatusServiceUnavailable, terr.Error())
		default:
			writeSTTError(w, http.StatusInternalServerError, terr.Error())
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"text": text})
}

// readSTTBody extracts (audio, mime) from a raw or multipart request.
func readSTTBody(w http.ResponseWriter, r *http.Request) ([]byte, string, error) {
	ct := r.Header.Get("Content-Type")
	switch {
	case strings.HasPrefix(ct, "multipart/form-data"):
		mr, err := r.MultipartReader()
		if err != nil {
			writeSTTError(w, http.StatusBadRequest, "bad multipart body: "+err.Error())
			return nil, "", err
		}
		for {
			part, perr := mr.NextPart()
			if perr == io.EOF {
				break
			}
			if perr != nil {
				writeSTTError(w, http.StatusBadRequest, "bad multipart body: "+perr.Error())
				return nil, "", perr
			}
			if part.FormName() != "file" {
				_, _ = io.Copy(io.Discard, part) // skip unrelated fields
				continue
			}
			audio, aerr := io.ReadAll(io.LimitReader(part, maxSTTBody+1))
			if aerr != nil {
				writeSTTError(w, http.StatusBadRequest, "read file field: "+aerr.Error())
				return nil, "", aerr
			}
			// Part type wins unless it is missing or the generic
			// application/octet-stream (browsers/clients that did not label
			// the blob) — then fall back to the filename extension.
			mime := part.Header.Get("Content-Type")
			if mime == "" || mime == "application/octet-stream" {
				mime = mimeByFilename(part.FileName())
			}
			if err := checkSTTPayload(w, audio, mime); err != nil {
				return nil, "", err
			}
			return audio, mime, nil
		}
		writeSTTError(w, http.StatusBadRequest, `multipart body has no "file" field`)
		return nil, "", errors.New("no file field")

	case strings.HasPrefix(ct, "audio/"):
		audio, err := io.ReadAll(io.LimitReader(r.Body, maxSTTBody+1))
		if err != nil {
			writeSTTError(w, http.StatusBadRequest, "read body: "+err.Error())
			return nil, "", err
		}
		if cerr := checkSTTPayload(w, audio, ct); cerr != nil {
			return nil, "", cerr
		}
		return audio, ct, nil

	default:
		writeSTTError(w, http.StatusBadRequest, "Content-Type must be audio/* or multipart/form-data")
		return nil, "", errors.New("bad content type")
	}
}

// checkSTTPayload enforces size + non-empty; writes the error response.
func checkSTTPayload(w http.ResponseWriter, audio []byte, mime string) error {
	if len(audio) == 0 {
		writeSTTError(w, http.StatusBadRequest, "empty audio")
		return errors.New("empty audio")
	}
	if len(audio) > maxSTTBody {
		writeSTTError(w, http.StatusRequestEntityTooLarge, "audio too large")
		return errors.New("audio too large")
	}
	if mime == "" {
		writeSTTError(w, http.StatusBadRequest, "audio Content-Type missing")
		return errors.New("missing mime")
	}
	return nil
}

// mimeByFilename is the fallback when a multipart part carries no
// Content-Type: whisper-friendly audio extensions only.
func mimeByFilename(name string) string {
	switch {
	case strings.HasSuffix(name, ".wav"):
		return "audio/wav"
	case strings.HasSuffix(name, ".mp3"):
		return "audio/mpeg"
	case strings.HasSuffix(name, ".flac"):
		return "audio/flac"
	case strings.HasSuffix(name, ".ogg"):
		return "audio/ogg"
	case strings.HasSuffix(name, ".m4a"):
		return "audio/mp4"
	case strings.HasSuffix(name, ".webm"):
		return "audio/webm"
	}
	return ""
}

func writeSTTError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
