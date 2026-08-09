// Mount-test QueuePanel live countdown for scheduled items (Task #24245 / issue #97).
//
// Pins:
//  1. A future scheduledAt renders the countdown span (data-testid="queue-countdown")
//     alongside the scheduled-send badge.
//  2. A due (past) item renders no countdown span.
//
// Follows the existing schedule-mount test setup: happy-dom + mocked react-i18next
// (the mock echoes the key + interpolation opts so we assert on testid presence, not copy).

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

describe("QueuePanel live countdown (Task #24245)", () => {
  test("future scheduledAt renders the countdown span inside the scheduled-send badge", async () => {
    const future = Date.now() + 5 * 60_000;
    const { host } = mount(
      <QueuePanel queue={[item("q1", "later", future)]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}} />
    );
    await flush();

    // The scheduled-send (future) badge is present.
    expect(host.querySelector('[data-testid="queue-scheduled-send"]')).not.toBeNull();
    // The live countdown span is present alongside it.
    const countdown = host.querySelector('[data-testid="queue-countdown"]');
    expect(countdown).not.toBeNull();
    // The mocked t echoes keys + interpolation opts; assert the countdown helper ran by
    // checking one of its unit keys is reflected in the text.
    expect(countdown!.textContent ?? "").toMatch(/countdown/);
  });

  test("due (past) item shows no countdown span", async () => {
    const past = Date.now() - 60_000;
    const { host } = mount(
      <QueuePanel queue={[item("q1", "ready", past)]} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}} />
    );
    await flush();

    // No future badge and no countdown for a due item.
    expect(host.querySelector('[data-testid="queue-scheduled-send"]')).toBeNull();
    expect(host.querySelector('[data-testid="queue-countdown"]')).toBeNull();
  });
});
