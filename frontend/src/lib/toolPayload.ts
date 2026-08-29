// toolPayload.ts: turn unknown tool-call payload shapes into human-readable
// text (AGENTS.md §4.4: never show raw JSON / technical formats to the user).
//
// extractToolText (ChatView.tsx) pulls the main text from well-known keys
// (output/content/...). When none match — partial in_progress payloads, harness
// structures we've never seen — the payload used to fall through to
// formatHuman, whose formatInline JSON.stringify'd nested objects: raw JSON on
// screen (#109). summarizeToolPayload closes that gap: it recognises the
// recurring payload shapes and renders each in plain language, and formatInline
// now flattens recursively so no code path can emit JSON.
//
// Category coverage (priority order):
//   ① array (non-path items)            → "共 N 项" + first 3 item previews
//   ② path-led array (paths/grep lines) → the lines as-is, path lines first
//   ③ record with dominant array field  → same as ① (matches/results/files/…)
//   ④ record with path + body strings   → path on the first line, body after
//   ⑤ flat record (scalar values)       → "key: value" lines (formatHuman)
//   ⑥ nested record                     → recursive "key: value" flattening
//                                         (formatInline, never JSON.stringify)

/** Minimal structural type for i18next's t() so this lib stays UI-agnostic. */
export type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

export function isRecord(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }

/** First non-empty string value among candidate keys. */
export function pickStr(raw: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

// Extract a file path from tool rawInput/rawOutput (compatible with the field
// names used across harnesses). Records only: a string payload may be the file
// body itself (read_file rawOutput) — running this on it would mis-match, so
// strings return "" (a missing path badge never breaks diff/content display).
// First non-empty string among the candidates wins.
export function extractFilePath(raw: unknown): string {
  if (!isRecord(raw)) return "";
  return pickStr(raw, ["path", "file", "filepath", "filePath", "fileName", "filename", "dir", "directory", "cwd"]);
}

// Human-readable multi-line rendering. Strings verbatim; records as "key: value"
// lines; arrays item-per-line; nested structures via formatInline (single line).
export function formatHuman(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(formatHuman).filter(Boolean).join("\n");
  if (isRecord(v)) {
    const lines: string[] = [];
    for (const [k, val] of Object.entries(v)) {
      if (val == null || val === "") continue;
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") lines.push(`${k}: ${val}`);
      else lines.push(`${k}: ${formatInline(val)}`);
    }
    return lines.join("\n");
  }
  return String(v);
}

// Single-line rendering for nested values. Recursively flattens objects/arrays
// into "key: value" fragments — never JSON.stringify (#109: nested objects used
// to leak raw JSON here).
export function formatInline(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(formatInline).filter(Boolean).join(", ");
  if (isRecord(v)) {
    return Object.entries(v)
      .filter(([, val]) => val != null && val !== "")
      .map(([k, val]) => `${k}: ${formatInline(val)}`)
      .join(", ");
  }
  return String(v);
}

// How many array items to preview and how wide one preview line may get before
// being clipped (downstream CollapsibleText handles overall length folding).
const PREVIEW_ITEMS = 3;
const PREVIEW_LINE_MAX = 200;

// Record keys whose array value, when present and non-empty, dominates the
// payload (search results / file lists / row sets). First array wins.
const ARRAY_FIELDS = ["matches", "results", "files", "items", "entries", "lines", "rows", "paths", "list", "data", "output"];

// Record keys that may carry the main body text next to a path field.
const BODY_KEYS = ["content", "text", "body", "code", "result", "response", "value", "newText", "fileText", "data"];

// True for lines that start with a filesystem path or a grep-style
// "path:line:content" prefix — output shapes we show verbatim (category ②)
// instead of count+preview, per the #109 spec's "path-led lines first" rule.
function looksLikePathLine(s: string): boolean {
  if (s.length === 0 || s.length > 500 || /\s{2,}/.test(s)) return false;
  return (
    /^\.{0,2}\//.test(s) || // /abs, ./rel, ../rel
    /^~\//.test(s) || // ~/home
    /^[A-Za-z]:[\\/]/.test(s) || // C:\ / C:/
    /^[\w.-]+(?:\/|\\)/.test(s) || // src/foo.go (relative dir prefix)
    /^[\w./\\-]+\.\w{1,8}(:\d+){1,2}:/.test(s) // grep: file.go:12: / file.go:12:3:
  );
}

function summarizeArray(items: unknown[], t: TranslateFn): string {
  // ② All-string arrays that are path/grep lines: show the lines themselves —
  // a count header would only get between the user and the matches.
  if (items.every((x) => typeof x === "string" && looksLikePathLine(x))) {
    return (items as string[]).join("\n");
  }
  // ① Everything else: total count + first 3 previews + "N more" tail.
  const lines = [t("chat.itemsTotal", { count: items.length })];
  for (const item of items.slice(0, PREVIEW_ITEMS)) {
    // Collapse each preview item to one clipped line; full values stay
    // available in the raw payload disclosure rendered next to summaries.
    const s = formatInline(item).replace(/\s+/g, " ").trim();
    lines.push(`- ${s.length > PREVIEW_LINE_MAX ? `${s.slice(0, PREVIEW_LINE_MAX - 1)}…` : s}`);
  }
  const rest = items.length - PREVIEW_ITEMS;
  if (rest > 0) lines.push(t("chat.itemsMore", { count: rest }));
  return lines.join("\n");
}

// Summarize a fallback payload (no known text key matched) in plain language.
// Returns null when there is nothing meaningful to say (primitives / empty
// shapes); the caller keeps its own last-resort formatting for that case.
export function summarizeToolPayload(raw: unknown, t: TranslateFn): string | null {
  if (raw == null || typeof raw !== "object") return null;
  if (Array.isArray(raw)) return raw.length > 0 ? summarizeArray(raw, t) : null;
  if (!isRecord(raw)) return null;
  // ③ Dominant array field (e.g. {matches: [...]}): same treatment as ①.
  for (const k of ARRAY_FIELDS) {
    const v = raw[k];
    if (Array.isArray(v) && v.length > 0) return summarizeArray(v, t);
  }
  // ④ Read/write shape: path first, body after.
  const path = extractFilePath(raw);
  const body = pickStr(raw, BODY_KEYS);
  if (path && body) return `${path}\n${body}`;
  // ⑤⑥ Flat / nested record: "key: value" lines (JSON-free after formatInline).
  return formatHuman(raw) || null;
}
