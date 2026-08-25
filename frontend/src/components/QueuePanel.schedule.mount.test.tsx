// Mount-test QueuePanel schedule picker (Task #22134).
//
// Pins:
//  1. A future scheduledAt shows the "scheduled send" badge (clock) instead of
//     the plain "queued" label.
//  2. Clicking "schedule" opens a datetime-local input; Save calls onSchedule
//     with the picked epoch ms.
//  3. "Now" (clearSchedule) calls onSchedule with a due timestamp (<= now).
//  4. Accumulative presets (issue #130): clicks stack on the staged time
//     (base = max(staged, now)), the row stays open with a staged chip, Save
//     commits, and stacking on a seeded pending schedule adds on top.
//     Over-cap clicks/picks (> now+24h) are REJECTED (issue #130 wrap-up):
//     the staged time does not move, a cap notice shows, and Save re-verifies
//     the cap as the final gate. Cancelling fully drops the staged time.
//
// Follows the existing edit-mount test pattern: happy-dom + non-controlled input set via
// the native prototype setter (React 19 + happy-dom onChange edge, see
// 2026-07-23-queue-inline-edit-scheduledat.md).

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
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.HTMLInputElement = window.HTMLInputElement;
window.React = React;

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
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
}

function item(id: string, text: string, scheduledAt: number): QueueItem {
  return { id, text, scheduledAt };
}

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
}

describe("QueuePanel schedule picker (Task #22134)", () => {
  test("future scheduledAt shows the scheduled-send badge, not the queued label", async () => {
    const future = Date.now() + 60_000;
    const { host } = mount(
      <QueuePanel queue={[item("q1", "later", future)]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}} />
    );
    await flush();

    expect(host.querySelector('[data-testid="queue-scheduled-send"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="queue-scheduled"]')).toBeNull();
  });

  test("schedule -> datetime-local -> save calls onSchedule with epoch ms", async () => {
    const calls: Array<{ id: string; scheduledAt: number }> = [];
    const { host } = mount(
      <QueuePanel queue={[item("q1", "hi", Date.now())]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={(id, scheduledAt) => calls.push({ id, scheduledAt })} onReorder={() => {}} />
    );
    await flush();

    (host.querySelector('[data-testid="queue-schedule"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    const input = host.querySelector('[data-testid="queue-schedule-input"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    // Pick a time ~2 minutes ahead: "YYYY-MM-DDTHH:mm".
    const target = new Date(Date.now() + 120_000);
    const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
    const v = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T${pad(target.getHours())}:${pad(target.getMinutes())}`;
    setInputValue(input, v);
    await flush();

    (host.querySelector('[data-testid="queue-schedule-save"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("q1");
    expect(calls[0].scheduledAt).toBeGreaterThan(Date.now());
    expect(host.querySelector('[data-testid="queue-schedule-input"]')).toBeNull();
  });

  test("clearSchedule (Now) calls onSchedule with a due timestamp", async () => {
    const calls: number[] = [];
    const future = Date.now() + 5 * 60_000;
    const { host } = mount(
      <QueuePanel queue={[item("q1", "later", future)]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={(_id, scheduledAt) => calls.push(scheduledAt)} onReorder={() => {}} />
    );
    await flush();

    // Future item -> clear button present in schedule row.
    (host.querySelector('[data-testid="queue-schedule"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    const before = Date.now();
    (host.querySelector('[data-testid="queue-schedule-clear"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeLessThanOrEqual(Date.now());
    expect(calls[0]).toBeGreaterThanOrEqual(before);
  });

  test("datetime-local input has min >= now (Task #22386)", async () => {
    const before = Date.now();
    const { host } = mount(
      <QueuePanel queue={[item("q1", "hi", Date.now())]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}} />
    );
    await flush();
    const after = Date.now();

    (host.querySelector('[data-testid="queue-schedule"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    const input = host.querySelector('[data-testid="queue-schedule-input"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    // min attribute must be set and reflect ~now. datetime-local truncates to the minute
    // (drops seconds/ms), so the min epoch may be up to 1 minute below the render-time epoch.
    const min = input.getAttribute("min");
    expect(min).not.toBeNull();
    const minTs = Date.parse(min!);
    expect(Number.isNaN(minTs)).toBe(false);
    expect(minTs).toBeGreaterThanOrEqual(before - 60_000);
    expect(minTs).toBeLessThanOrEqual(after);
  });

  test("submitting a past time is intercepted with expiry error, onSchedule not called (Task #22386)", async () => {
    const calls: Array<{ id: string; scheduledAt: number }> = [];
    const { host } = mount(
      <QueuePanel queue={[item("q1", "hi", Date.now())]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={(id, scheduledAt) => calls.push({ id, scheduledAt })} onReorder={() => {}} />
    );
    await flush();

    (host.querySelector('[data-testid="queue-schedule"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    const input = host.querySelector('[data-testid="queue-schedule-input"]') as HTMLInputElement;
    // Pick a time 5 minutes in the past.
    const target = new Date(Date.now() - 5 * 60_000);
    const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
    const v = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T${pad(target.getHours())}:${pad(target.getMinutes())}`;
    setInputValue(input, v);
    await flush();

    (host.querySelector('[data-testid="queue-schedule-save"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    // Intercepted: no onSchedule call, error shown, schedule row stays open.
    expect(calls).toHaveLength(0);
    expect(host.querySelector('[data-testid="queue-schedule-error"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="queue-schedule-input"]')).not.toBeNull();
  });

  test("preset clicks stack on the staged time; row stays open; Save commits the total (issue #130)", async () => {
    const calls: Array<{ id: string; scheduledAt: number }> = [];
    const { host } = mount(
      <QueuePanel queue={[item("q1", "hi", Date.now())]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={(id, scheduledAt) => calls.push({ id, scheduledAt })} onReorder={() => {}} />
    );
    await flush();

    (host.querySelector('[data-testid="queue-schedule"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    // +5 then +10 then +30 → staged at (first-click time) + 45min. Each click
    // stacks on the staged value (base = max(staged, now)), NOT on now alone.
    const before = Date.now();
    for (const mins of [5, 10, 30] as const) {
      (host.querySelector(`[data-testid="queue-schedule-preset-${mins}"]`) as HTMLElement)
        .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
      await flush();
    }
    const after = Date.now();

    // Presets only STAGE — nothing committed yet, and the row stays open with
    // the staged-time chip visible (issue #130).
    expect(calls).toHaveLength(0);
    expect(host.querySelector('[data-testid="queue-schedule-input"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="queue-schedule-pending"]')).not.toBeNull();

    (host.querySelector('[data-testid="queue-schedule-save"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("q1");
    // datetime-local truncates to the minute, so the committed epoch may be up
    // to 1 minute below the staged (first-click + 45min) anchor.
    expect(calls[0].scheduledAt).toBeGreaterThanOrEqual(before + 45 * 60_000 - 60_000);
    expect(calls[0].scheduledAt).toBeLessThanOrEqual(after + 45 * 60_000);
    // Row closed after Save commits.
    expect(host.querySelector('[data-testid="queue-schedule-input"]')).toBeNull();
  });

  test("opening the schedule row on a pending item seeds the staged chip; presets stack on the seed (issue #130)", async () => {
    const future = Date.now() + 10 * 60_000;
    const calls: number[] = [];
    const { host } = mount(
      <QueuePanel queue={[item("q1", "later", future)]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={(_id, scheduledAt) => calls.push(scheduledAt)} onReorder={() => {}} />
    );
    await flush();

    (host.querySelector('[data-testid="queue-schedule"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    // Seeded from the item's existing schedule → chip visible immediately, no cap.
    expect(host.querySelector('[data-testid="queue-schedule-pending"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="queue-schedule-cap"]')).toBeNull();

    // +5 stacks ON TOP of the seeded time → ~15min out (not 5min from now).
    (host.querySelector('[data-testid="queue-schedule-preset-5"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    (host.querySelector('[data-testid="queue-schedule-save"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    expect(calls).toHaveLength(1);
    // seed (10min out) + 5min, minus up to 1min datetime-local truncation.
    expect(calls[0]).toBeGreaterThanOrEqual(future + 5 * 60_000 - 60_000);
    expect(calls[0]).toBeLessThanOrEqual(future + 5 * 60_000);
  });

  test("preset stacking beyond now+24h is REJECTED — staged time unchanged, cap notice (issue #130)", async () => {
    // Seed 23h55m out; +30min would exceed 24h → rejected (NOT clamped: the
    // staged time must not move, and a clamp could also jump an over-cap base
    // backward — see the legacy-seed test below).
    const seed = Date.now() + 24 * 60 * 60_000 - 5 * 60_000;
    const calls: number[] = [];
    const { host } = mount(
      <QueuePanel queue={[item("q1", "later", seed)]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={(_id, scheduledAt) => calls.push(scheduledAt)} onReorder={() => {}} />
    );
    await flush();

    (host.querySelector('[data-testid="queue-schedule"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    (host.querySelector('[data-testid="queue-schedule-preset-30"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    expect(host.querySelector('[data-testid="queue-schedule-cap"]')).not.toBeNull();

    // Clicking again keeps being rejected — the staged time never moves.
    (host.querySelector('[data-testid="queue-schedule-preset-30"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    expect(host.querySelector('[data-testid="queue-schedule-cap"]')).not.toBeNull();

    (host.querySelector('[data-testid="queue-schedule-save"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    expect(calls).toHaveLength(1);
    // Rejected = nothing was added: Save commits (a truncation-rounded) seed,
    // strictly below seed+30min — an uncapped stack or a clamp to now+24h
    // would both land higher.
    expect(calls[0]).toBeGreaterThanOrEqual(seed - 60_000);
    expect(calls[0]).toBeLessThanOrEqual(seed);
    expect(calls[0]).toBeLessThan(seed + 30 * 60_000);
    // Row closed after Save commits.
    expect(host.querySelector('[data-testid="queue-schedule-input"]')).toBeNull();
  });

  test("preset on a staged time already beyond the cap does not jump backward; Save is gated (issue #130)", async () => {
    // Legacy schedule 3 days out (created before the cap) seeds the staged
    // time beyond now+24h. A preset click must be REJECTED — the old clamp
    // behaviour would have pulled the staged time BACK to now+24h (~48h
    // earlier). Reject never writes pendingAt nor the input, so this is
    // pinned via the visible outcomes: cap notice, no commit of an over-cap
    // value, row stays open.
    const seed = Date.now() + 3 * 24 * 60 * 60_000;
    const calls: number[] = [];
    const { host } = mount(
      <QueuePanel queue={[item("q1", "later", seed)]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={(_id, scheduledAt) => calls.push(scheduledAt)} onReorder={() => {}} />
    );
    await flush();

    (host.querySelector('[data-testid="queue-schedule"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    // Seeded beyond the cap: chip visible, no cap notice yet (nothing rejected).
    expect(host.querySelector('[data-testid="queue-schedule-pending"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="queue-schedule-cap"]')).toBeNull();

    (host.querySelector('[data-testid="queue-schedule-preset-5"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    expect(host.querySelector('[data-testid="queue-schedule-cap"]')).not.toBeNull();

    // The over-cap DOM value (still the 3-days-out seed) must not commit —
    // the Save-time 24h gate intercepts with the cap notice, row stays open.
    (host.querySelector('[data-testid="queue-schedule-save"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    expect(calls).toHaveLength(0);
    expect(host.querySelector('[data-testid="queue-schedule-cap"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="queue-schedule-input"]')).not.toBeNull();
  });

  test("typing a time beyond now+24h is intercepted at Save with the cap notice (issue #130)", async () => {
    // happy-dom cannot fire React onChange for datetime-local (documented
    // edge in the file header), so the onChange rejection is best-effort
    // here — this pins the Save-time final gate instead, mirroring how the
    // past-time interception is covered via its Save-time re-check.
    const calls: number[] = [];
    const { host } = mount(
      <QueuePanel queue={[item("q1", "hi", Date.now())]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={(_id, scheduledAt) => calls.push(scheduledAt)} onReorder={() => {}} />
    );
    await flush();

    (host.querySelector('[data-testid="queue-schedule"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    const input = host.querySelector('[data-testid="queue-schedule-input"]') as HTMLInputElement;
    // Type a time 3 days ahead — beyond the 24h cap.
    const target = new Date(Date.now() + 3 * 24 * 60 * 60_000);
    const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
    const v = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T${pad(target.getHours())}:${pad(target.getMinutes())}`;
    setInputValue(input, v);
    await flush();

    (host.querySelector('[data-testid="queue-schedule-save"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    // Intercepted with the CAP notice (not the expiry error), no commit, row open.
    expect(calls).toHaveLength(0);
    expect(host.querySelector('[data-testid="queue-schedule-cap"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="queue-schedule-error"]')).toBeNull();
    expect(host.querySelector('[data-testid="queue-schedule-input"]')).not.toBeNull();
  });

  test("datetime-local input has max ≈ now+24h (issue #130)", async () => {
    const before = Date.now();
    const { host } = mount(
      <QueuePanel queue={[item("q1", "hi", Date.now())]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}} />
    );
    await flush();

    (host.querySelector('[data-testid="queue-schedule"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    const after = Date.now();

    const input = host.querySelector('[data-testid="queue-schedule-input"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    // max attribute must be set and reflect ~now+24h (datetime-local truncates
    // to the minute, hence the 1-minute tolerance, mirroring the min test).
    const max = input.getAttribute("max");
    expect(max).not.toBeNull();
    const maxTs = Date.parse(max!);
    expect(Number.isNaN(maxTs)).toBe(false);
    expect(maxTs).toBeGreaterThanOrEqual(before + 24 * 60 * 60_000 - 60_000);
    expect(maxTs).toBeLessThanOrEqual(after + 24 * 60 * 60_000);
  });

  test("cancel drops the staged time — reopening starts fresh, presets re-base on now (issue #130)", async () => {
    const calls: number[] = [];
    const { host } = mount(
      <QueuePanel queue={[item("q1", "hi", Date.now())]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={(_id, scheduledAt) => calls.push(scheduledAt)} onReorder={() => {}} />
    );
    await flush();

    // Open → +5 (stage ~5m out) → cancel: staged state must be fully dropped.
    (host.querySelector('[data-testid="queue-schedule"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    (host.querySelector('[data-testid="queue-schedule-preset-5"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    expect(host.querySelector('[data-testid="queue-schedule-pending"]')).not.toBeNull();
    (host.querySelector('[data-testid="queue-schedule-cancel"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    // Reopen: no chip (staging did not survive the cancel), no cap notice.
    (host.querySelector('[data-testid="queue-schedule"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    expect(host.querySelector('[data-testid="queue-schedule-pending"]')).toBeNull();
    expect(host.querySelector('[data-testid="queue-schedule-cap"]')).toBeNull();

    // +5 re-bases on now (a leaked ~5m staging would double it to ~10m).
    const before = Date.now();
    (host.querySelector('[data-testid="queue-schedule-preset-5"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    (host.querySelector('[data-testid="queue-schedule-save"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThanOrEqual(before + 5 * 60_000 - 60_000);
    expect(calls[0]).toBeLessThanOrEqual(before + 5 * 60_000 + 60_000);
  });
});
