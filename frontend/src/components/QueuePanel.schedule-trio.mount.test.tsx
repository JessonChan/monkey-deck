// Mount tests for the schedule-presets trio (issues #144/#145/#146, parent #27979).
//
// Pins:
//  1. Layout invariant (#144): the staged chip lives in its OWN row OUTSIDE
//     .queue-item-actions, and the explicit Reset is the LAST child of that
//     row — so consecutive preset clicks never move the preset buttons.
//     happy-dom has no layout engine (getBoundingClientRect is all zeros), so
//     the invariant is checked against a minimal fake flow model (installed
//     below, same recipe as Composer.autogrow.mount.test.tsx): x = flow
//     position among the actions row's children (fixed widths + 5px gap), y =
//     full-width rows rendered BEFORE the actions row. This catches exactly
//     the guarded regressions: anything appearing BEFORE the presets inside
//     the row (x shift) or a full-width staged row inserted above it (y shift).
//  2. +60 preset (#145): parameterized label (no "+1h" special case), stacks
//     like every tier (+5+10+30+60 ≈ 105min), and the untouched 24h cap still
//     rejects a +60 that would cross it (staged time frozen, cap notice, Save
//     gated).
//  3. Explicit Reset (#145/#146): icon button at the row end, shown only while
//     a future time is staged; reuses the chip ✕ handler (resetStagedTime) —
//     nothing commits, row stays open, chip/Reset/staged-row all drop, the
//     input snaps back to the default, presets re-base on now (baseline
//     seeding logic untouched).
//
// Follows the existing schedule-mount test pattern: happy-dom + native setter
// for uncontrolled inputs, MouseEvent clicks, fake i18n (t renders
// "key:opt=val" so label/notice assertions are exact).

import { describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";

const window = new Window();
const document = window.document;
globalThis.window = window;
globalThis.document = document;
globalThis.navigator = window.navigator;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.MouseEvent = window.MouseEvent;
globalThis.HTMLInputElement = window.HTMLInputElement;
window.React = React;

// ---- fake flow model (installed before mounts; see file header) ----
const FAKE_W: Record<string, number> = {
  "queue-schedule-preset-5": 46,
  "queue-schedule-preset-10": 52,
  "queue-schedule-preset-30": 56,
  "queue-schedule-preset-60": 56,
  "queue-schedule-cap": 88,
  "queue-schedule-save": 60,
  "queue-schedule-cancel": 60,
  "queue-schedule-clear": 46,
  "queue-schedule-reset": 28,
};
const GAP = 5;      // matches .queue-item-actions gap
const LINE_H = 32;  // one wrapped line of the edit row

// happy-dom's Element prototype gets the flow model in place of the default
// zero-rect stub — the DOM prototype's TS type offers no setter slot, hence
// the unchecked cast (named once, reason stated).
const elementProto = window.Element.prototype as unknown as {
  getBoundingClientRect: () => DOMRect;
};
elementProto.getBoundingClientRect = function (this: HTMLElement) {
  const row = this.closest?.(".queue-item-actions");
  const testid = this.getAttribute?.("data-testid") ?? "";
  if (row && FAKE_W[testid] !== undefined) {
    // x: flow position after the previous element siblings of the row.
    let x = 0;
    let sib = row.firstElementChild;
    while (sib && sib !== this) {
      x += (FAKE_W[sib.getAttribute?.("data-testid") ?? ""] ?? 40) + GAP;
      sib = sib.nextElementSibling;
    }
    // y: the actions row's line — full-width staged rows rendered BEFORE it
    // would push it down (the regression the invariant guards against).
    let y = 0;
    let prev = row.previousElementSibling;
    while (prev) {
      if (prev.classList.contains("queue-schedule-staged-row")) y += LINE_H + 6;
      prev = prev.previousElementSibling;
    }
    const w = FAKE_W[testid];
    return { x, y, width: w, height: LINE_H, top: y, left: x, right: x + w, bottom: y + LINE_H, toJSON() { return this; } } as DOMRect;
  }
  return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON() { return this; } } as DOMRect;
};

mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, opts?: Record<string, unknown>) => {
    if (opts && typeof opts === "object") {
      let s = k;
      for (const [kk, vv] of Object.entries(opts)) s += `:${kk}=${vv}`;
      return s;
    }
    return k;
  } }),
  initReactI18next: { type: "3rd-party" },
  default: { useTranslation: () => ({ t: (k: string) => k }) },
}));

// Dynamic import on purpose: the react-i18next mock above must be installed
// BEFORE the component module evaluates (same pattern as the other mount tests).
const QueuePanel = (await import("./QueuePanel.tsx")).default;
import type { QueueItem } from "../types";

function mount(jsx: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(jsx);
  return { host, root };
}

async function flush() {
  for (let i = 0; i < 10; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
}

function item(id: string, text: string, scheduledAt: number): QueueItem {
  return { id, text, scheduledAt };
}

function q(host: HTMLElement, testid: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testid}"]`);
}

async function click(host: HTMLElement, testid: string) {
  const el = q(host, testid);
  if (!el) throw new Error(`missing [data-testid="${testid}"]`);
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
  await flush();
}

// Preset button rects reduced to primitives (fake-model values) for equality.
function presetRects(host: HTMLElement): number[][] {
  return [5, 10, 30, 60].map((m) => {
    const el = q(host, `queue-schedule-preset-${m}`);
    if (!el) throw new Error(`missing preset-${m}`);
    const r = el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height];
  });
}

describe("QueuePanel schedule trio (#144/#145/#146)", () => {
  test("layout invariant: consecutive preset clicks never move the preset buttons (#144)", async () => {
    const { host } = mount(
      <QueuePanel queue={[item("q1", "hi", Date.now())]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}} />
    );
    await flush();
    await click(host, "queue-schedule");
    // First click stages a future time: the placeholder swaps to the live
    // readout, Reset activates (all resident since #182).
    await click(host, "queue-schedule-preset-5");
    const stagedRow = q(host, "queue-schedule-staged-row");
    expect(stagedRow).not.toBeNull();
    // The chip row lives OUTSIDE the actions row, BELOW it (never above).
    const actions = q(host, "queue-schedule-preset-5")!.closest(".queue-item-actions") as HTMLElement;
    expect(stagedRow!.closest(".queue-item-actions")).toBeNull();
    expect(actions.contains(stagedRow!)).toBe(false);
    expect(actions.nextElementSibling).toBe(stagedRow);
    // Reset is the actions row's LAST child — its later renders cannot shift
    // anything rendered before it.
    expect(actions.lastElementChild!.getAttribute("data-testid")).toBe("queue-schedule-reset");

    // The invariant itself: rects recorded after the first click stay constant
    // across further clicks (stacking) and across Reset.
    const base = presetRects(host);
    for (const id of ["queue-schedule-preset-10", "queue-schedule-preset-30", "queue-schedule-preset-60"]) {
      await click(host, id);
      expect(presetRects(host)).toEqual(base);
    }
    await click(host, "queue-schedule-reset"); // chip drops; slot row persists
    expect(presetRects(host)).toEqual(base);
    // #182: the slot row NEVER unmounts while the row is open — it flips back
    // to the placeholder (no live readout left behind).
    expect(q(host, "queue-schedule-staged-row")).not.toBeNull();
    expect(q(host, "queue-schedule-pending")).toBeNull();
    expect(q(host, "queue-schedule-pending-placeholder")).not.toBeNull();
  });

  test("+60 preset: parameterized label (no +1h special case), stacks to ~105min (#145)", async () => {
    const calls: number[] = [];
    const { host } = mount(
      <QueuePanel queue={[item("q1", "hi", Date.now())]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={(_id, at) => calls.push(at)} onReorder={() => {}} />
    );
    await flush();
    await click(host, "queue-schedule");

    // Parameterized i18n renders the same "+{{mins}}分" shape for 60 — no
    // hour special case.
    expect(q(host, "queue-schedule-preset-60")!.textContent).toBe("queue.schedulePreset:mins=60");

    const before = Date.now();
    for (const m of [5, 10, 30, 60]) await click(host, `queue-schedule-preset-${m}`);
    // Chip readout reflects the full stack.
    expect(q(host, "queue-schedule-pending")).not.toBeNull();
    await click(host, "queue-schedule-save");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThanOrEqual(before + 104 * 60_000);
    expect(calls[0]).toBeLessThanOrEqual(before + 106 * 60_000);
  });

  test("+60 over an already near-cap schedule is REJECTED — staged time frozen, cap notice (#145)", async () => {
    const seed = Date.now() + 24 * 60 * 60_000 - 5 * 60_000; // 23h55m out
    const calls: number[] = [];
    const { host } = mount(
      <QueuePanel queue={[item("q1", "later", seed)]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={(_id, at) => calls.push(at)} onReorder={() => {}} />
    );
    await flush();
    await click(host, "queue-schedule");
    // Seeded staging: chip reads ~1435m, no cap notice yet.
    expect(q(host, "queue-schedule-pending")!.textContent).toContain("mins=1435");
    expect(q(host, "queue-schedule-cap")).toBeNull();

    await click(host, "queue-schedule-preset-60"); // would land ~24h55m → reject
    expect(q(host, "queue-schedule-cap")).not.toBeNull();
    expect(q(host, "queue-schedule-pending")!.textContent).toContain("mins=1435"); // did not move

    // Save re-verifies as the final gate: the rejected +60 never leaked into
    // the staged value — the commit is the UNCHANGED seed (still under cap).
    await click(host, "queue-schedule-save");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThanOrEqual(seed - 60_000);
    expect(calls[0]).toBeLessThanOrEqual(seed);
    expect(q(host, "queue-schedule-input")).toBeNull();
  });
  test("explicit Reset clears staged back to baseline; hidden while nothing staged (#145/#146)", async () => {
    const calls: number[] = [];
    const { host } = mount(
      <QueuePanel queue={[item("q1", "hi", Date.now())]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={(_id, at) => calls.push(at)} onReorder={() => {}} />
    );
    await flush();
    await click(host, "queue-schedule");
    // Empty staging (#182 residency): Reset occupies its slot but is
    // visibility:hidden (out of hit-testing/a11y); the slot row shows the
    // placeholder; no live readout.
    expect(q(host, "queue-schedule-reset")).not.toBeNull();
    expect((q(host, "queue-schedule-reset") as HTMLElement).style.visibility).toBe("hidden");
    expect(q(host, "queue-schedule-staged-row")).not.toBeNull();
    expect(q(host, "queue-schedule-pending-placeholder")).not.toBeNull();
    expect(q(host, "queue-schedule-pending")).toBeNull();

    // +5 +10 → chip, staged row and Reset all show.
    await click(host, "queue-schedule-preset-5");
    await click(host, "queue-schedule-preset-10");
    expect(q(host, "queue-schedule-staged-row")).not.toBeNull();
    expect(q(host, "queue-schedule-pending")).not.toBeNull();
    expect(q(host, "queue-schedule-reset")).not.toBeNull();

    // Reset: same handler as the chip ✕ — nothing commits, row stays open,
    // staging fully drops, input snaps back to the default (~now+1m).
    const resetBefore = Date.now();
    await click(host, "queue-schedule-reset");
    const resetAfter = Date.now();
    expect(calls).toHaveLength(0);
    // #182 residency: the slot row persists (placeholder back), Reset returns
    // to its hidden empty-state slot.
    expect(q(host, "queue-schedule-staged-row")).not.toBeNull();
    expect(q(host, "queue-schedule-pending")).toBeNull();
    expect(q(host, "queue-schedule-pending-placeholder")).not.toBeNull();
    expect((q(host, "queue-schedule-reset") as HTMLElement).style.visibility).toBe("hidden");
    const input = q(host, "queue-schedule-input") as HTMLInputElement;
    const snapped = Date.parse(input.value);
    expect(Number.isNaN(snapped)).toBe(false);
    expect(snapped).toBeGreaterThanOrEqual(resetBefore);
    expect(snapped).toBeLessThanOrEqual(resetAfter + 60_000);

    // Presets re-base on now after the reset (baseline untouched by Reset):
    // +5 → Save commits ~reset-time + 5min, not ~+15min.
    const before = Date.now();
    await click(host, "queue-schedule-preset-5");
    await click(host, "queue-schedule-save");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThanOrEqual(before + 4 * 60_000);
    expect(calls[0]).toBeLessThanOrEqual(before + 6 * 60_000);
  });
});
