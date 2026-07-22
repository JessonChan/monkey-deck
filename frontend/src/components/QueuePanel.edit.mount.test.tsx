// Mount-test QueuePanel inline edit + scheduledAt (Task #22132).
//
// Pins two behaviors:
//  1. Clicking "edit" turns the item text into a textarea; Save writes the new text
//     back via onEdit (preserving the item in the queue); Cancel reverts.
//  2. Enter saves (no Shift), Esc cancels.
//  3. scheduledAt renders a queued-time label.

import { describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";

// ---- happy-dom setup ----
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

function item(id: string, text: string, scheduledAt: number): QueueItem {
  return { id, text, scheduledAt };
}

// Set an uncontrolled textarea's value via the native prototype setter (bypasses any
// value-tracker) so save() reads the edited text from the DOM ref.
function setValue(ta: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(ta, value);
}

describe("QueuePanel inline edit + scheduledAt (Task #22132)", () => {
  test("edit -> textarea -> save writes back via onEdit", async () => {
    const calls: Array<{ id: string; text: string }> = [];
    const q = [item("q1", "hello", Date.now())];
    const { host } = mount(
      <QueuePanel queue={q} onInterrupt={() => {}} onRevoke={() => {}} onEdit={(id, text) => calls.push({ id, text })} onSchedule={() => {}} />
    );
    await flush();

    // scheduledAt label present.
    expect(host.querySelector('[data-testid="queue-scheduled"]')).not.toBeNull();

    // Enter edit mode.
    const editBtn = host.querySelector('[data-testid="queue-edit"]') as HTMLElement;
    expect(editBtn).not.toBeNull();
    editBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    // Text input replaces text span.
    const ta = host.querySelector('[data-testid="queue-edit-input"]') as HTMLTextAreaElement;
    expect(ta).not.toBeNull();
    expect(ta.value).toBe("hello");

    // Type a new value and save via the Save button.
    setValue(ta, "hello edited");
    await flush();
    const saveBtn = host.querySelector('[data-testid="queue-edit-save"]') as HTMLElement;
    saveBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    expect(calls).toEqual([{ id: "q1", text: "hello edited" }]);
    // Edit mode exited after save.
    expect(host.querySelector('[data-testid="queue-edit-input"]')).toBeNull();
    expect(host.querySelector('[data-testid="queue-edit"]')).not.toBeNull();
  });

  test("cancel reverts without calling onEdit", async () => {
    const calls: string[] = [];
    const q = [item("q1", "hello", Date.now())];
    const { host } = mount(
      <QueuePanel queue={q} onInterrupt={() => {}} onRevoke={() => {}} onEdit={(id, text) => calls.push(`${id}:${text}`)} onSchedule={() => {}} />
    );
    await flush();

    (host.querySelector('[data-testid="queue-edit"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    const ta = host.querySelector('[data-testid="queue-edit-input"]') as HTMLTextAreaElement;
    setValue(ta, "discarded");
    await flush();

    (host.querySelector('[data-testid="queue-edit-cancel"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    expect(calls).toEqual([]);
    // Back to read mode (text span shows original, no edit input).
    expect(host.querySelector('[data-testid="queue-edit-input"]')).toBeNull();
    expect(host.querySelector(".queue-item-text")?.textContent).toBe("hello");
  });

  test("Enter saves, Esc cancels", async () => {
    const calls: string[] = [];
    const q = [item("q1", "hello", Date.now())];
    const { host } = mount(
      <QueuePanel queue={q} onInterrupt={() => {}} onRevoke={() => {}} onEdit={(id, text) => calls.push(`${id}:${text}`)} onSchedule={() => {}} />
    );
    await flush();

    (host.querySelector('[data-testid="queue-edit"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    const ta = host.querySelector('[data-testid="queue-edit-input"]') as HTMLTextAreaElement;
    setValue(ta, "via-enter");
    await flush();

    // Enter (no Shift) saves.
    ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: false, bubbles: true }));
    await flush();
    expect(calls).toEqual(["q1:via-enter"]);

    // Re-enter edit and verify Esc cancels without saving.
    (host.querySelector('[data-testid="queue-edit"]') as HTMLElement)
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    const ta2 = host.querySelector('[data-testid="queue-edit-input"]') as HTMLTextAreaElement;
    setValue(ta2, "via-esc");
    await flush();
    ta2.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(calls).toEqual(["q1:via-enter"]); // no new save
    expect(host.querySelector('[data-testid="queue-edit-input"]')).toBeNull();
  });
});
