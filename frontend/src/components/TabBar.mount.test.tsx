// Mount-test TabBar (#156 Chrome-style shrink) in the repo's idiom:
// happy-dom + react-dom createRoot, no @testing-library/react (not a dep).
//
// Invariants pinned here:
//  - Wide form (strip ≥ tabs.length × WIDE_MIN): title renders with its composite
//    tooltip; the tab root itself carries no tooltip (the title span owns it).
//  - Narrow form (strip < tabs.length × WIDE_MIN): title AND unread dot unmount,
//    the tab keeps status dot + close, takes the `narrow` class, and the tab root
//    carries a tooltip whose content is the RAW title (the title stays reachable).
//  - limitHintSeq bump shows the transient limit hint; it self-dismisses after
//    LIMIT_HINT_MS (real wall time — bun's fake timers gate the real macrotask
//    queue); re-showing requires a NEW bump (seq change), not a prop
//    re-render with the same value.

import { describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import TabBar, { TAB_LIMIT, LIMIT_HINT_MS, type TabBarTab } from "./TabBar";

// ---- happy-dom setup ----
const win = new Window();
const doc = win.document;
(globalThis as Record<string, unknown>).window = win;
(globalThis as Record<string, unknown>).document = doc;
(globalThis as Record<string, unknown>).navigator = win.navigator;
(globalThis as Record<string, unknown>).getComputedStyle = win.getComputedStyle.bind(win);
(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(performance.now()), 0);
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);
(globalThis as Record<string, unknown>).MouseEvent = win.MouseEvent;
win.React = React;

// Controllable ResizeObserver: tests drive the strip width explicitly (happy-dom
// has no layout engine, so real observation would never fire).
let roCb: ResizeObserverCallback | null = null;
let roInstance: ResizeObserver | null = null;
class StubResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    roCb = cb;
    roInstance = this as unknown as ResizeObserver;
  }
  observe(_el: Element) {}
  unobserve(_el: Element) {}
  disconnect() {}
}
(globalThis as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver;

// Fire the observer TabBar registered with a synthetic strip width. The partial
// entry is cast to the well-known DOM type with a one-line reason: happy-dom has
// no layout engine, so contentRect must be fabricated (component only reads
// contentRect.width).
function fireWidth(width: number) {
  const entry = { contentRect: { width } } as ResizeObserverEntry;
  roCb?.([entry], roInstance);
}

// react-i18next: TabBar calls useTranslation(); return keys verbatim.
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const delay = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  realSetTimeout(resolve, ms);
  return promise;
};
// React 19 + happy-dom needs several ticks to complete commit + passive effects.
async function flush() {
  for (let i = 0; i < 10; i++) await delay(2);
}

const makeTabs = (n: number): TabBarTab[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `T${i + 1}`,
    title: `Session ${i + 1}`,
    projectName: "demo",
    status: "idle" as const,
    activity: undefined,
    unread: i === 1, // T2 unread — must vanish in narrow form
  }));

function render(node: React.ReactNode): { container: HTMLElement; root: Root } {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container);
  root.render(node);
  return { container, root };
}

describe("TabBar (#156 Chrome-style shrink)", () => {
  test("wide → narrow → wide: title/unread unmount only in narrow, raw-title tooltip + × stay", async () => {
    const { container, root } = render(
      <TabBar tabs={makeTabs(2)} activeId="T1" onSelect={() => {}} onClose={() => {}} onPopout={() => {}} />,
    );
    await flush();
    // 2 tabs × WIDE_MIN(47) = 94 → 800 is wide.
    fireWidth(800);
    await flush();
    expect(container.querySelectorAll(".tabbar-tab-title")).toHaveLength(2);
    expect(container.querySelector(".tabbar-tab.narrow")).toBeNull();
    const t1 = container.querySelector('[data-testid="tab-T1"]')!;
    expect(t1.getAttribute("data-tooltip-content")).toBeNull(); // wide: root has no tooltip
    expect(container.querySelector('[data-testid="tab-unread-T2"]')).not.toBeNull();

    // 90 < 94 → narrow: titles + unread unmount, dot/close/class/tooltip remain.
    fireWidth(90);
    await flush();
    expect(container.querySelectorAll(".tabbar-tab-title")).toHaveLength(0);
    expect(container.querySelectorAll(".tabbar-tab.narrow")).toHaveLength(2);
    expect(t1.getAttribute("data-tooltip-content")).toBe("Session 1"); // raw title, reachable
    expect(container.querySelector('[data-testid="tab-close-T1"]')).not.toBeNull();
    expect(container.querySelector(".session-dot")).not.toBeNull();
    expect(container.querySelector('[data-testid="tab-unread-T2"]')).toBeNull();

    // Back to wide: everything restored.
    fireWidth(800);
    await flush();
    expect(container.querySelectorAll(".tabbar-tab-title")).toHaveLength(2);
    expect(t1.getAttribute("data-tooltip-content")).toBeNull();

    root.unmount();
  });

  test("limit hint: shows on seq bump, self-dismisses after LIMIT_HINT_MS, needs new bump to re-show", async () => {
    const { container, root } = render(
      <TabBar tabs={makeTabs(1)} activeId="T1" onSelect={() => {}} onClose={() => {}} onPopout={() => {}} limitHintSeq={0} />,
    );
    await flush();
    const hint = () => container.querySelector('[data-testid="tabbar-limit-hint"]');
    expect(hint()).toBeNull();

    root.render(
      <TabBar tabs={makeTabs(1)} activeId="T1" onSelect={() => {}} onClose={() => {}} onPopout={() => {}} limitHintSeq={1} />,
    );
    await flush();
    expect(hint()).not.toBeNull();
    expect(hint()!.textContent).toBe("tabbar.limitTip");

    // LIMIT_HINT_MS later the hint is gone (component-owned real timer; asserted against
    // actual wall time — awaiting a real setTimeout while bun fake timers are active hangs).
    await delay(LIMIT_HINT_MS + 100);
    expect(hint()).toBeNull();

    // Same seq re-render must NOT re-show (bump-driven, not render-driven).
    root.render(
      <TabBar tabs={makeTabs(1)} activeId="T1" onSelect={() => {}} onClose={() => {}} onPopout={() => {}} limitHintSeq={1} />,
    );
    await flush();
    expect(hint()).toBeNull();

    // A new bump re-shows it.
    root.render(
      <TabBar tabs={makeTabs(1)} activeId="T1" onSelect={() => {}} onClose={() => {}} onPopout={() => {}} limitHintSeq={2} />,
    );
    await flush();
    expect(hint()).not.toBeNull();

    root.unmount();
  });

  test("TAB_LIMIT is the pinned 50-tab cap constant", () => {
    expect(TAB_LIMIT).toBe(50);
  });
});
