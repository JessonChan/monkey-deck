// Mount-test QueuePanel repeat Send-Now (#192).
//
// Pins the #192 fix: Save with a picked repeat tier and an untouched datetime
// takes the repeat path — first send immediate (onSchedule ≈ submit time), no
// stale-expiry false block. The seeded default is minute-truncated, so the
// repro freezes the clock 1s before a minute boundary: the default sits only
// ~1s ahead and ANY dwell makes it stale — the exact false-block shape
// (open row → pick repeat → dwell → Save used to trip queue.scheduleExpired).
//
// Scenarios (spec-mandated):
//  1. repeat-only bypass: open row → pick 每5min → dwell ≥2s (clock bumped) →
//     Save → no scheduleError, onSchedule(≈now), onSetRepeat got the tier.
//     Also pins the repeat-only UX: datetime control disabled + min dropped.
//  2. pure-schedule control (typed past time) → still blocked (unchanged).
//  3. combination control (typed past + repeat picked) → still blocked; the
//     control stays editable (an explicit edit keeps full validation in force).
//  4. 24h cap control (typed over-cap) → cap notice, no commit (unchanged).
//
// Harness notes (probed empirically): React's onChange synthesis is
// unreachable for datetime-local in happy-dom (single AND warm-up input
// dispatch — documented env edge in the schedule mount test), while onInput
// fires; the component's dirty flag hangs off onInput for exactly this
// reason. The select commits via a bubbled "change" event (known-good #111
// chain). Date.now is frozen per file so dwell/drift is deterministic: T0 is
// 1s before a minute boundary, making the seeded default exactly T0+1s.

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
globalThis.HTMLSelectElement = window.HTMLSelectElement;
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

// mock.module must land before the component import — the module-loading
// boundary this test file intentionally exercises.
const QueuePanel = (await import("./QueuePanel.tsx")).default;
import type { QueueItem } from "../types";

// ─── frozen clock (#192 repro rig) ──────────────────────────────────────────
const MIN = 60_000;
// T0 = 1s before a minute boundary: defaultLocalInput() truncates to minutes,
// so the seeded default sits exactly T0+1s ahead — any dwell makes it stale.
const T0 = Math.ceil(Date.now() / MIN) * MIN - 1000;
let fakeNow = T0;
Date.now = () => fakeNow;

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

function item(id: string): QueueItem {
  return { id, text: "tick", scheduledAt: fakeNow };
}

function click(host: ReturnType<typeof mount>["host"], testid: string) {
  (host.querySelector(`[data-testid="${testid}"]`) as HTMLElement)
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
}

function setSelectValue(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
// Epoch ms → "YYYY-MM-DDTHH:mm" local (datetime-local value format).
function fmt(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Callbacks {
  scheduleCalls: Array<{ id: string; at: number }>;
  repeatCalls: Array<{ id: string; ms: number }>;
}

function mountPanel(): ReturnType<typeof mount> & Callbacks {
  const scheduleCalls: Array<{ id: string; at: number }> = [];
  const repeatCalls: Array<{ id: string; ms: number }> = [];
  const { host, root } = mount(
    <QueuePanel
      queue={[item("q1")]}
      onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}}
      onSchedule={(id, at) => scheduleCalls.push({ id, at })}
      onReorder={() => {}}
      onSetRepeat={(id, ms) => repeatCalls.push({ id, ms })}
    />
  );
  return { host, root, scheduleCalls, repeatCalls };
}

async function openScheduleRow(host: ReturnType<typeof mount>["host"]) {
  click(host, "queue-schedule");
  await flush();
}

function scheduleInput(host: ReturnType<typeof mount>["host"]): HTMLInputElement {
  return host.querySelector('[data-testid="queue-schedule-input"]') as HTMLInputElement;
}

describe("QueuePanel repeat Send-Now (#192)", () => {
  test("repeat-only: tier picked + untouched datetime → Save sends now, no stale block", async () => {
    const { host, scheduleCalls, repeatCalls } = mountPanel();
    await flush();
    await openScheduleRow(host);

    // Baseline: editable with the min floor present.
    const input = scheduleInput(host);
    expect(input.disabled).toBe(false);
    expect(input.getAttribute("min")).not.toBeNull();

    // Pick 每5分钟 — commits immediately per #111.
    const sel = host.querySelector('[data-testid="queue-repeat-select"]') as HTMLSelectElement;
    setSelectValue(sel, "300000");
    await flush();
    expect(repeatCalls).toContainEqual({ id: "q1", ms: 300000 });

    // Repeat-only UX: the datetime control is disabled and its min floor is
    // dropped with it (a repeat needs no time pick).
    expect(input.disabled).toBe(true);
    expect(input.getAttribute("min")).toBeNull();

    // Dwell ≥2s → the seeded default (T0+1s) goes stale. Pre-fix this exact
    // shape tripped the stale re-check and blocked the commit.
    fakeNow = T0 + 3000;

    click(host, "queue-schedule-save");
    await flush();

    // No stale-expiry block; first send ≈ the submit moment; the tier reached
    // onSetRepeat (re-asserted at commit, idempotent).
    expect(host.querySelector('[data-testid="queue-schedule-error"]')).toBeNull();
    expect(scheduleCalls).toEqual([{ id: "q1", at: T0 + 3000 }]);
    expect(repeatCalls[repeatCalls.length - 1]).toEqual({ id: "q1", ms: 300000 });
    // Row closed.
    expect(host.querySelector('[data-testid="queue-schedule-row"]')).toBeNull();
  });

  test("pure schedule control: typed past time is still blocked (unchanged)", async () => {
    const { host, scheduleCalls, repeatCalls } = mountPanel();
    await flush();
    await openScheduleRow(host);

    // Type a past moment explicitly (pure mode — no repeat involved).
    setInputValue(scheduleInput(host), fmt(fakeNow - 5 * MIN));
    await flush();

    click(host, "queue-schedule-save");
    await flush();

    // Still intercepted: expiry notice, no commit, row stays open.
    expect(scheduleCalls).toHaveLength(0);
    expect(repeatCalls).toHaveLength(0);
    expect(host.querySelector('[data-testid="queue-schedule-error"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="queue-schedule-row"]')).not.toBeNull();
  });

  test("combination control: typed past + repeat picked is still blocked; control stays editable", async () => {
    const { host, scheduleCalls, repeatCalls } = mountPanel();
    await flush();
    await openScheduleRow(host);

    const input = scheduleInput(host);
    // Explicit edit FIRST (marks the value dirty), then the repeat pick.
    setInputValue(input, fmt(fakeNow - 5 * MIN));
    await flush();
    const sel = host.querySelector('[data-testid="queue-repeat-select"]') as HTMLSelectElement;
    setSelectValue(sel, "300000");
    await flush();
    expect(repeatCalls).toContainEqual({ id: "q1", ms: 300000 });

    // Combination keeps the control editable and validated (no disable).
    expect(input.disabled).toBe(false);
    expect(input.getAttribute("min")).not.toBeNull();

    click(host, "queue-schedule-save");
    await flush();

    // Expiry re-check still applies in the combined state (before the cap
    // gate, per the preserved guard order): blocked with the expiry notice.
    expect(scheduleCalls).toHaveLength(0);
    expect(host.querySelector('[data-testid="queue-schedule-error"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="queue-schedule-cap"]')).toBeNull();
    expect(host.querySelector('[data-testid="queue-schedule-row"]')).not.toBeNull();
  });

  test("24h cap control: typed over-cap time is still gated at Save (unchanged)", async () => {
    const { host, scheduleCalls, repeatCalls } = mountPanel();
    await flush();
    await openScheduleRow(host);

    // Type 3 days ahead — beyond the 24h cap.
    setInputValue(scheduleInput(host), fmt(fakeNow + 3 * 24 * 60 * MIN));
    await flush();

    click(host, "queue-schedule-save");
    await flush();

    // Cap notice (not the expiry error), no commit, row stays open.
    expect(scheduleCalls).toHaveLength(0);
    expect(repeatCalls).toHaveLength(0);
    expect(host.querySelector('[data-testid="queue-schedule-cap"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="queue-schedule-error"]')).toBeNull();
    expect(host.querySelector('[data-testid="queue-schedule-row"]')).not.toBeNull();
  });
});
