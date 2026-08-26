// mermaidExport.ts(issue #86):rasterize a rendered mermaid SVG string to a PNG
// and copy it to the clipboard as an image, falling back to a file download when
// image clipboard writes are unavailable.
//
// Pipeline:
//  1. buildStandaloneSvg(svg): produce a self-contained SVG copy for
//     rasterization. Page CSS does NOT apply when the SVG is decoded inside an
//     <img>, so computed styles from the live document are inlined as style
//     attributes (the "style inlining" step). Explicit pixel width/height +
//     xmlns make the blob decode reliably in WKWebView / WebView2 (SVGs without
//     them can decode as 0×0).
//  2. rasterizeSvgToPng(svg, opts): decode via blob URL, draw onto a canvas at
//     2x scale (retina-sharp paste), fill the theme background first so
//     dark-theme diagrams keep their dark canvas instead of going transparent
//     (light text on a white paste target would be invisible).
//  3. copyImageWithClipboardFallback(png): ClipboardItem branch first
//     (WebKit/Chromium image clipboard), download fallback when the write
//     rejects or the API is missing (Firefox has no ClipboardItem; locked-down
//     webviews reject clipboard.write).
//
// Note on fonts: only system fonts referenced by the diagram's embedded styles
// resolve inside the <img> decode context (same fonts the live view uses — we
// ship no web fonts for mermaid), so raster matches the rendered diagram.
//
// Never throws; callers get a tri-state outcome to drive button feedback.

import { currentMermaidTheme, themeBackground, type MermaidTheme } from "./mermaidRenderer";
import { downloadBlob } from "./download";

export type ImageCopyOutcome = "copied" | "downloaded" | "failed";

// 2x rasterization: retina-sharp when pasted, still a sane PNG size.
const EXPORT_SCALE = 2;
// Clamp each rasterized side before scaling (engine canvas limits ≈16k px).
const MAX_BASE_SIDE = 8192;

// SVG paint properties copied from live computed styles onto the standalone
// clone. Layout properties (width/height/margin…) are deliberately absent:
// mermaid positions everything via attributes and the export size comes from
// the viewBox, not from CSS.
const INLINED_STYLE_PROPS = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "color",
  "opacity",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "text-anchor",
  "dominant-baseline",
  "alignment-baseline",
  "letter-spacing",
  "word-spacing",
  "text-decoration",
] as const;

// Parse an SVG string into an SVGSVGElement; null for anything un-parseable.
function parseSvg(svg: string): SVGSVGElement | null {
  try {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== "svg") return null;
    if (doc.querySelector("parsererror")) return null;
    return root as unknown as SVGSVGElement;
  } catch {
    return null;
  }
}

// Natural size of a mermaid SVG: viewBox first (mermaid sets width="100%" with
// a max-width style, so attributes alone are unreliable), then width/height
// attributes as px, else null (unsized → cannot rasterize deterministically).
export function svgNaturalSize(el: SVGSVGElement): { width: number; height: number } | null {
  const vb = el.viewBox?.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) return { width: vb.width, height: vb.height };
  // viewBox attribute fallback: some DOM implementations lack the
  // SVGAnimatedRect API but still parse the attribute.
  const vbAttr = el.getAttribute("viewBox");
  if (vbAttr) {
    const nums = vbAttr.trim().split(/[\s,]+/).map(Number);
    if (nums.length === 4 && nums.slice(2).every((n) => Number.isFinite(n) && n > 0)) {
      return { width: nums[2], height: nums[3] };
    }
  }
  const wAttr = el.getAttribute("width") || "";
  const hAttr = el.getAttribute("height") || "";
  // Percentages (mermaid's width="100%") are not a rasterizable size.
  if (!wAttr.includes("%") && !hAttr.includes("%")) {
    const w = parseFloat(wAttr);
    const h = parseFloat(hAttr);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { width: w, height: h };
  }
  return null;
}

// Copy computed paint styles from the live document onto every element of the
// (currently mounted) clone. Empty computed values are skipped so untouched
// properties keep inheriting from the SVG's embedded <style>.
function inlineComputedStyles(root: SVGSVGElement): void {
  const els = [root, ...root.querySelectorAll<SVGElement>("*")];
  for (const el of els) {
    const cs = getComputedStyle(el);
    if (!cs) continue;
    for (const prop of INLINED_STYLE_PROPS) {
      const v = cs.getPropertyValue(prop);
      if (v) el.style.setProperty(prop, v);
    }
  }
}

// Style-inlining mount wrapper: computed styles only exist for elements inside
// the live document, and display:none would blank resolved values in some
// engines — so park the clone off-screen instead. The .mermaid-svg-host class
// gives it the same page-CSS context as the rendered view.
function inlineStylesViaHiddenMount(clone: SVGSVGElement): void {
  const holder = document.createElement("div");
  holder.className = "mermaid-svg-host";
  holder.setAttribute("aria-hidden", "true");
  holder.style.position = "fixed";
  holder.style.left = "-99999px";
  holder.style.top = "0";
  holder.style.width = "1px";
  holder.style.height = "1px";
  holder.style.overflow = "hidden";
  holder.style.opacity = "0";
  holder.appendChild(clone);
  document.body.appendChild(holder);
  try {
    inlineComputedStyles(clone);
  } finally {
    document.body.removeChild(holder);
  }
}

// Build the standalone (rasterization-ready) SVG: clone the parsed root, inline
// computed styles, pin explicit pixel dimensions + xmlns. Returns null for
// un-parseable / unsized input.
export function buildStandaloneSvg(svg: string): { svg: string; width: number; height: number } | null {
  const root = parseSvg(svg);
  if (!root) return null;
  const size = svgNaturalSize(root);
  if (!size) return null;
  const width = Math.min(Math.ceil(size.width), MAX_BASE_SIDE);
  const height = Math.min(Math.ceil(size.height), MAX_BASE_SIDE);

  const clone = root.cloneNode(true) as SVGSVGElement;
  inlineStylesViaHiddenMount(clone);

  // Strip display-only sizing from the live view (zoom width, max-width fit)
  // and pin export dimensions: <img> decode needs concrete px or some engines
  // rasterize 0×0.
  clone.style.removeProperty("width");
  clone.style.removeProperty("max-width");
  clone.style.removeProperty("height");
  clone.removeAttribute("width");
  clone.removeAttribute("height");
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));

  return { svg: new XMLSerializer().serializeToString(clone), width, height };
}

function decodeImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("mermaid export: svg decode failed"));
    img.src = url;
  });
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

// Rasterize an SVG string to a PNG blob at `scale` (default 2x) over the
// theme background. Throws on parse/decode/canvas failure — callers treat a
// throw as "failed" feedback.
export async function rasterizeSvgToPng(
  svg: string,
  opts: { scale?: number; theme?: MermaidTheme } = {},
): Promise<Blob> {
  const theme = opts.theme ?? currentMermaidTheme();
  const scale = opts.scale ?? EXPORT_SCALE;
  const standalone = buildStandaloneSvg(svg);
  if (!standalone) throw new Error("mermaid export: not a sized svg");

  const url = URL.createObjectURL(new Blob([standalone.svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = await decodeImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(standalone.width * scale);
    canvas.height = Math.round(standalone.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("mermaid export: no 2d context");
    ctx.scale(scale, scale);
    ctx.fillStyle = themeBackground[theme];
    ctx.fillRect(0, 0, standalone.width, standalone.height);
    ctx.drawImage(img, 0, 0, standalone.width, standalone.height);
    const png = await canvasToPng(canvas);
    if (!png) throw new Error("mermaid export: canvas.toBlob returned null");
    return png;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Copy a PNG blob (or a promise of it) to the clipboard as an image, falling
// back to a file download when the image clipboard is unavailable/rejected.
// Outcomes drive button feedback; never throws.
export async function copyImageWithClipboardFallback(png: Promise<Blob> | Blob): Promise<ImageCopyOutcome> {
  if (typeof ClipboardItem === "function" && navigator.clipboard?.write) {
    try {
      // Safari requires ClipboardItem construction inside the user gesture:
      // hand it the *promise*, never the awaited blob, so clipboard.write is
      // reached while the activation is still alive.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      return "copied";
    } catch {
      // Image clipboard unsupported or write rejected — fall through to the
      // download path. A rejected rasterization promise rethrows on `await`
      // below and maps to "failed".
    }
  }
  try {
    const blob = await png;
    downloadBlob(blob, exportFilename());
    return "downloaded";
  } catch {
    return "failed";
  }
}

function exportFilename(): string {
  const ts = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `mermaid-${ts.getFullYear()}${p(ts.getMonth() + 1)}${p(ts.getDate())}-${p(ts.getHours())}${p(ts.getMinutes())}${p(ts.getSeconds())}.png`;
}

// Entry point for the "copy as image" button: rasterize at 2x and copy, with a
// download fallback. Rasterization starts synchronously (before any await) so
// Safari's user-gesture window covers the ClipboardItem construction.
export async function copyMermaidImage(svg: string): Promise<ImageCopyOutcome> {
  return copyImageWithClipboardFallback(rasterizeSvgToPng(svg));
}
