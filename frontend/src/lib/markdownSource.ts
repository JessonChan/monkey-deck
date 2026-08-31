// markdownSource.ts (#177): map a DOM text selection back to its original
// markdown source.
//
// react-markdown@9 (passNode) hands every custom component the hast element,
// whose `node.position.start/end.offset` are byte-valid UTF-16 code-unit
// offsets (String.slice indices) into the exact raw string passed to the
// renderer — probe-verified for p/strong/li/table/code on the pinned
// react-markdown@9.1.0. ChatView stamps those offsets onto the rendered DOM
// as data-md-s / data-md-e (see mdSourceProps), so a selection made in the
// rendered message resolves back to the authoring markdown: "copy as
// markdown source".
//
// Resolution rules (markdownSourceFromSelection):
// - a selection boundary resolves to its NEAREST stamped ancestor; boundaries
//   in unstamped content (tool cards, thought blocks, plain-text bubbles,
//   mermaid/math blocks) yield no result → callers fall back to plain text;
// - both boundaries must live under the same message root ([data-md-msg]);
//   a selection spanning two messages is not representable in one source;
// - when one stamped element encloses both boundaries (a whole table, a
//   blockquote, an inline bold span…), its span wins — selecting across table
//   cells yields the whole table's source, never a broken row fragment;
// - otherwise the boundaries expand to their nearest BLOCK-level stamped
//   ancestors (inline marks are skipped) and their spans are unioned, so the
//   source between them (blank lines, list markers…) travels along and the
//   slice re-parses to the same block structure.

// Props react-markdown adds to custom components (hast-util-to-jsx-runtime
// passNode). Declared structurally so component signatures stay compatible
// with the exact Element type without importing hast.
export type MdComponentProps = { node?: unknown };

// data-md-msg: attribute stamped on each rendered markdown message root;
// anchors from different roots never mix into one source slice.
const MSG_ATTR = "data-md-msg";
// data-md-s / data-md-e: source-span attributes on rendered markdown elements.
const START_ATTR = "data-md-s";
const END_ATTR = "data-md-e";

// Source-span DOM props for a react-markdown component's hast node: converts
// node.position into data-md-s / data-md-e. Returns {} when the node carries
// no usable position (raw HTML, synthetic nodes) — the element then renders
// unstamped and selections inside it climb to the nearest stamped ancestor.
export function mdSourceProps(node: unknown): { [START_ATTR]?: string; [END_ATTR]?: string } {
  const pos = (node as { position?: { start?: { offset?: number }; end?: { offset?: number } } } | null | undefined)?.position;
  const s = pos?.start?.offset;
  const e = pos?.end?.offset;
  if (typeof s !== "number" || typeof e !== "number" || s < 0 || e < s) return {};
  return { [START_ATTR]: String(s), [END_ATTR]: String(e) };
}

type Span = { el: Element; s: number; e: number };

// Stamped source span directly on `el`, or null when absent/invalid.
function spanOf(el: Element): Span | null {
  const s = el.getAttribute(START_ATTR);
  const e = el.getAttribute(END_ATTR);
  if (s === null || e === null) return null;
  const si = Number(s);
  const ei = Number(e);
  if (!Number.isInteger(si) || !Number.isInteger(ei) || si < 0 || ei < si) return null;
  return { el, s: si, e: ei };
}

// Nearest stamped ancestor-or-self of `node`. nodeType 1 = element: checked
// directly so the module never needs the Element constructor in scope (test
// runtimes don't register it as a global).
function spanAnchor(node: Node | null): Span | null {
  let el: Element | null = node && node.nodeType === 1 ? (node as Element) : node?.parentElement ?? null;
  for (; el; el = el.parentElement) {
    const span = spanOf(el);
    if (span) return span;
  }
  return null;
}

// Deepest stamped ancestor-or-self of `side.el` that also contains `other.el`
// (DOM containment ⇒ shared ancestor in the source tree too).
function commonSpan(side: Span, other: Span): Span | null {
  for (let el: Element | null = side.el; el; el = el.parentElement) {
    if (!el.contains(other.el)) continue;
    const span = spanOf(el);
    if (span) return span;
  }
  return null;
}

// Inline marks: skipped when expanding a boundary to block level, so a union
// never starts/ends mid-decoration and drops the plain words around it.
const INLINE_TAGS: Record<string, true> = { a: true, code: true, strong: true, em: true, del: true, span: true, b: true, i: true, s: true, u: true };
// Nearest BLOCK-level stamped span for a resolved boundary.
function blockSpan(side: Span): Span {
  let el: Element | null = side.el;
  while (el && INLINE_TAGS[el.tagName.toLowerCase()]) el = el.parentElement;
  return (el && spanAnchor(el)) || side;
}

// Markdown source for the current window selection, resolved against `raw` —
// the exact string the selected message was rendered from (streaming agent
// messages include the caret glyph, since the stamped offsets are valid
// against that composed string). Returns "" whenever the selection cannot be
// represented in `raw`; callers fall back to plain-text copy.
export function markdownSourceFromSelection(raw: string): string {
  if (!raw) return "";
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return "";
  const a = spanAnchor(sel.anchorNode);
  const f = spanAnchor(sel.focusNode);
  if (!a || !f) return "";
  const rootA = a.el.closest(`[${MSG_ATTR}]`);
  const rootF = f.el.closest(`[${MSG_ATTR}]`);
  if (rootA && rootF && rootA !== rootF) return "";
  const common = commonSpan(a, f) ?? commonSpan(f, a);
  let s: number;
  let e: number;
  if (common) {
    s = common.s;
    e = common.e;
  } else {
    const ba = blockSpan(a);
    const bf = blockSpan(f);
    s = Math.min(ba.s, bf.s);
    e = Math.max(ba.e, bf.e);
  }
  // Clamp instead of reject: the streaming caret glyph sits past raw's end,
  // and a stale UI must degrade to a shorter slice, never a wrong one.
  s = Math.max(0, s);
  e = Math.min(raw.length, e);
  if (s >= e) return "";
  return raw.slice(s, e).replace(/\n+$/, "");
}
