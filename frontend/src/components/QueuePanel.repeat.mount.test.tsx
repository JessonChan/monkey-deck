// Mount-test QueuePanel recurring send (#111, Task #24333).
//
// Pins:
//  1. A repeatEveryMs>0 item shows the recurring badge (interval + "sent N×"
//     odometer) next to the #97 countdown badge — both coexist. No repeat →
//     no badge.
//  2. ✕ on the badge is the one-click cancel: onSetRepeat(id, 0) straight
//     from the plain row (schedule row not opened).
//  3. The schedule edit row carries the repeat tier select: preset tiers
//     (每5min/每30min/每1h) commit immediately with the epoch-ms value;
//     "不重复" commits 0.
//  4. An odd interval selects "custom" with the minutes seeded; Apply (and
//     Enter) commits mins*60_000 after the 1~1440 gate; out-of-range values
//     are rejected with the notice and no call.
//  5. Custom-tier REACHABILITY (#24335 P1 fix): picking 自定义 on a PLAIN
//     item (repeatEveryMs=0) must reveal the minutes input through the local
//     staging flag — nothing is committed yet, so the server mirror alone can
//     never flip the render condition. Row close drops the reveal; a preset
//     pick after custom hides the input and commits.
//
// Follows the schedule mount-test scaffold (happy-dom + native prototype
// setters; select commits via a bubbled "change", number input via "input" —
// React's synthetic listeners for those element types).

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

function item(id: string, over: Partial<QueueItem> = {}): QueueItem {
  return { id, text: "tick", scheduledAt: Date.now(), ...over };
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

function openScheduleRow(host: ReturnType<typeof mount>["host"]) {
  click(host, "queue-schedule");
}

describe("QueuePanel recurring send (#111)", () => {
  test("repeat item shows the badge (interval + sent count) beside the countdown; plain item shows none", async () => {
    const future = Date.now() + 5 * 60_000;
    const { host } = mount(
      <QueuePanel
        queue={[item("q1", { repeatEveryMs: 5 * 60_000, sentCount: 3, scheduledAt: future }), item("q2")]}
        onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}}
        onSetRepeat={() => {}}
      />
    );
    await flush();

    // Recurring + scheduled coexist: countdown badge AND repeat badge on q1.
    const badge = host.querySelector('[data-testid="queue-repeat-badge"]');
    expect(badge).not.toBeNull();
    expect(host.querySelector('[data-testid="queue-scheduled-send"]')).not.toBeNull();
    expect(badge!.textContent).toContain("queue.repeatEvery");
    expect(badge!.textContent).toContain("queue.repeatM:m=5"); // interval in human terms
    // Odometer only when sentCount > 0.
    const sent = host.querySelector('[data-testid="queue-repeat-sent"]');
    expect(sent).not.toBeNull();
    expect(sent!.textContent).toContain("3");

    // Plain item (q2): no badge, no odometer.
    const rows = host.querySelectorAll('[data-testid="queue-item"]');
    expect(rows[1].querySelector('[data-testid="queue-repeat-badge"]')).toBeNull();
  });

  test("zero sentCount hides the odometer until the first repeat send lands", async () => {
    const { host } = mount(
      <QueuePanel queue={[item("q1", { repeatEveryMs: 30 * 60_000 })]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}} onSetRepeat={() => {}} />
    );
    await flush();
    expect(host.querySelector('[data-testid="queue-repeat-badge"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="queue-repeat-sent"]')).toBeNull();
  });

  test("✕ on the badge cancels the recurrence without opening the schedule row", async () => {
    const calls: Array<{ id: string; ms: number }> = [];
    const { host } = mount(
      <QueuePanel queue={[item("q1", { repeatEveryMs: 60 * 60_000 })]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}}
        onSetRepeat={(id, ms) => calls.push({ id, ms })} />
    );
    await flush();

    click(host, "queue-repeat-cancel");
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ id: "q1", ms: 0 });
    // Schedule row was never opened (the commit came from the plain row).
    expect(host.querySelector('[data-testid="queue-schedule-row"]')).toBeNull();
  });

  test("schedule row tier: preset selects commit immediately with the epoch-ms value", async () => {
    const calls: Array<{ id: string; ms: number }> = [];
    const { host } = mount(
      <QueuePanel queue={[item("q1")]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}}
        onSetRepeat={(id, ms) => calls.push({ id, ms })} />
    );
    await flush();

    openScheduleRow(host);
    await flush();
    const select = host.querySelector('[data-testid="queue-repeat-select"]') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.value).toBe("0"); // plain item → 不重复

    // 每30分钟 → 1_800_000, committed immediately (no Save needed).
    setSelectValue(select, String(30 * 60_000));
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ id: "q1", ms: 30 * 60_000 });

    // Back to 不重复 → 0.
    setSelectValue(select, "0");
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ id: "q1", ms: 0 });
  });

  test("odd interval selects custom with minutes seeded; Apply and Enter both commit mins*60_000", async () => {
    const calls: number[] = [];
    const { host } = mount(
      <QueuePanel queue={[item("q1", { repeatEveryMs: 7 * 60_000 })]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}}
        onSetRepeat={(_id, ms) => calls.push(ms)} />
    );
    await flush();

    openScheduleRow(host);
    await flush();
    const select = host.querySelector('[data-testid="queue-repeat-select"]') as HTMLSelectElement;
    expect(select.value).toBe("custom");
    const input = host.querySelector('[data-testid="queue-repeat-custom"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("7"); // seeded from the odd interval

    // Uncontrolled input: prototype-set the DOM value (the happy-dom onChange
    // edge is why the component reads it at commit, like the datetime picker).
    setInputValue(input, "10");
    await flush();
    click(host, "queue-repeat-apply");
    await flush();
    expect(calls).toEqual([10 * 60_000]);

    // Enter commits too (IME-guarded path shares the plain key handling).
    setInputValue(input, "15");
    await flush();
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await flush();
    expect(calls).toEqual([10 * 60_000, 15 * 60_000]);
  });

  test("custom values outside 1~1440 are rejected with the notice and no commit", async () => {
    const calls: number[] = [];
    const { host } = mount(
      <QueuePanel queue={[item("q1", { repeatEveryMs: 90 * 60_000 })]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}}
        onSetRepeat={(_id, ms) => calls.push(ms)} />
    );
    await flush();

    openScheduleRow(host);
    await flush();
    const input = host.querySelector('[data-testid="queue-repeat-custom"]') as HTMLInputElement;

    for (const bad of ["0", "1441", "-5", "abc"]) {
      setInputValue(input, bad);
      await flush();
      click(host, "queue-repeat-apply");
      await flush();
    }
    expect(calls).toHaveLength(0);
    const err = host.querySelector('[data-testid="queue-repeat-error"]');
    expect(err).not.toBeNull();
    expect(err!.textContent).toContain("queue.repeatCustomInvalid");
  });

  test("tier select is disabled when no onSetRepeat is wired (legacy minimal props)", async () => {
    const { host } = mount(
      <QueuePanel queue={[item("q1")]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}} />
    );
    await flush();
    openScheduleRow(host);
    await flush();
    const select = host.querySelector('[data-testid="queue-repeat-select"]') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  // ─── custom-tier reachability (#24335 P1 fix) ────────────────────────────
  // The headline path the review proved dead: a PLAIN item (repeatEveryMs=0)
  // picks 自定义 — the minutes input must appear via the local reveal flag
  // (nothing committed yet, so the server mirror alone can never un-hide it),
  // then Apply commits an odd interval in minutes→ms.
  test("plain item → pick 自定义 → minutes input appears (nothing committed) → Apply commits odd minutes", async () => {
    const calls: Array<{ id: string; ms: number }> = [];
    const { host } = mount(
      <QueuePanel queue={[item("q1")]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}}
        onSetRepeat={(id, ms) => calls.push({ id, ms })} />
    );
    await flush();

    openScheduleRow(host);
    await flush();
    const select = host.querySelector('[data-testid="queue-repeat-select"]') as HTMLSelectElement;
    expect(select.value).toBe("0"); // plain item → 不重复
    // No minutes input before the tier is picked.
    expect(host.querySelector('[data-testid="queue-repeat-custom"]')).toBeNull();

    // Pick 自定义: input reveals, select DISPLAYS custom (local state, not the
    // still-zero mirror), and no commit has happened.
    setSelectValue(select, "custom");
    await flush();
    expect(select.value).toBe("custom");
    const input = host.querySelector('[data-testid="queue-repeat-custom"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe(""); // plain item → nothing to seed
    expect(calls).toHaveLength(0);

    // Odd minutes commit via Apply — the only production path to an odd interval.
    setInputValue(input, "7");
    await flush();
    click(host, "queue-repeat-apply");
    await flush();
    expect(calls).toEqual([{ id: "q1", ms: 7 * 60_000 }]);
  });

  test("closing the schedule row drops the custom reveal — reopen shows the mirror tier again", async () => {
    const calls: Array<{ id: string; ms: number }> = [];
    const { host } = mount(
      <QueuePanel queue={[item("q1")]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}}
        onSetRepeat={(id, ms) => calls.push({ id, ms })} />
    );
    await flush();

    openScheduleRow(host);
    await flush();
    const select = host.querySelector('[data-testid="queue-repeat-select"]') as HTMLSelectElement;
    setSelectValue(select, "custom");
    await flush();
    expect(host.querySelector('[data-testid="queue-repeat-custom"]')).not.toBeNull();

    // Cancel the row: the reveal must not leak into the next open (props never
    // changed — still a plain item, so the mirror tier is 不重复 again).
    click(host, "queue-schedule-cancel");
    await flush();
    expect(host.querySelector('[data-testid="queue-schedule-row"]')).toBeNull();
    openScheduleRow(host);
    await flush();
    const select2 = host.querySelector('[data-testid="queue-repeat-select"]') as HTMLSelectElement;
    expect(select2.value).toBe("0");
    expect(host.querySelector('[data-testid="queue-repeat-custom"]')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("picking a preset after custom hides the minutes input and commits the preset", async () => {
    const calls: Array<{ id: string; ms: number }> = [];
    const { host } = mount(
      <QueuePanel queue={[item("q1")]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}}
        onSetRepeat={(id, ms) => calls.push({ id, ms })} />
    );
    await flush();

    openScheduleRow(host);
    await flush();
    const select = host.querySelector('[data-testid="queue-repeat-select"]') as HTMLSelectElement;
    setSelectValue(select, "custom");
    await flush();
    expect(host.querySelector('[data-testid="queue-repeat-custom"]')).not.toBeNull();

    // Switch straight to a preset: reveal drops (input hides), preset commits.
    setSelectValue(select, String(5 * 60_000));
    await flush();
    expect(calls).toEqual([{ id: "q1", ms: 5 * 60_000 }]);
    expect(host.querySelector('[data-testid="queue-repeat-custom"]')).toBeNull();
  });
});
