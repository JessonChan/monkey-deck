// Mount-test QueuePanel drag-and-drop reorder (Task #22135).
//
// Pins:
//  1. dragstart on a grip sets dragId; dragover on another row highlights it (drag-over class).
//  2. drop on a target row calls onReorder(activeId, overId).
//  3. Dropping on the same item is a no-op (onReorder not called).
//
// happy-dom lacks a full DragEvent; our handlers only need native event dispatch + state,
// so we synthesize "dragstart"/"dragover"/"drop" via window.Event. dataTransfer access is
// guarded by try/catch in the component, so an event without it is safe.

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

function item(id: string, text: string): QueueItem {
  return { id, text, scheduledAt: Date.now() };
}

function fire(node: Element, type: string) {
  node.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
}

describe("QueuePanel drag-reorder (Task #22135)", () => {
  test("dragstart -> dragover highlights target -> drop calls onReorder(activeId, overId)", async () => {
    const calls: Array<{ activeId: string; overId: string }> = [];
    const { host } = mount(
      <QueuePanel
        queue={[item("q1", "one"), item("q2", "two"), item("q3", "three")]}
        onInterrupt={() => {}}
        onRevoke={() => {}}
        onEdit={() => {}}
        onSchedule={() => {}}
        onReorder={(activeId, overId) => calls.push({ activeId, overId })}
      />
    );
    await flush();

    const grips = host.querySelectorAll('[data-testid="queue-grip"]');
    expect(grips.length).toBe(3);
    const rows = host.querySelectorAll('[data-testid="queue-item"]');
    expect(rows.length).toBe(3);

    // Begin dragging q2 (grip at index 1).
    fire(grips[1], "dragstart");
    await flush();

    // Hover q3 (row index 2) → highlighted as drop target.
    fire(rows[2], "dragover");
    await flush();
    expect(rows[2].className).toContain("drag-over");
    expect(rows[0].className).not.toContain("drag-over");

    // Drop on q3 → onReorder(q2, q3).
    fire(rows[2], "drop");
    await flush();

    expect(calls).toEqual([{ activeId: "q2", overId: "q3" }]);
    // Drop clears the highlight.
    expect(rows[2].className).not.toContain("drag-over");
  });

  test("dropping onto the same item is a no-op", async () => {
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

    const grips = host.querySelectorAll('[data-testid="queue-grip"]');
    const rows = host.querySelectorAll('[data-testid="queue-item"]');

    fire(grips[0], "dragstart");
    await flush();
    fire(rows[0], "dragover");
    await flush();
    fire(rows[0], "drop");
    await flush();

    expect(calls).toEqual([]);
  });
});
