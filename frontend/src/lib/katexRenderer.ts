// KaTeX rendering wrapper (#135): lazy-loads katex + stylesheet, caches rendered
// HTML by source hash.
import type { KatexOptions } from "katex";
//
// Design notes (AGENTS.md §4.6 / §5.3):
// - Mature library first: KaTeX is the de-facto standard for browser-side LaTeX;
//   we render its HTML output verbatim instead of building our own TeX subset.
// - Lazy loading: katex (~300KB min JS + fonts pulled in by its CSS) must not sit
//   in the initial chat bundle. Both the module and the stylesheet go through a
//   dynamic import triggered by the FIRST math node app-wide; Vite splits them
//   into separate chunks and injects the stylesheet when the chunk loads (same
//   strategy as lib/mermaidRenderer.ts).
// - Trust boundary: KaTeX is documented to render untrusted input safely. We
//   additionally pass `trust: false` (disables \href/\includegraphics URL
//   emission) so the produced HTML is safe to hand to dangerouslySetInnerHTML.
// - Hash cache: identical source → identical HTML string. Module-level Map shared
//   across component instances and virtualized-scroll remounts, keyed by display
//   mode (inline vs block produce different markup) — mirrors the mermaid SVG
//   cache. Lets remounts paint synchronously without an idle→rendered flash.
//   { ok: false } so the component can fall back to showing the raw source.

// A rejected load resets the singleton so a later formula retries the import
// (e.g. transient fetch failure of the chunk).
type RenderKatexFn = (tex: string, options?: KatexOptions) => string;
let katexPromise: Promise<RenderKatexFn> | null = null;

// Load katex and its stylesheet as one unit. Keeping both imports in one
// dynamic chunk makes the stylesheet arrive with (or before) the first render
// that needs it; Vite injects a <link> when this import settles.
async function loadKatex(): Promise<RenderKatexFn> {
  const [mod] = await Promise.all([
    import("katex"),
    import("katex/dist/katex.min.css"),
  ]);
  return mod.default.renderToString.bind(mod.default);
}

async function ensureKatex(): Promise<RenderKatexFn> {
  katexPromise ??= loadKatex();
  try {
    return await katexPromise;
  } catch (err) {
    katexPromise = null;
    throw err;
  }
}

export type KatexRenderResult =
  | { ok: true; html: string }
  | { ok: false; error: string };

// djb2 string hash → base36. Fast, well-distributed, no crypto needs — same
// primitive as the mermaid cache key.
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function cacheKey(source: string, displayMode: boolean): string {
  return `${displayMode ? "d" : "i"}:${hashString(source.trim())}`;
}

// Rendered-HTML cache. Only strings are stored (fully serializable), so cache
// hits are synchronous and cheap across remounts.
const htmlCache = new Map<string, string>();

// Synchronous lookup used by components on mount: if this exact formula was
// already rendered, paint it immediately without a loading frame.
export function getCachedKatexHtml(source: string, displayMode: boolean): string | undefined {
  return htmlCache.get(cacheKey(source, displayMode));
}

// Render entry point: success → { ok, html }; katex missing/failure → { ok:false }.
export async function renderKatex(source: string, displayMode: boolean): Promise<KatexRenderResult> {
  const key = cacheKey(source, displayMode);
  const cached = htmlCache.get(key);
  if (cached !== undefined) return { ok: true, html: cached };
  let renderKatexToString: RenderKatexFn;
  try {
    renderKatexToString = await ensureKatex();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const html = renderKatexToString(source.trim(), {
      displayMode,
      throwOnError: false, // invalid TeX renders as highlighted source, not a throw
      strict: false, // don't spam console warnings for non-strict LaTeX dialects
      trust: false, // see trust-boundary note above
      output: "html",
    });
    htmlCache.set(key, html);
    return { ok: true, html };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Test-only: clear cache + force a fresh dynamic import on next call.
export function __resetKatexCacheForTest(): void {
  htmlCache.clear();
  katexPromise = null;
}
