// sttClient.ts: dictation (voice input) client — #131 stage 2.
//
// Routing (AGENTS.md §1.8 three-face rule): the desktop webview calls the STT
// Wails3 binding directly (base64 audio, the same convention as composer image
// attachments); remote browser / PWA clients cannot use the webview binding
// channel, so they POST the recorded blob to the embedded server's /api/stt
// (same-origin, session-cookie authenticated). One call site (the Composer
// mic button), two transports — picked by isRemoteClient().
//
// Errors are classified into SttErrorKind so the UI can show a localized,
// actionable message (§4.4 human words, not raw protocol strings). The kinds
// line up across both transports: the backend maps them to 503/413/415 on the
// HTTP path and the Go sentinel texts survive verbatim on the binding path.

import { isRemoteClient } from "./remote";
import { extractErrMsg } from "./errorMsg";
import * as SttService from "../../bindings/github.com/jessonchan/monkey-deck/internal/stt/service";

export type SttErrorKind =
  | "micDenied"    // getUserMedia unavailable/rejected (permission or no device)
  | "notReady"     // whisper-server binary or selected model missing (503)
  | "tooLarge"     // audio exceeds the transcription size cap (413)
  | "unsupported"  // undecodable audio type, e.g. no ffmpeg to transcode (415)
  | "noSpeech"     // recording transcribed to empty text
  | "failed";      // anything else (network, sidecar crash, decode bug)

// SttError carries a machine-readable kind (for i18n) + the raw detail (for
// logs). Always thrown by transcribeAudio/startDictation — never a bare Error.
export class SttError extends Error {
  readonly kind: SttErrorKind;
  readonly detail: string;
  constructor(kind: SttErrorKind, detail: string) {
    super(`${kind}: ${detail}`);
    this.name = "SttError";
    this.kind = kind;
    this.detail = detail;
  }
}

// Read a Blob as standard base64 (no data: prefix) — matches
// TranscribeAudio's input convention. Uses arrayBuffer + chunked btoa rather
// than FileReader so it works in every runtime (browsers, webviews, bun).
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000; // String.fromCharCode is variadic — chunk to stay under the arg limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// kindForStatus maps a /api/stt HTTP status onto the error kind (the server
// deliberately mirrors the Go sentinels as 503/413/415, see api_stt.go).
function kindForStatus(status: number): SttErrorKind {
  switch (status) {
    case 503: return "notReady";
    case 413: return "tooLarge";
    case 415: return "unsupported";
    default: return "failed";
  }
}

// kindForBindingError classifies a Wails binding error by its message text
// (Wails serializes Go errors to strings/objects; the sentinel prefixes from
// internal/stt survive verbatim).
function kindForBindingError(msg: string): SttErrorKind {
  if (msg.includes("whisper-server not found") || msg.includes("no STT model downloaded")) return "notReady";
  if (msg.includes("audio too large")) return "tooLarge";
  if (msg.includes("unsupported audio type")) return "unsupported";
  return "failed";
}

// transcribeAudio: audio blob → transcript text. Transport is picked per
// client kind (see file header). Returns the trimmed transcript ("" = the
// engine heard nothing — callers surface that as `noSpeech`).
export async function transcribeAudio(blob: Blob): Promise<string> {
  const mime = blob.type || "audio/webm";
  if (isRemoteClient()) {
    let resp: Response;
    try {
      resp = await fetch("/api/stt", {
        method: "POST",
        headers: { "Content-Type": mime },
        body: blob,
      });
    } catch (e) {
      throw new SttError("failed", extractErrMsg(e) || String(e));
    }
    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try {
        const body = await resp.json() as { error?: string };
        if (body && typeof body.error === "string") detail = body.error;
      } catch { /* non-JSON body — keep the status line */ }
      throw new SttError(kindForStatus(resp.status), detail);
    }
    const data = await resp.json().catch(() => ({ text: "" })) as { text?: string };
    return typeof data.text === "string" ? data.text.trim() : "";
  }
  let text: string;
  try {
    const b64 = await blobToBase64(blob);
    text = await SttService.TranscribeAudio(b64, mime);
  } catch (e) {
    const detail = extractErrMsg(e) || String(e);
    throw new SttError(kindForBindingError(detail), detail);
  }
  return text.trim();
}

// MediaRecorder mime preference. WAV first — whisper.cpp decodes it natively
// (no host ffmpeg needed); everything else falls back to the browser's
// compressed containers, which the backend transcodes via ffmpeg when the
// binary exists (#24311 whitelist inversion: non-native → ffmpeg). undefined
// lets the browser pick its default container.
const RECORDER_MIME_CANDIDATES = [
  "audio/wav;codecs=pcm",
  "audio/wav",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
];

export function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const m of RECORDER_MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch { /* keep probing */ }
  }
  return undefined;
}

// DictationHandle: an in-flight recording session. stop() finalizes and
// resolves the recorded audio; cancel() discards. Both release the mic tracks
// (a leaked track keeps the mic indicator on — unacceptable for a desktop app).
export interface DictationHandle {
  stop(): Promise<Blob>;
  cancel(): void;
}

// startDictation acquires the mic and starts a chunked MediaRecorder.
// Chunked (timeslice 250ms) so a crash mid-recording still leaves the audio
// recorded so far in the buffer. Throws SttError("micDenied") when the mic is
// unavailable or the user denies the permission prompt.
export async function startDictation(): Promise<DictationHandle> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new SttError("micDenied", "getUserMedia unavailable");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    throw new SttError("micDenied", extractErrMsg(e) || String(e));
  }
  const mime = pickRecorderMime();
  let rec: MediaRecorder;
  try {
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    throw new SttError("failed", `MediaRecorder init: ${extractErrMsg(e) || String(e)}`);
  }
  const chunks: Blob[] = [];
  rec.ondataavailable = (ev: BlobEvent) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };
  // Resolve on stop OR fatal error: a fatally-errored MediaRecorder may never
  // dispatch a stop event, and stop() awaiting only onstop would hang forever
  // (phase stuck busy, tracks leaked until unmount — the OS mic indicator
  // stays on). Chunks recorded before the error are still returned below, so
  // the partial audio keeps flowing to transcription.
  const stopped = new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
    rec.onerror = () => resolve();
  });
  const release = () => stream.getTracks().forEach((t) => t.stop());
  try {
    rec.start(250);
  } catch (e) {
    release();
    throw new SttError("failed", `MediaRecorder start: ${extractErrMsg(e) || String(e)}`);
  }
  const outMime = rec.mimeType || mime || "audio/webm";
  return {
    stop: async () => {
      if (rec.state !== "inactive") rec.stop();
      await stopped;
      release();
      return new Blob(chunks, { type: outMime });
    },
    cancel: () => {
      try {
        if (rec.state !== "inactive") rec.stop();
      } catch { /* already inactive */ }
      release();
    },
  };
}
