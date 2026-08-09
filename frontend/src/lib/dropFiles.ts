// dropFiles.ts:routing for OS files dropped onto the chat area (Task #24255 / #83).
//
// Wails3 native drop (internal/chat/drop.go) hands us absolute paths; here we split
// each into one of three composer inputs, keyed by whether it lives inside the
// session's working tree:
//
//   - inside worktree + ACP-image ext + agent supports images → inline image
//     attachment (read via SessionReadImage, same path the file panel uses).
//   - inside worktree + anything else (non-image, dir, or image when the agent
//     can't take images) → @mention with the path relative to the cwd (agent
//     reads it itself via tools).
//   - outside worktree → paperclip attachment (absolute path), exactly like the
//     PickFiles paperclip flow (also absolute paths).
//
// The "inside worktree" test mirrors the backend cwdOf (worktreePath || project.path)
// so a file we consider internal is one the agent can reach at the same relative
// path — keeps @mentions and SessionReadImage's safeJoin aligned (§5.3).

import type { ImageAttachment, Mention } from "../types";

// Image extensions sendable inline as ACP ContentBlock::Image. Matches Composer's
// IMAGE_MIME_ALLOWED (png/jpeg/webp/gif). Other image-like exts (bmp/svg/ico) are
// previewable but not ACP-sendable, so they fall through to @mention.
const ACP_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

function isAcpImage(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return false;
  return ACP_IMAGE_EXTS.has(name.slice(dot + 1).toLowerCase());
}

// normPath: unify separators, collapse repeats, strip trailing slash. Used only
// for prefix comparison + rel extraction, never displayed (we keep the original
// absolute path verbatim for external attachments).
function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

// baseName splits on the last separator after normalization (handles both / and \).
function baseName(p: string): string {
  const n = normPath(p);
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}

// relativeToRoot computes `abs` relative to `root`. Returns:
//   - null  → `abs` is NOT inside `root` (external); never contains ".." since the
//             prefix check rejects any escape.
//   - ""    → `abs` is the root dir itself.
//   - <rel> → the relative path (no leading slash, forward slashes).
//
// Comparison is case-insensitive to tolerate Windows drive-letter casing and
// macOS HFS+ quirks; the returned rel preserves the original casing of `abs`.
export function relativeToRoot(root: string, abs: string): string | null {
  if (!root || !abs) return null;
  const r = normPath(root);
  const a = normPath(abs);
  const rl = r.toLowerCase();
  const al = a.toLowerCase();
  if (al === rl) return "";
  if (al.startsWith(rl + "/")) {
    return a.slice(r.length + 1);
  }
  return null;
}

export interface DropRouteResult {
  // Internal non-image / dir / unsupported-image files → @mentions.
  mentions: Mention[];
  // The "@<path> " tokens to append to the composer draft, one per mention. Kept
  // separate so the caller can stitch into its own draft state. Order matches
  // mentions. (§5.3: the mention list is the truth, the text token is what makes
  // submit's inline-filter keep it — both are needed.)
  mentionText: string;
  // External files (absolute paths) → paperclip attachments.
  attachments: string[];
  // Internal ACP-image files → inline image attachments (base64, already read).
  images: ImageAttachment[];
}

export interface DropRouteOptions {
  root: string;           // session cwd (worktreePath || project.path)
  imageSupported: boolean; // agent declared image prompt capability
  sessionId: string;
}

// readImage reads a worktree-relative image as a data URL. Injected so tests can
// mock it without touching the real ChatService binding. Production wires it to
// ChatService.SessionReadImage (see routeDroppedFiles default).
export type ReadImageFn = (sessionId: string, rel: string) => Promise<{ dataUrl?: string } | null | undefined>;

// parseDataUrl splits "data:<mime>;base64,<b64>" into {mime, data}. Returns null
// for anything else (non-image / malformed) so the caller falls back to @mention.
function parseDataUrl(dataUrl: string): { mime: string; data: string } | null {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  return { mime: m[1], data: m[2] };
}

// routeDroppedFiles categorizes a list of dropped absolute paths into mentions /
// attachments / inline images (see file header). Image reading is best-effort:
// any failure (too big, not actually an image, read error) falls through to a
// plain @mention so the drop never silently loses a file.
export async function routeDroppedFiles(
  files: string[],
  opts: DropRouteOptions,
  readImage: ReadImageFn,
): Promise<DropRouteResult> {
  const mentions: Mention[] = [];
  const attachments: string[] = [];
  const images: ImageAttachment[] = [];
  const mentionTokens: string[] = [];

  for (const f of files) {
    const rel = relativeToRoot(opts.root, f);
    if (rel === null) {
      // External → paperclip attachment (absolute path, like PickFiles).
      attachments.push(f);
      continue;
    }
    // The root dir itself dropped: not useful as a reference — skip (don't emit
    // an "@." token). Everything else below has a non-empty rel.
    if (rel === "") continue;

    const name = baseName(f);
    if (isAcpImage(name) && opts.imageSupported) {
      try {
        const img = await readImage(opts.sessionId, rel);
        const parsed = parseDataUrl(img?.dataUrl ?? "");
        if (parsed) {
          images.push({ name, data: parsed.data, mimeType: parsed.mime });
          continue;
        }
      } catch {
        // fall through to @mention
      }
    }
    // Default: internal → @mention (relative path; matches pickMention semantics).
    mentions.push({ path: rel, name });
    mentionTokens.push("@" + rel + " ");
  }

  return { mentions, mentionText: mentionTokens.join(""), attachments, images };
}
