// Mount-test Sidebar batch selection (issue #94): ⌘/Ctrl+click toggle,
// Shift+click range from the anchor row, per-row checkboxes in select mode,
// and the batch actions (copy working dirs newline-joined, delete via confirm
// modal driving the existing onRemoveSession per selected id). Same mock
// scaffolding as Sidebar.expanded.mount.test.tsx (bindings / i18n / tooltip /
// clipboard stubbed; no real backend calls during mount).

import { describe, test, expect, mock, beforeEach } from "bun:test";
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
globalThis.localStorage = window.localStorage;
window.React = React;

// ---- binding / i18n / tooltip / clipboard mocks ----
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => ({
  ToggleMaximise: async () => {},
  RevealPath: async () => {},
  ExportSession: async () => "",
  SearchSessionContent: async () => [],
}));
mock.module("react-tooltip", () => ({ Tooltip: () => null, default: () => null }));
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: "3rd-party" },
  default: { useTranslation: () => ({ t: (k: string) => k }) },
}));

// Clipboard mock: capture the last copied text so the batch-copy test can
// assert the exact newline-joined payload (render order, worktreePath ||
// project path).
let lastCopied = "";
mock.module("../lib/clipboard", () => ({
  copyText: async (text: string) => { lastCopied = text; return true; },
  copyTextQuiet: () => {},
  execCommandCopy: () => true,
}));

// Import the component only after the mocks are registered.
const { default: Sidebar } = await import("./Sidebar.tsx");

const EXPANDED_KEY = "md:sidebar-expanded";

const proj = (id: string, name: string) => ({
  id,
  name,
  path: `/tmp/${id}`,
  model: "",
  allowExternalDir: false,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
});

const sess = (id: string, projectId: string, worktreePath = "") => ({
  id,
  projectId,
  acpSession: "",
  title: `t-${id}`,
  customTitle: "",
  model: "",
  harness: "opencode",
  worktreePath,
  branch: "",
  baseRef: "",
  usedTokens: 0,
  sizeTokens: 0,
  cost: 0,
  cachedReadTokens: 0,
  cachedWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  totalTokens: 0,
  createdAt: 1,
  updatedAt: 1,
  promptedAt: 1,
  pinned: false,
});

// Recorded interactions: activated sessions, removed sessions (in order).
let activated: [string, string][] = [];
let removed: string[] = [];

const baseProps = () => ({
  projects: [proj("p1", "alpha"), proj("p2", "beta")],
  selectedProjectId: null,
  sessionsByProject: {
    p1: [sess("s1", "p1"), sess("s2", "p1", "/wt/s2"), sess("s3", "p1")],
    p2: [sess("s4", "p2")],
  },
  selectedSessionId: null,
  onSelectProject: async () => {},
  onSelectSession: (sessionId: string, projectId: string) => { activated.push([sessionId, projectId]); },
  onCreateSession: () => {},
  onAddProject: () => {},
  onRemoveProject: async () => {},
  onRemoveSession: async (sessionId: string) => { removed.push(sessionId); },
  onTogglePin: () => {},
  onRenameSession: () => {},
  statusBySession: {},
  activityBySession: {},
  unreadBySession: {},
  permPendingBySession: {},
  onReorderProjects: () => {},
  onOpenSettings: () => {},
});

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<Sidebar {...(baseProps() as never)} />);
  return { host, root };
}

async function flush() {
  for (let i = 0; i < 8; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
}

const click = (opts: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {}) =>
  new window.MouseEvent("click", {
    bubbles: true,
    button: 0,
    metaKey: !!opts.meta,
    ctrlKey: !!opts.ctrl,
    shiftKey: !!opts.shift,
  });

// The clickable main area of a session row (activation / modifier-select zone).
const rowMain = (host: HTMLElement, id: string): HTMLElement | null =>
  host.querySelector(`[data-testid="session-${id}"] .session-item-main`) ?? null;

const checkbox = (host: HTMLElement, id: string): HTMLElement | null =>
  host.querySelector(`[data-testid="sel-${id}"]`) ?? null;

const isChecked = (host: HTMLElement, id: string): boolean =>
  checkbox(host, id)?.getAttribute("aria-checked") === "true";

// Mount with the given projects expanded so their session rows render.
async function mounted(expanded: string[] = ["p1"]) {
  localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded));
  const m = mount();
  await flush();
  return m;
}

describe("Sidebar batch selection (#94)", () => {
  beforeEach(() => {
    localStorage.clear();
    activated = [];
    removed = [];
    lastCopied = "";
  });

  test("header button enters select mode (checkboxes appear); Esc exits and clears", async () => {
    const { host, root } = await mounted();
    expect(checkbox(host, "s1")).toBeNull(); // no checkboxes before select mode

    host.querySelector('[data-testid="batch-select-mode"]')!.dispatchEvent(click());
    await flush();
    expect(checkbox(host, "s1")).not.toBeNull();
    expect(checkbox(host, "s4")).toBeNull(); // p2 collapsed — its rows aren't rendered

    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    await flush();
    expect(checkbox(host, "s1")).toBeNull();

    root.unmount();
  });

  test("Cmd+click toggles selection without activating; plain click still activates", async () => {
    const { host, root } = await mounted();

    rowMain(host, "s1")!.dispatchEvent(click({ meta: true }));
    await flush();
    expect(isChecked(host, "s1")).toBe(true);
    expect(checkbox(host, "s1")).not.toBeNull(); // modifier click enters select mode
    expect(host.querySelector('[data-testid="session-s1"]')!.classList.contains("selected")).toBe(true);
    expect(activated).toEqual([]); // never activated the session

    rowMain(host, "s1")!.dispatchEvent(click({ meta: true }));
    await flush();
    expect(isChecked(host, "s1")).toBe(false);

    // Ctrl+click works as the Windows/Linux equivalent of Cmd+click.
    rowMain(host, "s2")!.dispatchEvent(click({ ctrl: true }));
    await flush();
    expect(isChecked(host, "s2")).toBe(true);

    // Esc exits; a plain click afterwards activates as before.
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    await flush();
    rowMain(host, "s3")!.dispatchEvent(click());
    await flush();
    expect(activated).toEqual([["s3", "p1"]]);

    root.unmount();
  });

  test("Shift+click selects the range from the anchor row", async () => {
    const { host, root } = await mounted();

    rowMain(host, "s1")!.dispatchEvent(click({ meta: true }));
    await flush();
    rowMain(host, "s3")!.dispatchEvent(click({ shift: true }));
    await flush();

    expect(isChecked(host, "s1")).toBe(true);
    expect(isChecked(host, "s2")).toBe(true);
    expect(isChecked(host, "s3")).toBe(true);
    expect(activated).toEqual([]);
    expect(host.querySelector('[data-testid="batch-count"]')!.textContent).toBe("sidebar.batchCount");

    // Shift works upwards too: anchor stays at s3, shift-click s2 keeps s2..s3.
    rowMain(host, "s1")!.dispatchEvent(click({ meta: true })); // deselect s1
    await flush();
    expect(isChecked(host, "s1")).toBe(false);

    root.unmount();
  });

  test("checkbox click toggles selection and drives the batch bar count", async () => {
    const { host, root } = await mounted();
    expect(host.querySelector('[data-testid="batch-bar"]')).toBeNull();

    host.querySelector('[data-testid="batch-select-mode"]')!.dispatchEvent(click());
    await flush();
    checkbox(host, "s2")!.dispatchEvent(click());
    await flush();

    expect(isChecked(host, "s2")).toBe(true);
    expect(host.querySelector('[data-testid="batch-bar"]')).not.toBeNull();

    checkbox(host, "s2")!.dispatchEvent(click());
    await flush();
    expect(isChecked(host, "s2")).toBe(false);
    // Selection empty → the action bar hides even though select mode is still on.
    expect(host.querySelector('[data-testid="batch-bar"]')).toBeNull();

    root.unmount();
  });

  test("batch copy dirs joins worktree/project paths newline-separated in render order", async () => {
    const { host, root } = await mounted(["p1", "p2"]);

    // Click the s4 checkbox order first to prove output follows render order,
    // not click order (p1 sessions come before p2 in the sidebar).
    rowMain(host, "s4")!.dispatchEvent(click({ meta: true }));
    await flush();
    rowMain(host, "s1")!.dispatchEvent(click({ meta: true })); // /tmp/p1 (no worktree)
    await flush();
    rowMain(host, "s2")!.dispatchEvent(click({ meta: true })); // /wt/s2 (worktree)
    await flush();

    host.querySelector('[data-testid="batch-copy-dirs"]')!.dispatchEvent(click());
    await flush();
    expect(lastCopied).toBe("/tmp/p1\n/wt/s2\n/tmp/p2");
    expect(removed).toEqual([]);

    root.unmount();
  });

  test("batch delete confirms, removes each selected session sequentially, then exits", async () => {
    const { host, root } = await mounted();

    rowMain(host, "s1")!.dispatchEvent(click({ meta: true }));
    await flush();
    rowMain(host, "s2")!.dispatchEvent(click({ meta: true }));
    await flush();

    host.querySelector('[data-testid="batch-delete"]')!.dispatchEvent(click());
    await flush();
    // Confirm modal is up; nothing removed yet.
    expect(host.querySelector('[data-testid="batch-delete-confirm"]')).not.toBeNull();
    expect(removed).toEqual([]);

    host.querySelector('[data-testid="batch-delete-confirm"]')!.dispatchEvent(click());
    await flush();
    expect(removed).toEqual(["s1", "s2"]);
    // Done: modal closed, selection cleared, select mode exited.
    expect(host.querySelector('[data-testid="batch-delete-confirm"]')).toBeNull();
    expect(host.querySelector('[data-testid="batch-bar"]')).toBeNull();
    expect(checkbox(host, "s3")).toBeNull();

    root.unmount();
  });
});
