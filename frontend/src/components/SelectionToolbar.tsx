import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

// A single action offered by the floating selection toolbar.
export interface SelectionAction {
  // Stable key for React list reconciliation.
  key: string;
  // i18n key for the button label (also used as aria-label).
  labelKey: string;
  // i18n key for the hover tooltip (§4.5).
  tipKey: string;
  // Lucide icon component (or any component accepting { size?: number }).
  Icon: React.ComponentType<{ size?: number }>;
  // Test id for the rendered button (§4.2).
  testId?: string;
  // Invoked with the currently selected plain text. After it returns the toolbar
  // clears the selection (which dismisses it via the selectionchange listener).
  run: (text: string) => void;
}

interface Props {
  // Selection is only recognized when its anchor lives inside this element.
  // Typed structurally so HTMLDivElement / HTMLElement refs both fit.
  scope: { readonly current: HTMLElement | null };
  // Actions to offer; order is preserved left-to-right.
  actions: SelectionAction[];
}

// Floating toolbar shown when the user selects (highlights) text within `scope`.
// Renders nothing while the selection is empty, collapsed, outside scope, or inside
// an input/textarea/contenteditable (those have their own native affordances).
// Positioned just above the selection using viewport coords (position: fixed).
// Dismissed on scroll, Escape, or when the selection collapses (clicking elsewhere,
// an action running, etc. — driven by the selectionchange listener).
//
// Mouse interaction: each button prevents default on mousedown so the selection
// stays alive across the click (otherwise the browser collapses the selection on
// mousedown and the toolbar vanishes before onClick fires). After the action the
// toolbar clears the selection, which dismisses it cleanly.
export default function SelectionToolbar({ scope, actions }: Props) {
  const { t } = useTranslation();
  // null = hidden; otherwise viewport-anchored position + the selected text.
  const [sel, setSel] = useState<{ x: number; y: number; text: string } | null>(null);
  const rafRef = useRef(0);
  const toolbarRef = useRef<HTMLDivElement>(null);

  // selectionchange fires on every selection mutation (drag, keyboard, click).
  // Coalesce per-frame via rAF so a rapid drag doesn't thrash setState.
  useEffect(() => {
    const compute = () => {
      rafRef.current = 0;
      const s = window.getSelection();
      const scopeEl = scope.current;
      if (!s || s.isCollapsed || s.rangeCount === 0 || !scopeEl) { setSel(null); return; }
      const text = s.toString();
      if (!text.trim()) { setSel(null); return; }
      const node = s.anchorNode;
      if (!node) { setSel(null); return; }
      const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
      if (!el || !scopeEl.contains(el)) { setSel(null); return; }
      // Skip selections inside form fields / editables: they have native selection
      // behavior and their own copy/paste; the toolbar would only get in the way.
      if (el.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) {
        setSel(null);
        return;
      }
      const rect = s.getRangeAt(0).getBoundingClientRect();
      // Zero-size rect (e.g. collapsed caret in some browsers) → nothing to anchor to.
      if (rect.width === 0 && rect.height === 0) { setSel(null); return; }
      setSel({ x: rect.left + rect.width / 2, y: rect.top, text });
    };
    const onSelChange = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(compute);
    };
    document.addEventListener("selectionchange", onSelChange);
    return () => {
      document.removeEventListener("selectionchange", onSelChange);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [scope]);

  // Dismiss on any scroll (capture so nested scroll containers are covered) and Escape.
  useEffect(() => {
    if (!sel) return;
    const dismiss = () => setSel(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSel(null); };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [sel]);

  // Clamp the toolbar inside the viewport; flip below the selection when no room above.
  // Runs after commit so offsetWidth/Height are real. Initial inline style parks it
  // off-screen to avoid a flash at (0,0) before the first layout pass.
  useLayoutEffect(() => {
    const el = toolbarRef.current;
    if (!el || !sel) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const pad = 8;
    let left = sel.x - w / 2;
    let top = sel.y - h - 8; // sit 8px above the selection
    if (left < pad) left = pad;
    if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
    if (top < pad) top = sel.y + 24; // not enough room above → flip below
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [sel]);

  if (!sel) return null;

  const run = (a: SelectionAction) => {
    a.run(sel.text);
    // Clear the selection so selectionchange dismisses the toolbar. Done after the
    // action so the captured text is already consumed.
    window.getSelection()?.removeAllRanges();
  };

  return (
    <div
      ref={toolbarRef}
      className="selection-toolbar"
      style={{ position: "fixed", left: -9999, top: -9999 }}
      role="toolbar"
      aria-label={t("selectionToolbar.label")}
      data-testid="selection-toolbar"
    >
      {actions.map((a) => (
        <button
          key={a.key}
          type="button"
          className="selection-toolbar-btn"
          // Keep the text selection alive across the click (see component doc).
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run(a)}
          data-tooltip-id="md-tip"
          data-tooltip-content={t(a.tipKey)}
          aria-label={t(a.labelKey)}
          {...(a.testId ? { "data-testid": a.testId } : {})}
        >
          <a.Icon size={13} />
          <span>{t(a.labelKey)}</span>
        </button>
      ))}
    </div>
  );
}
