// Mount tests for the resident staged slot (#182).
//
// Pins:
//  1. Residency: opening the schedule row ALWAYS shows the staged slot row —
//     with nothing staged it holds an equal-height placeholder span
//     (queue.schedulePendingEmpty copy, .placeholder) instead of the live
//     readout; Save still collapses the whole edit row, so non-editing queue
//     items never gain height.
//  2. Zero-jump (#144 invariant extension): the FIRST preset click swaps
//     placeholder → readout in place — the slot's getBoundingClientRect height
//     stays constant across open / stacking / Reset. happy-dom has no layout
//     engine, so heights come from a minimal fake flow model (same recipe as
//     QueuePanel.schedule-trio.mount.test.tsx): both states share the
//     .queue-schedule-pending class, so the model returns one constant height
//     for the slot — the assertion catches an unmounting/re-adding row
//     (rect collapses to zero) or a class-shape change, the exact guarded
//     regressions.
//  3. Reset residency: the explicit Reset occupies its slot at the actions
//     row end even when nothing is staged — visibility:hidden there (out of
//     hit-testing/a11y, width reserved so presets cannot shift), visible and
//     functional (clears staged, commits nothing) once a time is staged.
//
// Same harness as the schedule-mount tests: happy-dom + native setter for
// uncontrolled inputs, MouseEvent clicks, fake i18n (t renders "key:opt=val"
// so copy assertions are exact).

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
const SLOT_H = 22; // .queue-schedule-staged-row: constant in both states
const SPAN_H = 16; // .queue-schedule-pending (chip OR placeholder, shared class)

const elementProto = window.Element.prototype as unknown as {
  getBoundingClientRect: () => DOMRect;
};
elementProto.getBoundingClientRect = function (this: HTMLElement) {
  const h = this.classList.contains("queue-schedule-staged-row") ? SLOT_H
    : this.classList.contains("queue-schedule-pending") ? SPAN_H
    : 0;
  return { x: 0, y: 0, width: h > 0 ? 120 : 0, height: h, top: 0, left: 0, right: h > 0 ? 120 : 0, bottom: h, toJSON() { return this; } } as DOMRect;
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
// BEFORE the component module evaluates (static import cannot express that
// ordering — same pattern as the other mount tests).
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

function slotHeight(host: HTMLElement): number {
  const slot = q(host, "queue-schedule-staged-row");
  if (!slot) throw new Error("missing staged slot row");
  return slot.getBoundingClientRect().height;
}

// Rect height of whichever span currently holds the slot (chip or placeholder).
function spanHeight(host: HTMLElement): number {
  const span = q(host, "queue-schedule-pending") ?? q(host, "queue-schedule-pending-placeholder");
  if (!span) throw new Error("missing staged span (chip or placeholder)");
  return span.getBoundingClientRect().height;
}

describe("QueuePanel resident staged slot (#182)", () => {
  test("opening the row shows the placeholder slot; Save collapses the row as before", async () => {
    const calls: number[] = [];
    const { host } = mount(
      <QueuePanel queue={[item("q1", "hi", Date.now())]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={(_id, at) => calls.push(at)} onReorder={() => {}} />
    );
    await flush();
    await click(host, "queue-schedule");

    // Placeholder state: slot row resident, faint hint copy, NO live readout.
    expect(q(host, "queue-schedule-staged-row")).not.toBeNull();
    const ph = q(host, "queue-schedule-pending-placeholder");
    expect(ph).not.toBeNull();
    expect(ph!.textContent).toBe("queue.schedulePendingEmpty");
    expect(ph!.classList.contains("placeholder")).toBe(true);
    expect(q(host, "queue-schedule-pending")).toBeNull();
    // Display-only placeholder: no ✕ reset inside it.
    expect(q(host, "queue-schedule-pending-reset")).toBeNull();

    // Save commits and the WHOLE edit row collapses (residency is scoped to
    // the open row — non-editing items never gain height).
    await click(host, "queue-schedule-preset-5");
    await click(host, "queue-schedule-save");
    expect(calls).toHaveLength(1);
    expect(q(host, "queue-schedule-row")).toBeNull();
    expect(q(host, "queue-schedule-staged-row")).toBeNull();
    expect(q(host, "queue-schedule-pending-placeholder")).toBeNull();
  });

  test("placeholder present only on the editing row — other items stay compact", async () => {
    const { host } = mount(
      <QueuePanel queue={[item("q1", "a", Date.now()), item("q2", "b", Date.now())]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}} />
    );
    await flush();
    await click(host, "queue-schedule");
    // Exactly one resident slot: the open schedule row's.
    expect(host.querySelectorAll('[data-testid="queue-schedule-staged-row"]')).toHaveLength(1);
  });

  test("first preset click swaps to the readout in place — slot height constant (#144 extension)", async () => {
    const { host } = mount(
      <QueuePanel queue={[item("q1", "hi", Date.now())]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}} />
    );
    await flush();
    await click(host, "queue-schedule");

    const slotBefore = slotHeight(host);
    const spanBefore = spanHeight(host);
    expect(spanBefore).toBeGreaterThan(0); // placeholder occupies real (modeled) height

    // FIRST click: placeholder → readout, zero height change anywhere.
    await click(host, "queue-schedule-preset-5");
    expect(q(host, "queue-schedule-pending-placeholder")).toBeNull();
    const chip = q(host, "queue-schedule-pending");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("queue.schedulePending:mins=5");
    expect(slotHeight(host)).toBe(slotBefore);
    expect(spanHeight(host)).toBe(spanBefore);

    // Stacking + Reset keep the same constant geometry.
    await click(host, "queue-schedule-preset-10");
    expect(slotHeight(host)).toBe(slotBefore);
    expect(spanHeight(host)).toBe(spanBefore);
    await click(host, "queue-schedule-reset");
    expect(q(host, "queue-schedule-pending")).toBeNull();
    expect(q(host, "queue-schedule-pending-placeholder")).not.toBeNull();
    expect(slotHeight(host)).toBe(slotBefore);
    expect(spanHeight(host)).toBe(spanBefore);
  });

  test("Reset is hidden (unclickable) while empty, visible and functional once staged", async () => {
    const calls: number[] = [];
    const { host } = mount(
      <QueuePanel queue={[item("q1", "hi", Date.now())]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={(_id, at) => calls.push(at)} onReorder={() => {}} />
    );
    await flush();
    await click(host, "queue-schedule");

    // Empty staging: Reset present in the slot but visibility:hidden — no hit
    // testing, no a11y exposure, width still reserved (#144 no-shift).
    const reset = q(host, "queue-schedule-reset");
    expect(reset).not.toBeNull();
    expect(reset!.style.visibility).toBe("hidden");

    // Staging activates it.
    await click(host, "queue-schedule-preset-30");
    expect(q(host, "queue-schedule-reset")!.style.visibility).toBe("");

    // Click clears the staged time: nothing commits, row stays open,
    // placeholder returns, Reset hides again.
    await click(host, "queue-schedule-reset");
    expect(calls).toHaveLength(0);
    expect(q(host, "queue-schedule-input")).not.toBeNull();
    expect(q(host, "queue-schedule-pending")).toBeNull();
    expect(q(host, "queue-schedule-pending-placeholder")).not.toBeNull();
    expect(q(host, "queue-schedule-reset")!.style.visibility).toBe("hidden");
  });
});
