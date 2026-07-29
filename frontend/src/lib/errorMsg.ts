// Extract a human-readable message from an error thrown by a Wails3 binding.
//
// Wails3 serializes Go errors into objects like {message, cause, kind}.
// When the Go error is a wrapped error (fmt.Errorf), the inner message field
// may itself be a JSON string, so we try to unwrap one level.
//
// Handles: standard Error (e.message), Wails structured error ({message}),
// and the JSON-string-in-message case. Falls back to String(e).
export function extractErrMsg(e: unknown): string {
  if (!e) return "";
  const obj = e as Record<string, unknown>;
  const raw = typeof obj?.message === "string" ? obj.message : String(e);
  // message may be a JSON-serialized Go error — unwrap one level.
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.message === "string") return parsed.message;
  } catch { /* not JSON — use raw as-is */ }
  return raw;
}
