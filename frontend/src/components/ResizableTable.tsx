// Resizable markdown tables (#140): drag a grip on a header cell's right edge
// to size that column; double-click the grip to restore auto sizing. Saved
// widths live in a module-level, session-scoped map keyed by the table's
// header signature — they survive streaming re-renders and virtualization
// remounts but die with the app (in-session memory per issue #140; nothing
// touches localStorage/SQLite).
//
// Mobile is disabled at three independent layers:
//   1. coarse-pointer devices never render the grip at all (`coarsePointer`);
//   2. a touch contact never starts a drag (pointerType guard below), which
//      covers hybrids whose primary pointer is fine but reach touchscreen;
//   3. the M2 media block (@media max-width 768px) hides `.md-col-grip` in
//      index.css — narrow viewports scroll tables horizontally instead (#139),
//      and CSS hides grips even where JS flags disagree with reality.
//
// Renderer components are module-level and consume the session id through
// context, keeping their identities stable across renders — required by the
// streaming remount invariant (Task #21289): a new component identity per
// chunk would tear down every live message's DOM while the agent writes.

import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
} from "react";
import type {
  ComponentPropsWithoutRef,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { mdSourceProps, type MdComponentProps } from "../lib/markdownSource";

// Floor for any dragged width (px): a column dragged far left stays wide
// enough to remain readable instead of collapsing into a vertical sliver.
const MIN_COL_W = 48;

// Cap on remembered tables across all sessions. Bounds memory for a long-lived
// desktop process; eviction drops the least-recently-written entry (writes
// refresh insertion order). Counting individual TABLES, not sessions — one
// busy answer can hold dozens of tables, so this is the bound that matters.
const MAX_TABLES = 256;

const widthsByTable = new Map<string, number[]>();

function storeKey(sessionId: string, tableKey: string): string {
  return sessionId + "\u0000" + tableKey;
}

function rememberWidths(key: string, widths: number[]): void {
  widthsByTable.delete(key); // refresh insertion order (LRU-lite)
  widthsByTable.set(key, widths);
  while (widthsByTable.size > MAX_TABLES) {
    const oldest = widthsByTable.keys().next();
    if (oldest.done) break;
    widthsByTable.delete(oldest.value);
  }
}

// Write-through with empty-map hygiene: a table whose every column was reset
// back to auto removes its entry instead of hoarding all-zero noise.
function persistWidths(key: string, widths: readonly number[]): void {
  if (widths.some((w) => w > 0)) rememberWidths(key, [...widths]);
  else widthsByTable.delete(key);
}

// Stable table identity: trimmed header labels + column arity. Streaming grows
// and regenerates rows freely, but a table's HEADER pins its semantics — any
// content change to the header yields a fresh key, so stale widths can never
// bleed into a reshaped table (invariant: merge by stable protocol key).
function tableKeyOf(table: HTMLTableElement): string | null {
  // rows[0] is the header row: remark-gfm always emits <thead> before
  // <tbody>, so the first row carries the th cells everywhere we render.
  // (tHead.rows itself is dodgy across engines — happy-dom omits it.)
  const cells = table.rows[0]?.cells;
  if (!cells || cells.length === 0) return null;
  let sig = "";
  for (const cell of cells) sig += (cell.textContent ?? "").trim() + "\u0001";
  return cells.length + "|" + sig.slice(0, 400);
}

// Stamp saved px widths onto every cell of every width-controlled column.
// Indexes come straight from row.cells, so header and body stay aligned by
// construction — one <table> is one column grid regardless of layout algorithm
// (the #139 invariant).
function applyWidths(table: HTMLTableElement, widths: readonly number[]): void {
  for (const row of table.rows) {
    const limit = Math.min(row.cells.length, widths.length);
    for (let i = 0; i < limit; i++) {
      if (widths[i] > 0) row.cells[i].style.width = widths[i] + "px";
    }
  }
}

// Live per-move update: only the dragged column's cells restyle, keeping
// pointermove O(rows-of-one-column) even for multi-hundred-row answers.
function stampColumn(table: HTMLTableElement, col: number, px: number): void {
  for (const row of table.rows) {
    const cell = row.cells[col];
    if (cell) cell.style.width = px + "px";
  }
}

function clearColumn(table: HTMLTableElement, col: number): void {
  for (const row of table.rows) row.cells[col]?.style.removeProperty("width");
}

// Drag baseline: live geometry first (truth after layout), then an existing
// inline width, then the minimum. Engines without layout (happy-dom, offline
// hidden trees) report 0px rects, which lands on the deterministic fallbacks.
function measureCell(cell: HTMLElement): number {
  const rect = cell.getBoundingClientRect().width;
  if (Number.isFinite(rect) && rect > 0) return Math.round(rect);
  const inline = parseFloat(cell.style.width);
  return Number.isFinite(inline) && inline > 0 ? Math.round(inline) : MIN_COL_W;
}

// Touch-primary device → the resizer is dead weight: no hover cursor, a
// thumbnail hit target under a thumb, and ≤768px layouts scroll tables
// horizontally rather than letting users sculpture columns. Evaluated once at
// module load — a desktop window never becomes touch mid-session (same
// rationale and precedent as Composer's coarsePointer gate).
const coarsePointer =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches;

// Carries the owning chat session id from AgentMarkdown down to every table
// rendered inside one message. Default "" gives anonymous in-app-lifetime
// storage — harmless bucket, never persisted.
export const TableSessionContext = createContext("");

// Markdown-table renderer: the same `.md-table-wrap` skeleton as #136 plus
// resize plumbing. The effect intentionally has NO dependency array:
// react-markdown rebuilds its entire element tree on every streaming chunk,
// and this re-run stamps saved widths onto whatever cells the latest commit
// produced. DOM nodes react reuses keep the inline styles anyway; recreated
// ones get them back before paint — either way drags stay visible.
export function ResizableTable(props: ComponentPropsWithoutRef<"table"> & MdComponentProps) {
  const { node, ...rest } = props;
  const sessionId = useContext(TableSessionContext);
  const tableRef = useRef<HTMLTableElement>(null);

  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    const tableKey = tableKeyOf(table);
    if (!tableKey) return;
    const widths = widthsByTable.get(storeKey(sessionId, tableKey));
    if (widths) applyWidths(table, widths);
  });

  return (
    // #177: source-span anchors sit on the component's actual DOM root; the
    // hast node position covers the raw pipe-table source (issue #177).
    <div className="md-table-wrap" {...mdSourceProps(node)}>
      <table ref={tableRef} {...rest} />
    </div>
  );
}

// Header-cell renderer: unchanged <th> semantics plus the drag grip. On
// coarse-pointer devices the grip is not even mounted (mobile-disable layer 1);
// hooks run unconditionally before that early return, per React rules.
export function HeadCell(props: ComponentPropsWithoutRef<"th"> & MdComponentProps) {
  const { node, ...rest } = props;
  const { t } = useTranslation();
  const sessionId = useContext(TableSessionContext);
  const hint = t("chat.colResizeTip");

  // Mobile-disable layer 1: on touch-primary devices the grip never mounts.
  if (coarsePointer) return <th {...rest} {...mdSourceProps(node)} />;

  const beginResize = (e: ReactPointerEvent<HTMLSpanElement>) => {
    // Layer 2: a touch contact never drags, even where layer 1 under-counted
    // a hybrid device (fine trackpad + finger reach-in).
    if (e.pointerType === "touch") return;
    const grip = e.currentTarget;
    const th = grip.parentElement as HTMLTableCellElement | null;
    const col = th?.cellIndex;
    if (!th || typeof col !== "number" || col < 0) return;
    const table = th.closest("table"); // tag selector ⇒ element IS the table
    if (!table) return;
    const tableKey = tableKeyOf(table);
    if (!tableKey) return;

    e.preventDefault(); // don't start a text selection from the edge strip
    e.stopPropagation();

    const key = storeKey(sessionId, tableKey);
    const widths = Array.from(widthsByTable.get(key) ?? []);
    while (widths.length <= col) widths.push(0);

    const startX = e.clientX;
    const startW = measureCell(th);
    grip.classList.add("md-col-resizing");
    try {
      grip.setPointerCapture(e.pointerId); // keep moves flowing outside the strip
    } catch {
      // Capture can legitimately fail on an already-released pointer; window
      // listeners below still receive the drag.
    }

    const move = (ev: PointerEvent) => {
      const px = Math.max(MIN_COL_W, Math.round(startW + (ev.clientX - startX)));
      widths[col] = px;
      stampColumn(table, col, px);
    };
    const end = () => {
      grip.classList.remove("md-col-resizing");
      try {
        grip.releasePointerCapture(e.pointerId);
      } catch {
        // Already released (pointercancel path or teardown) — nothing to undo.
      }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      // pointercancel settles on whatever the DOM already shows: reverting the
      // inline widths would fight a half-finished OS gesture for nothing.
      persistWidths(key, widths);
      applyWidths(table, widths);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const resetColumn = (e: ReactMouseEvent<HTMLSpanElement>) => {
    const th = e.currentTarget.parentElement as HTMLTableCellElement | null;
    const col = th?.cellIndex;
    if (!th || typeof col !== "number" || col < 0) return;
    const table = th.closest("table"); // tag selector ⇒ element IS the table
    if (!table) return;
    const tableKey = tableKeyOf(table);
    if (!tableKey) return;

    e.preventDefault(); // suppress the double-click word selection
    e.stopPropagation();

    const key = storeKey(sessionId, tableKey);
    const widths = Array.from(widthsByTable.get(key) ?? []);
    if (col >= widths.length || widths[col] === 0) return; // nothing saved there
    widths[col] = 0;
    clearColumn(table, col);
    persistWidths(key, widths);
    applyWidths(table, widths); // siblings stay pinned to their saved widths
  };

  return (
    <th {...rest} {...mdSourceProps(node)}>
      {props.children}
      <span
        className="md-col-grip"
        role="presentation"
        onPointerDown={beginResize}
        onDoubleClick={resetColumn}
        data-testid="md-col-grip"
        data-tooltip-id="md-tip"
        data-tooltip-content={hint}
        aria-label={hint}
      />
    </th>
  );
}
