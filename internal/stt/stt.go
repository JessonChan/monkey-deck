// stt.go: the STT service — Wails3-bound surface (TranscribeAudio, model
// management, status) + the core Transcribe pipeline used by both the binding
// and the remote /api/stt bridge.
//
// Persistence (§1.5): selected model + custom server path live in the
// settings KV table via the store package (the SQL single entry point).
// The service opens its own *store.Store on the same SQLite file the chat
// service uses — WAL + busy_timeout serialize the (rare) config writes.

package stt

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/shellenv"
	"github.com/jessonchan/monkey-deck/internal/store"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// EventProgress is emitted during model downloads (ProgressPayload).
const EventProgress = "stt:progress"

// Settings keys (settings KV table).
const (
	settingModel      = "stt.model"
	settingServerPath = "stt.server_path"
)

// Sentinel errors — callers (remote /api/stt) map these to status codes.
var (
	// ErrServerNotFound: no whisper-server binary (install hint in message).
	ErrServerNotFound = errors.New("whisper-server not found (install whisper.cpp, e.g. brew install whisper-cpp, or set the server path in settings)")
	// ErrNoModel: selected model has no local file yet.
	ErrNoModel = errors.New("no STT model downloaded")
	// ErrModelInUse: delete refused because the model is the current selection.
	ErrModelInUse = errors.New("model is selected; switch to another model before deleting")
	// ErrAudioTooLarge: payload (or its decoded WAV) exceeds the size cap
	// → HTTP 413.
	ErrAudioTooLarge = errors.New("audio too large")
	// ErrUnsupportedAudioType: not a decodable audio input (wrong MIME, or a
	// container whisper-server cannot decode and no ffmpeg to transcode)
	// → HTTP 415.
	ErrUnsupportedAudioType = errors.New("unsupported audio type")
)

// Pipeline knobs.
const (
	// maxAudioBytes caps one transcription request (decoded audio).
	maxAudioBytes = 25 << 20
	// transcribeTimeout bounds a single /inference round trip (large models
	// run slower than realtime on laptops).
	transcribeTimeout = 2 * time.Minute
	// defaultHealthWait: model load can take seconds (large models on slow
	// disks); readiness polling budget.
	defaultHealthWait = 30 * time.Second
)

// ProgressPayload is the EventProgress body.
type ProgressPayload struct {
	ModelID  string `json:"modelId"`
	Received int64  `json:"received"`
	Total    int64  `json:"total"` // 0 = unknown (chunked transfer)
	Done     bool   `json:"done"`
	Err      string `json:"err,omitempty"`
}

// STTModel is one catalog entry as seen by the frontend (list + flags).
type STTModel struct {
	ID         string `json:"id"`
	File       string `json:"file"`
	Label      string `json:"label"`
	Lang       string `json:"lang"`
	Quant      string `json:"quant,omitempty"`
	SizeBytes  int64  `json:"sizeBytes"`
	Downloaded bool   `json:"downloaded"`
	Selected   bool   `json:"selected"`
}

// STTStatus is the availability snapshot for the settings UI.
type STTStatus struct {
	ServerFound    bool   `json:"serverFound"`
	ServerPath     string `json:"serverPath"`
	ModelID        string `json:"modelId"`    // effective selection (default applied)
	ModelReady     bool   `json:"modelReady"` // selected model file exists
	SidecarRunning bool   `json:"sidecarRunning"`
	Ready          bool   `json:"ready"` // ServerFound && ModelReady
}

// Service is the STT backend (Wails3 service).
type Service struct {
	cfg *config.Config
	st  *store.Store
	ctx context.Context

	// mu guards sidecar/modelID/serverPath. It is held across (re)starts —
	// concurrent Transcribe callers queue behind the same start and then
	// reuse the live sidecar, which is the behavior we want.
	mu         sync.Mutex
	sidecar    *sidecar
	modelID    string // persisted selection ("" = default)
	serverPath string // effective binary path ("" = not found yet)

	modelsDir  string                      // where ggml files live (CachesDir/stt-models)
	baseURL    string                      // download host (tests point at httptest)
	healthWait time.Duration               // sidecar readiness budget
	downMu     sync.Mutex                  // serializes model downloads
	emitHook   func(name string, data any) // test capture (nil = Wails event)
	// discoverFn resolves the server binary (default = discoverServerLocked);
	// tests inject a stub for deterministic "not found" paths (spawnFn pattern).
	discoverFn func()
	// ffmpegFn resolves the ffmpeg transcoder (default = discoverFFmpegLocked);
	// tests inject a stub for hermetic control (a dev machine's real ffmpeg
	// must not leak into unit tests).
	ffmpegFn   func() string
	ffmpegPath string // cached positive LookPath result

	// pgidFile persists spawned sidecar pgids across runs; the startup sweep
	// kills leftovers from a crashed previous run (§3.2 orphan discipline).
	pgidFile string
	pgidMu   sync.Mutex
}

// NewService constructs the service (inert until ServiceStartup).
func NewService(cfg *config.Config) *Service {
	return &Service{
		cfg:        cfg,
		baseURL:    defaultBaseURL,
		healthWait: defaultHealthWait,
	}
}

// ServiceStartup opens the store, restores persisted settings, discovers the
// whisper-server binary, and sweeps orphaned sidecars left by a previous
// crashed run. The sidecar itself starts lazily on first use.
func (s *Service) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	s.ctx = ctx
	if s.discoverFn == nil {
		s.discoverFn = s.discoverServerLocked
	}
	if s.ffmpegFn == nil {
		s.ffmpegFn = s.discoverFFmpegLocked
	}
	st, err := store.New(s.cfg.DBPath)
	if err != nil {
		return fmt.Errorf("stt: open store: %w", err)
	}
	s.st = st

	if v, err := st.GetSetting(ctx, settingModel); err != nil {
		slog.Warn("stt: read stt.model", "err", err)
	} else if modelByID(v) != nil {
		s.modelID = v // unknown id (catalog changed): fall back to default
	}

	dir := s.cfg.CachesDir
	if dir == "" {
		dir = s.cfg.DataDir
	}
	s.modelsDir = filepath.Join(dir, "stt-models")
	s.pgidFile = filepath.Join(dir, "stt-sidecar-pgids.json")
	killLeftoverSidecars(s.pgidFile) // §3.2: no orphans from a crashed previous run

	s.mu.Lock()
	s.discoverFn()
	serverPath, model := s.serverPath, s.effectiveModelID()
	s.mu.Unlock()
	slog.Info("stt service started", "modelsDir", s.modelsDir, "serverPath", serverPath, "model", model)
	return nil
}

// ServiceShutdown stops the sidecar and closes the store.
func (s *Service) ServiceShutdown() error {
	s.mu.Lock()
	sc := s.sidecar
	s.sidecar = nil
	s.mu.Unlock()
	if sc != nil {
		sc.stop()
	}
	if s.st != nil {
		return s.st.Close()
	}
	return nil
}

// effectiveModelID applies the default selection when nothing is persisted.
func (s *Service) effectiveModelID() string {
	if s.modelID != "" {
		return s.modelID
	}
	return defaultModelID
}

// discoverServerLocked resolves the whisper-server binary: env override
// (MD_WHISPER_SERVER) > persisted custom path > PATH lookup (after merging
// the user's login-shell PATH — Finder launches start with a minimal PATH,
// same known issue as harness discovery, §5.4 #8). Caller holds s.mu.
func (s *Service) discoverServerLocked() {
	if p := strings.TrimSpace(os.Getenv("MD_WHISPER_SERVER")); p != "" {
		s.serverPath = p
		return
	}
	if v, err := s.st.GetSetting(s.ctx, settingServerPath); err != nil {
		slog.Warn("stt: read stt.server_path", "err", err)
	} else if v != "" {
		s.serverPath = v
		return
	}
	// Not cached anywhere yet: enrich PATH like harness spawn does, then probe.
	_ = shellenv.Resolve(context.Background())
	for _, name := range serverCandidates {
		if p, err := exec.LookPath(name); err == nil {
			s.serverPath = p
			return
		}
	}
	s.serverPath = ""
}

// STTStatus returns the availability snapshot.
func (s *Service) STTStatus() STTStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	status := STTStatus{
		ServerPath:  s.serverPath,
		ServerFound: s.serverPath != "",
		ModelID:     s.effectiveModelID(),
	}
	if m := modelByID(status.ModelID); m != nil {
		if _, err := os.Stat(filepath.Join(s.modelsDir, m.File)); err == nil {
			status.ModelReady = true
		}
	}
	status.SidecarRunning = s.sidecar != nil && s.sidecar.isAlive()
	status.Ready = status.ServerFound && status.ModelReady
	return status
}

// ListSTTModels returns the catalog with downloaded/selected flags.
func (s *Service) ListSTTModels() []STTModel {
	s.mu.Lock()
	selected := s.effectiveModelID()
	s.mu.Unlock()
	out := make([]STTModel, 0, len(catalog))
	for _, m := range catalog {
		downloaded := false
		if _, err := os.Stat(filepath.Join(s.modelsDir, m.File)); err == nil {
			downloaded = true
		}
		out = append(out, STTModel{
			ID: m.ID, File: m.File, Label: m.Label, Lang: m.Lang, Quant: m.Quant,
			SizeBytes: m.SizeBytes, Downloaded: downloaded, Selected: m.ID == selected,
		})
	}
	return out
}

// SetSTTModel persists the selection and stops a running sidecar bound to a
// different model — the next Transcribe lazily restarts with the new model.
func (s *Service) SetSTTModel(id string) error {
	if modelByID(id) == nil {
		return fmt.Errorf("stt: unknown model %q", id)
	}
	if err := s.st.SetSetting(s.ctx, settingModel, id); err != nil {
		return fmt.Errorf("stt: persist stt.model: %w", err)
	}
	s.mu.Lock()
	s.modelID = id
	sc := s.sidecar
	s.sidecar = nil
	s.mu.Unlock()
	if sc != nil {
		sc.stop()
	}
	return nil
}

// DownloadSTTModel downloads a catalog model (idempotent, progress events).
func (s *Service) DownloadSTTModel(id string) error {
	ctx := s.opCtx()
	return s.downloadModel(ctx, id)
}

// DeleteSTTModel removes a downloaded model file. The currently selected
// model must be switched away first (a running sidecar may hold its file).
func (s *Service) DeleteSTTModel(id string) error {
	s.mu.Lock()
	selected := s.effectiveModelID()
	s.mu.Unlock()
	if id == selected {
		return ErrModelInUse
	}
	return s.deleteModel(id)
}

// SetSTTServerPath persists a custom whisper-server binary (empty = clear,
// fall back to discovery). Stops a running sidecar; the next Transcribe uses
// the new binary.
func (s *Service) SetSTTServerPath(path string) error {
	path = strings.TrimSpace(path)
	if path != "" {
		abs, err := filepath.Abs(path)
		if err != nil {
			return fmt.Errorf("stt: server path: %w", err)
		}
		info, err := os.Stat(abs)
		if err != nil {
			return fmt.Errorf("stt: server path: %w", err)
		}
		if info.IsDir() || info.Mode()&0o111 == 0 {
			return fmt.Errorf("stt: server path %s is not an executable file", abs)
		}
		path = abs
	}
	if err := s.st.SetSetting(s.ctx, settingServerPath, path); err != nil {
		return fmt.Errorf("stt: persist stt.server_path: %w", err)
	}
	s.mu.Lock()
	s.serverPath = path
	sc := s.sidecar
	s.sidecar = nil
	if path == "" {
		s.discoverFn() // repopulate from env/PATH immediately
	}
	s.mu.Unlock()
	if sc != nil {
		sc.stop()
	}
	return nil
}

// StopSTTSidecar stops the sidecar (settings/debug entry point). Idempotent.
func (s *Service) StopSTTSidecar() error {
	s.mu.Lock()
	sc := s.sidecar
	s.sidecar = nil
	s.mu.Unlock()
	if sc != nil {
		sc.stop()
	}
	return nil
}

// TranscribeAudio is the frontend binding entry: base64 audio → transcript.
// Mirrors the existing attachment convention (Composer sends images as base64
// strings too).
func (s *Service) TranscribeAudio(audioB64, mimeType string) (string, error) {
	audio, err := base64.StdEncoding.DecodeString(strings.TrimSpace(audioB64))
	if err != nil {
		return "", fmt.Errorf("stt: decode audio: %w", err)
	}
	return s.Transcribe(s.opCtx(), audio, mimeType)
}

// Transcribe is the core pipeline (also the remote /api/stt bridge target):
// validate → transcode containers whisper-server cannot decode (ffmpeg) →
// ensure a healthy sidecar on the selected model → POST the audio to
// whisper-server /inference → return the transcript text.
//
// Client-fault rejections carry ErrAudioTooLarge / ErrUnsupportedAudioType
// so the remote bridge maps them to 413/415 instead of 500.
func (s *Service) Transcribe(ctx context.Context, audio []byte, mimeType string) (string, error) {
	if len(audio) == 0 {
		return "", errors.New("stt: empty audio")
	}
	if len(audio) > maxAudioBytes {
		return "", fmt.Errorf("%w: %d bytes exceeds the %d-byte limit",
			ErrAudioTooLarge, len(audio), maxAudioBytes)
	}
	mimeType = strings.TrimSpace(strings.ToLower(mimeType))
	if mt, _, err := mime.ParseMediaType(mimeType); err == nil {
		mimeType = mt // drop parameters ("audio/webm;codecs=opus" → "audio/webm")
	}
	if mimeType == "" {
		mimeType = "audio/wav"
	}
	if !strings.HasPrefix(mimeType, "audio/") {
		return "", fmt.Errorf("%w %q", ErrUnsupportedAudioType, mimeType)
	}
	if needsTranscode(mimeType) {
		wav, err := s.ensureWav(ctx, mimeType, audio)
		if err != nil {
			return "", err
		}
		audio, mimeType = wav, "audio/wav"
	}

	sc, err := s.ensureSidecar(ctx)
	if err != nil {
		return "", err
	}

	// whisper-server sniffs the container from the multipart part's filename
	// extension, so map the MIME type onto one.
	name := "audio" + extForMIME(mimeType)

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	hdr := textproto.MIMEHeader{}
	hdr.Set("Content-Disposition", formFileDisposition("file", name))
	hdr.Set("Content-Type", mimeType)
	fw, err := mw.CreatePart(hdr)
	if err != nil {
		return "", fmt.Errorf("stt: build request: %w", err)
	}
	if _, err := fw.Write(audio); err != nil {
		return "", fmt.Errorf("stt: build request: %w", err)
	}
	if err := mw.WriteField("response_format", "json"); err != nil {
		return "", fmt.Errorf("stt: build request: %w", err)
	}
	if err := mw.Close(); err != nil {
		return "", fmt.Errorf("stt: build request: %w", err)
	}

	tctx, cancel := context.WithTimeout(ctx, transcribeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(tctx, http.MethodPost, sc.baseURL()+"/inference", &body)
	if err != nil {
		return "", fmt.Errorf("stt: build request: %w", err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("stt: inference: %w", err)
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("stt: inference: status %d: %s", resp.StatusCode, strings.TrimSpace(string(rb)))
	}
	var out struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(rb, &out); err != nil {
		return "", fmt.Errorf("stt: decode response: %w", err)
	}
	return strings.TrimSpace(out.Text), nil
}

// ensureSidecar returns a healthy sidecar bound to the effective model,
// starting or restarting as needed. All callers serialize on s.mu, so there
// is exactly one spawn decision at a time.
func (s *Service) ensureSidecar(ctx context.Context) (*sidecar, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	modelID := s.effectiveModelID()
	m := modelByID(modelID)
	if m == nil {
		return nil, fmt.Errorf("stt: unknown model %q", modelID)
	}
	modelPath := filepath.Join(s.modelsDir, m.File)
	if _, err := os.Stat(modelPath); err != nil {
		return nil, fmt.Errorf("%w (model %q)", ErrNoModel, modelID)
	}

	// Reuse the live sidecar when it matches the selection.
	if s.sidecar != nil {
		if s.sidecar.isAlive() && s.sidecar.modelID == modelID {
			return s.sidecar, nil
		}
		s.sidecar.stop() // dead or stale model: reap before respawning
		s.sidecar = nil
	}

	if s.serverPath == "" {
		s.discoverFn() // cheap after first resolve (shellenv caches)
	}
	if s.serverPath == "" {
		return nil, ErrServerNotFound
	}

	sc, err := startSidecar(ctx, s.serverPath, modelPath, modelID, s.healthWait,
		func(pgid int) { s.registerSidecar(pgid, s.serverPath) },
		s.unregisterSidecar,
	)
	if err != nil {
		return nil, err
	}
	s.sidecar = sc
	return sc, nil
}

// opCtx returns the app-lifetime context (fallback: background).
func (s *Service) opCtx() context.Context {
	if s.ctx != nil {
		return s.ctx
	}
	return context.Background()
}

// emitProgress pushes a download progress event to the frontend (§4.3).
func (s *Service) emitProgress(p ProgressPayload) {
	if s.emitHook != nil {
		s.emitHook(EventProgress, p)
		return
	}
	if app := application.Get(); app != nil {
		app.Event.Emit(EventProgress, p)
	}
}

// formFileDisposition builds a Content-Disposition for a file part (same
// escaping discipline as mime/multipart.Writer.CreateFormFile, which does not
// let us set the part's Content-Type).
func formFileDisposition(field, filename string) string {
	esc := strings.NewReplacer("\\", `\\`, `"`, `\"`)
	return fmt.Sprintf(`form-data; name="%s"; filename="%s"`, esc.Replace(field), esc.Replace(filename))
}

// extForMIME maps an audio MIME type to a file extension for the multipart
// filename (whisper-server uses it to pick the demuxer). Container types the
// engine cannot decode (webm/m4a/aac/ogg-opus) never get here — Transcribe
// transcodes them to WAV first (or rejects them when ffmpeg is missing, with
// OGG the lone pass-through exception: native Vorbis decode). Unknown audio
// types fall back to .wav — the least surprising default for whisper inputs.
func extForMIME(mt string) string {
	switch mt {
	case "audio/wav", "audio/x-wav", "audio/wave":
		return ".wav"
	case "audio/mpeg", "audio/mp3":
		return ".mp3"
	case "audio/flac", "audio/x-flac":
		return ".flac"
	case "audio/ogg":
		return ".ogg"
	}
	if exts, _ := mime.ExtensionsByType(mt); len(exts) > 0 {
		return exts[0]
	}
	return ".wav"
}
