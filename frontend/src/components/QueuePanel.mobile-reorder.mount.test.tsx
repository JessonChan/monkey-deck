// Mount-test QueuePanel mobile up/down move buttons (Task #24284 / issue #126B).
//
// Pins:
//  1. Every read-state row renders a queue-move-up / queue-move-down button.
//  2. Clicking move-up calls onReorder(item.id, prev.id) — the adjacent swap
//     rides the same splice-based reorder the drag grip uses; no new props.
//  3. Clicking move-down on the last usable index calls onReorder(item.id, next.id).
//  4. Edge buttons are disabled (first row's up, last row's down) and do not
//     fire onReorder when clicked.
//
// (Visibility is CSS-gated per breakpoint and thus not assertible in happy-dom;
// these tests pin the wiring, which is the component's whole job here.)

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
window.React = React;

mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
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

function item(id: string, text: string): QueueItem {
  return { id, text, scheduledAt: Date.now() };
}

function click(node: Element) {
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
}

describe("QueuePanel mobile move buttons (issue #126B)", () => {
  test("move-up / move-down reuse onReorder with the adjacent item as target", async () => {
    const calls: string[] = [];
    const { host } = mount(
      <QueuePanel
        queue={[item("q1", "one"), item("q2", "two"), item("q3", "three")]}
        onInterrupt={() => {}}
        onRevoke={() => {}}
        onEdit={() => {}}
        onSchedule={() => {}}
        onReorder={(a, b) => calls.push(`${a}->${b}`)}
      />
    );
    await flush();

    const ups = host.querySelectorAll('[data-testid="queue-move-up"]');
    const downs = host.querySelectorAll('[data-testid="queue-move-down"]');
    expect(ups.length).toBe(3);
    expect(downs.length).toBe(3);

    // Move q2 up → onReorder(q2, q1).
    click(ups[1]);
    await flush();
    // Move q2 down → onReorder(q2, q3).
    click(downs[1]);
    await flush();

    expect(calls).toEqual(["q2->q1", "q2->q3"]);
  });

  test("edge buttons are disabled and never fire onReorder", async () => {
    const calls: string[] = [];
    const { host } = mount(
      <QueuePanel
        queue={[item("q1", "one"), item("q2", "two")]}
        onInterrupt={() => {}}
        onRevoke={() => {}}
        onEdit={() => {}}
        onSchedule={() => {}}
        onReorder={(a, b) => calls.push(`${a}->${b}`)}
      />
    );
    await flush();

    const ups = host.querySelectorAll('[data-testid="queue-move-up"]');
    const downs = host.querySelectorAll('[data-testid="queue-move-down"]');

    expect((ups[0] as HTMLButtonElement).disabled).toBe(true);
    expect((downs[1] as HTMLButtonElement).disabled).toBe(true);
    expect((ups[1] as HTMLButtonElement).disabled).toBe(false);
    expect((downs[0] as HTMLButtonElement).disabled).toBe(false);

    // Clicking a disabled button must not reorder (happy-dom still dispatches
    // the event; React skips onClick for disabled <button>).
    click(ups[0]);
    click(downs[1]);
    await flush();

    expect(calls).toEqual([]);
  });

  test("single-item queue disables both move buttons", async () => {
    const { host } = mount(
      <QueuePanel
        queue={[item("q1", "only")]}
        onInterrupt={() => {}}
        onRevoke={() => {}}
        onEdit={() => {}}
        onSchedule={() => {}}
        onReorder={() => {}}
      />
    );
    await flush();

    const up = host.querySelector('[data-testid="queue-move-up"]') as HTMLButtonElement;
    const down = host.querySelector('[data-testid="queue-move-down"]') as HTMLButtonElement;
    expect(up.disabled).toBe(true);
    expect(down.disabled).toBe(true);
  });
});
