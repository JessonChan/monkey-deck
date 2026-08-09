// Global font scale: persisted in localStorage, applied as a `--font-scale` CSS
// custom property on :root. Key font-size declarations in index.css reference it
// via calc(...) (e.g. `calc(13px * var(--font-scale))`) so a single slider resizes
// the primary text scale across the app (issue #102).
//
// Scope: only "key" font sizes (body / bubbles / code / sidebar / etc.) reference
// --font-scale. Auxiliary chrome (badges, tiny meta labels) stay fixed to keep
// information density stable — matching the issue's "key font-size" requirement.
//
// Persisted as a number string (e.g. "1.15"); falls back to 1 when missing/invalid.

const STORAGE_KEY = "md:font-scale";

// Clamp bounds: 0.8 (compact) … 1.6 (large). Beyond this the layout breaks
// (truncation, overlapping controls) — better to refuse than ship a broken UI.
export const FONT_SCALE_MIN = 0.8;
export const FONT_SCALE_MAX = 1.6;
export const FONT_SCALE_DEFAULT = 1;

export function clampFontScale(v: number): number {
  if (!Number.isFinite(v)) return FONT_SCALE_DEFAULT;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(v * 100) / 100));
}

// Read persisted scale; returns clamped value (never throws).
export function readFontScale(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return FONT_SCALE_DEFAULT;
    return clampFontScale(parseFloat(raw));
  } catch {
    return FONT_SCALE_DEFAULT; // restricted environment fallback
  }
}

// Persist + clamp. Silently no-ops in restricted storage environments.
export function writeFontScale(scale: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(clampFontScale(scale)));
  } catch {
    /* noop: private mode / restricted storage */
  }
}

// Apply the scale as `--font-scale` on :root. Call on app boot and whenever the
// slider changes. No-op when document is unavailable (SSR / tests).
export function applyFontScale(scale: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--font-scale", String(clampFontScale(scale)));
}
