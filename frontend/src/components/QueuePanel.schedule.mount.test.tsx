// Mount-test QueuePanel schedule picker (Task #22134).
//
// Pins:
//  1. A future scheduledAt shows the "scheduled send" badge (clock) instead of the
//     plain "queued" label.
//  2. Clicking "schedule" opens a datetime-local input; Save calls onSchedule with the
//     picked epoch ms.
//  3. "Now" (clearSchedule) calls onSchedule with a due timestamp (<= now).
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
});
