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
// Category coverage (priority order — the #109 spec's six forms plus the
// flat/nested record fallbacks the spec keeps as "open forms → raw collapse"):
//   ① content-block array / {content:[…]}   → text join (LLM/MCP tool results)
//   ② array (non-path items)                → "共 N 项" + first 3 item previews
//   ③ path-led array (paths/grep lines)     → the lines as-is, path lines first
//   ④ record with dominant array field      → same as ②/③ (matches/results/…)
//   ⑤ record with path + body strings       → path on the first line, body after
//   ⑥ record with url/title                 → title, then the url
//   ⑦ record with ok/success boolean        → success/failure word (via t())
//   ⑧ flat record / nested record           → └─ tree: sub-keys one per line,
//                                             2-space + └─ per level (formatHuman)
// Open forms that match nothing (primitives, empty shapes) return
// {summary:null, hadStructure:false}; the caller keeps its own last resort and
// the raw payload goes to the JSON collapse layer verbatim.

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

// Human-readable rendering as a nested tree (#169): record sub-keys and array
// items go on their own lines, each nesting level indented 2 spaces with a
// └─ prefix — rendered inside the existing monospace .tool-pre, whose
// white-space:pre-wrap preserves the layout, so a plain string return suffices.
// Guards: a subtree deeper than TREE_DEPTH_MAX collapses to one formatInline
// line (full content, not elided); arrays beyond TREE_ARRAY_MAX show the first
// PREVIEW_ITEMS plus an "N more" tail; leaf lines clip at PREVIEW_LINE_MAX;
// cycles render ↻ via a path seen-set. `t` is optional: the direct ChatView
// fallback callsites pass no t, but they only ever see empty/scalar roots
// (anything structural is summarized first), so no i18n-bearing line is
// produced without it.
export function formatHuman(v: unknown, t?: TranslateFn): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Top-level empty containers stay "" — the summarizer's open-form gate
  // (summarizeToolPayload → NO_STRUCTURE) depends on the falsy result.
  const emptyContainer = Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0;
  if (emptyContainer) return "";
  const out: Array<[number, string]> = [];
  flattenTree(v, 0, new WeakSet<object>(), t, out);
  // Level-0 lines are the tree's roots (bare, matching the old flat look);
  // every deeper line gets its level's indent plus the └─ child prefix.
  return out.map(([lvl, line]) => (lvl > 0 ? TREE_INDENT.repeat(lvl) + TREE_PREFIX + line : line)).join("\n");
}

// Single-line rendering for nested values. Recursively flattens objects/arrays
// into "key: value" fragments — never JSON.stringify (#109: nested objects used
// to leak raw JSON here). `seen` guards reference cycles (D6): re-entering an
// object already on the current descent path renders ↻. Optional so the public
// one-arg callsites (preview lines, depth-cap flattening) keep their exact
// semantics; they simply start a fresh set.
export function formatInline(v: unknown, seen?: WeakSet<object>): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) || isRecord(v)) {
    const path = seen ?? new WeakSet<object>();
    if (path.has(v)) return CYCLE_MARK;
    path.add(v);
    const out = Array.isArray(v)
      ? v.map((x) => formatInline(x, path)).filter(Boolean).join(", ")
      : Object.entries(v)
          .filter(([, val]) => val != null && val !== "")
          .map(([k, val]) => `${k}: ${formatInline(val, path)}`)
          .join(", ");
    path.delete(v);
    return out;
  }
  return String(v);
}

// How many array items to preview and how wide one preview line may get before
// being clipped (downstream CollapsibleText handles overall length folding).
const PREVIEW_ITEMS = 3;
const PREVIEW_LINE_MAX = 200;

// Tree rendering knobs (#169): 2-space indent per level + └─ child prefix (D2);
// depth cap beyond which a subtree flattens to one line (D3); array item cap
// with an "N more" tail (D4). Line width shares PREVIEW_LINE_MAX with the
// preview clipper (D5).
const TREE_INDENT = "  ";
const TREE_PREFIX = "└─ ";
const TREE_DEPTH_MAX = 4;
const TREE_ARRAY_MAX = 8;

// D6 cycle marker: pure symbol, deliberately not an i18n key.
const CYCLE_MARK = "↻";

// Clip one rendered line to PREVIEW_LINE_MAX with an ellipsis. Shared by the
// summarize previews and the tree renderer so both caps move together (D5).
function clipLine(s: string): string {
  return s.length > PREVIEW_LINE_MAX ? `${s.slice(0, PREVIEW_LINE_MAX - 1)}…` : s;
}

// D7 empty-node word. `t` is undefined only on the direct ChatView fallback
// callsites, which never produce these lines (see formatHuman).
function emptyValueLabel(t: TranslateFn | undefined): string {
  return t ? t("chat.emptyValue") : "(empty)";
}

// Depth-first flatten of one node into (level, line) pairs. `level` is the
// line's nesting depth (0 = root); formatHuman turns each pair into one tree
// line. A node's content sits at its own level: record entries and array items
// alike, so only real container descent adds a └─ step. `seen` holds the
// objects on the current descent path — re-entering one is a reference cycle.
function flattenTree(v: unknown, level: number, seen: WeakSet<object>, t: TranslateFn | undefined, out: Array<[number, string]>): void {
  // D3: past the depth cap the whole subtree flattens to a single line,
  // deliberately unclipped — full content survives, nothing is elided.
  if (level > TREE_DEPTH_MAX) {
    out.push([level, formatInline(v, seen)]);
    return;
  }
  // D7: empty value nodes render the localized "(empty)" word.
  if (v == null || v === "") {
    out.push([level, emptyValueLabel(t)]);
    return;
  }
  if (typeof v === "string") {
    for (const l of v.split("\n")) out.push([level, clipLine(l)]);
    return;
  }
  if (typeof v === "number" || typeof v === "boolean") {
    out.push([level, String(v)]);
    return;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) {
      out.push([level, emptyValueLabel(t)]);
      return;
    }
    if (seen.has(v)) {
      out.push([level, CYCLE_MARK]);
      return;
    }
    seen.add(v);
    try {
      // D4: up to TREE_ARRAY_MAX items tree-ify in full; beyond that the first
      // PREVIEW_ITEMS plus an "N more" tail on its own line.
      const head = v.length > TREE_ARRAY_MAX ? PREVIEW_ITEMS : v.length;
      for (const item of v.slice(0, head)) flattenTree(item, level, seen, t, out);
      if (v.length > TREE_ARRAY_MAX) {
        const rest = v.length - PREVIEW_ITEMS;
        out.push([level, t ? t("chat.itemsMore", { count: rest }) : `…and ${rest} more`]);
      }
    } finally {
      seen.delete(v);
    }
    return;
  }
  if (isRecord(v)) {
    if (seen.has(v)) {
      out.push([level, CYCLE_MARK]);
      return;
    }
    seen.add(v);
    try {
      for (const [k, val] of Object.entries(v)) {
        // D7: null/"" entries render "(empty)" instead of being skipped.
        if (val == null || val === "") {
          out.push([level, `${k}: ${emptyValueLabel(t)}`]);
          continue;
        }
        if (typeof val === "string") {
          const lines = val.split("\n").map(clipLine);
          out.push([level, clipLine(`${k}: ${lines[0]}`)]);
          for (const l of lines.slice(1)) out.push([level, l]);
          continue;
        }
        if (typeof val === "number" || typeof val === "boolean") {
          out.push([level, `${k}: ${String(val)}`]);
          continue;
        }
        // Empty containers inline as "(empty)"; real ones open a child block.
        const emptyVal = Array.isArray(val) ? val.length === 0 : Object.keys(val).length === 0;
        if (emptyVal) {
          out.push([level, `${k}: ${emptyValueLabel(t)}`]);
          continue;
        }
        // D3: this entry's subtree would exceed the cap → inline after the key.
        if (level + 1 > TREE_DEPTH_MAX) {
          out.push([level, `${k}: ${formatInline(val, seen)}`]);
          continue;
        }
        out.push([level, `${k}:`]);
        flattenTree(val, level + 1, seen, t, out);
      }
    } finally {
      seen.delete(v);
    }
    return;
  }
  out.push([level, String(v)]);
}

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
    // Collapse each preview item to one clipped line (same cap as the tree
    // renderer via clipLine, D5); full values stay available in the raw
    // payload disclosure rendered next to summaries.
    const s = formatInline(item).replace(/\s+/g, " ").trim();
    lines.push(`- ${clipLine(s)}`);
  }
  const rest = items.length - PREVIEW_ITEMS;
  if (rest > 0) lines.push(t("chat.itemsMore", { count: rest }));
  return lines.join("\n");
}

// Content-block array (category ①): [{type:"text",text:"…"}, …] — the LLM/MCP
// tool-result convention. Joins the text parts (one block per line; blocks
// carry their own intra-block whitespace). All-or-nothing: if any item lacks a
// string `text` (image blocks, plain scalars) the caller falls through to the
// generic count+preview treatment instead. Null when nothing text-shaped.
function joinTextBlocks(items: unknown[]): string | null {
  if (items.length === 0) return null;
  const parts: string[] = [];
  for (const item of items) {
    if (!isRecord(item) || typeof item.text !== "string") return null;
    parts.push(item.text);
  }
  const joined = parts.join("\n").trim();
  return joined || null;
}

export type ToolSummary = { summary: string | null; hadStructure: boolean };

// Shared "no recognized structure" result: the caller renders its own last
// resort and the raw payload goes to the JSON collapse layer verbatim.
const NO_STRUCTURE: ToolSummary = { summary: null, hadStructure: false };

// Summarize a fallback payload (no known text key matched) in plain language.
// Returns {summary, hadStructure} per the #109 spec: hadStructure is true when
// a known shape was recognized (the summary is the authoritative digest),
// false for open forms where only the raw collapse carries real information.
export function summarizeToolPayload(raw: unknown, t: TranslateFn): ToolSummary {
  if (raw == null || typeof raw !== "object") return NO_STRUCTURE;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return NO_STRUCTURE;
    // ① before ②③: a text-block array must join, not become "N items".
    return { summary: joinTextBlocks(raw) ?? summarizeArray(raw, t), hadStructure: true };
  }
  if (!isRecord(raw)) return NO_STRUCTURE;
  // ① Content blocks wrapped in a record (MCP tool result {content: [...]}).
  if (Array.isArray(raw.content)) {
    const blocks = joinTextBlocks(raw.content);
    if (blocks) return { summary: blocks, hadStructure: true };
  }
  // ④ Dominant array field (e.g. {matches: [...]}): same treatment as ②③.
  for (const k of ARRAY_FIELDS) {
    const v = raw[k];
    if (Array.isArray(v) && v.length > 0) return { summary: summarizeArray(v, t), hadStructure: true };
  }
  // ⑤ Read/write shape: path first, body after.
  const path = extractFilePath(raw);
  const body = pickStr(raw, BODY_KEYS);
  if (path && body) return { summary: `${path}\n${body}`, hadStructure: true };
  // ⑥ Link/fetch shape: title first, then the url (either may be absent).
  const title = pickStr(raw, ["title"]);
  const url = pickStr(raw, ["url"]);
  if (title || url) return { summary: [title, url].filter(Boolean).join("\n"), hadStructure: true };
  // ⑦ Success flag: {ok: true} / {success: false} → the word, not "ok: true".
  const ok = typeof raw.ok === "boolean" ? raw.ok : typeof raw.success === "boolean" ? raw.success : null;
  if (ok !== null) return { summary: t(ok ? "chat.toolSucceeded" : "chat.toolFailed"), hadStructure: true };
  // ⑧ Flat / nested record: └─ tree (JSON-free after formatInline).
  const flat = formatHuman(raw, t);
  return flat ? { summary: flat, hadStructure: true } : NO_STRUCTURE;
}

// Faithful pretty-print of a raw payload — the #109 fidelity contract: the
// summary line is for reading, while the copy button and the collapsed
// disclosure <pre> carry the exact machine payload (JSON.stringify(raw, null, 2)).
export function rawJsonText(raw: unknown): string {
  try {
    return JSON.stringify(raw, null, 2) ?? String(raw);
  } catch {
    return String(raw);
  }
}
