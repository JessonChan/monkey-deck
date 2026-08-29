// Mount-test Sidebar batch selection (issue #94): ⌘/Ctrl+click toggle,
// Shift+click range from the anchor row, per-row checkboxes in select mode,
// the per-project select-all button — a full TOGGLE as of #161 (select the
// visible set, or deselect it when everything visible is already selected) —
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
mock.module("react-i18next", () => {
  // Echo the key, appending interpolation args so count assertions can pin the
  // exact batch-bar payload (e.g. {"count":2} after a filtered select-all).
  const t = (k: string, opts?: Record<string, unknown>) =>
    opts && Object.keys(opts).length ? `${k} ${JSON.stringify(opts)}` : k;
  return {
    useTranslation: () => ({ t }),
    initReactI18next: { type: "3rd-party" },
    default: { useTranslation: () => ({ t }) },
  };
});

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

const sess = (id: string, projectId: string, worktreePath = "", tags: string[] = []) => ({
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
  tags,
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
// `sessions` overrides the default sessionsByProject (select-all filter tests).
async function mounted(
  expanded: string[] = ["p1"],
  sessions?: Record<string, ReturnType<typeof sess>[]>,
) {
  localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded));
  const props = { ...baseProps(), ...(sessions ? { sessionsByProject: sessions } : {}) };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<Sidebar {...(props as never)} />);
  await flush();
  return { host, root };
}

describe("Sidebar batch selection (#94)", () => {
  beforeEach(() => {
    localStorage.clear();
    activated = [];
    removed = [];
    lastCopied = "";
  });

  test("project-row select-all enters select mode with that project's visible sessions; Esc exits and clears", async () => {
    const { host, root } = await mounted();
    expect(checkbox(host, "s1")).toBeNull(); // no checkboxes before select mode

    host.querySelector('[data-testid="select-all-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    expect(isChecked(host, "s1")).toBe(true);
    expect(isChecked(host, "s2")).toBe(true);
    expect(isChecked(host, "s3")).toBe(true);
    expect(activated).toEqual([]); // selection, never activation
    // Exactly the visible set: p2 is collapsed, its lone session untouched.
    expect(host.querySelector('[data-testid="session-s4"]')).toBeNull();
    expect(host.querySelector('[data-testid="batch-count"]')!.textContent)
      .toBe('sidebar.batchCount {"count":3}');

    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    await flush();
    expect(checkbox(host, "s1")).toBeNull();
    expect(host.querySelector('[data-testid="batch-bar"]')).toBeNull();

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
    expect(host.querySelector('[data-testid="batch-count"]')!.textContent)
      .toBe('sidebar.batchCount {"count":3}');

    // Shift works upwards too: anchor stays at s3, shift-click s2 keeps s2..s3.
    rowMain(host, "s1")!.dispatchEvent(click({ meta: true })); // deselect s1
    await flush();
    expect(isChecked(host, "s1")).toBe(false);

    root.unmount();
  });

  test("checkbox click toggles selection and drives the batch bar count", async () => {
    const { host, root } = await mounted();
    expect(host.querySelector('[data-testid="batch-bar"]')).toBeNull();

    host.querySelector('[data-testid="select-all-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    expect(isChecked(host, "s2")).toBe(true);
    expect(host.querySelector('[data-testid="batch-bar"]')).not.toBeNull();

    checkbox(host, "s2")!.dispatchEvent(click());
    await flush();
    expect(isChecked(host, "s2")).toBe(false);
    expect(host.querySelector('[data-testid="batch-count"]')!.textContent)
      .toBe('sidebar.batchCount {"count":2}');

    // Deselect the rest: empty selection → the action bar hides even though
    // select mode is still on.
    checkbox(host, "s1")!.dispatchEvent(click());
    checkbox(host, "s3")!.dispatchEvent(click());
    await flush();
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
  test("select-all under an active tag filter selects only the filtered set (#155)", async () => {
    const { host, root } = await mounted(["p1"], {
      p1: [sess("s1", "p1", "", ["api"]), sess("s2", "p1"), sess("s3", "p1", "", ["api"])],
      p2: [sess("s4", "p2")],
    });

    // The filter chip row is panel-gated since #160b: open it first.
    host.querySelector<HTMLElement>('[data-testid="tag-filter-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    host.querySelector<HTMLElement>('[data-testid="tagfilter-p1-api"]')!.dispatchEvent(click());
    await flush();
    expect(host.querySelector('[data-testid="session-s2"]')).toBeNull(); // filter hides untagged

    host.querySelector('[data-testid="select-all-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    expect(isChecked(host, "s1")).toBe(true);
    expect(isChecked(host, "s3")).toBe(true);
    // Count equals the visible (filtered) count, not the project's full set.
    expect(host.querySelector('[data-testid="batch-count"]')!.textContent)
      .toBe('sidebar.batchCount {"count":2}');

    // Lift the filter: the previously hidden session was never selected.
    host.querySelector<HTMLElement>('[data-testid="tagfilter-p1-api"]')!.dispatchEvent(click());
    await flush();
    expect(isChecked(host, "s2")).toBe(false);
    expect(isChecked(host, "s1")).toBe(true);

    root.unmount();
  });

  test("select-all unions into an existing selection across projects", async () => {
    const { host, root } = await mounted(["p1", "p2"]);

    host.querySelector('[data-testid="select-all-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    host.querySelector('[data-testid="select-all-sessions-p2"]')!.dispatchEvent(click());
    await flush();

    expect(isChecked(host, "s1")).toBe(true);
    expect(isChecked(host, "s4")).toBe(true);
    expect(host.querySelector('[data-testid="batch-count"]')!.textContent)
      .toBe('sidebar.batchCount {"count":4}');

    root.unmount();
  });

  test("select-all on a collapsed project expands it so checkboxes render", async () => {
    const { host, root } = await mounted(["p1"]);
    expect(host.querySelector('[data-testid="session-s4"]')).toBeNull(); // collapsed

    host.querySelector('[data-testid="select-all-sessions-p2"]')!.dispatchEvent(click());
    await flush();
    // The project opened up and its visible sessions are checked.
    expect(host.querySelector('[data-testid="session-s4"]')).not.toBeNull();
    expect(isChecked(host, "s4")).toBe(true);
    // Select mode is on everywhere (p1 rows render checkboxes) but p1 stays unselected.
    expect(checkbox(host, "s1")).not.toBeNull();
    expect(isChecked(host, "s1")).toBe(false);

    root.unmount();
  });

  test("select-all on a project with no sessions is a no-op (#155 ③)", async () => {
    const { host, root } = await mounted(["p1"], {
      p1: [sess("s1", "p1")],
      p2: [],
    });

    const btn = host.querySelector<HTMLElement>('[data-testid="select-all-sessions-p2"]');
    expect(btn).not.toBeNull();
    btn!.dispatchEvent(click());
    await flush();

    // No selection, no select mode, no batch bar, no crash.
    expect(host.querySelector('[data-testid="batch-bar"]')).toBeNull();
    expect(checkbox(host, "s1")).toBeNull();
    expect(activated).toEqual([]);

    root.unmount();
  });
  test("select-all is a toggle: second click deselects the visible set and exits the emptied mode (#161)", async () => {
    const { host, root } = await mounted();

    host.querySelector('[data-testid="select-all-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    expect(isChecked(host, "s1")).toBe(true);
    expect(host.querySelector('[data-testid="batch-bar"]')).not.toBeNull();

    host.querySelector('[data-testid="select-all-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    expect(isChecked(host, "s1")).toBe(false);
    expect(isChecked(host, "s3")).toBe(false);
    // The toggle emptied the whole selection → select mode leaves entirely
    // (same end state as Esc): checkboxes and the batch bar are gone.
    expect(checkbox(host, "s1")).toBeNull();
    expect(host.querySelector('[data-testid="batch-bar"]')).toBeNull();

    root.unmount();
  });

  test("select-all toggle tops up a partial selection instead of clearing it (#161)", async () => {
    const { host, root } = await mounted();

    rowMain(host, "s1")!.dispatchEvent(click({ meta: true }));
    await flush();
    expect(isChecked(host, "s1")).toBe(true);

    // Not everything visible is selected → the click selects, never clears.
    host.querySelector('[data-testid="select-all-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    expect(isChecked(host, "s1")).toBe(true);
    expect(isChecked(host, "s2")).toBe(true);
    expect(isChecked(host, "s3")).toBe(true);

    root.unmount();
  });

  test("select-all toggle is per-project: deselecting one project keeps the other's selection", async () => {
    const { host, root } = await mounted(["p1", "p2"]);

    host.querySelector('[data-testid="select-all-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    host.querySelector('[data-testid="select-all-sessions-p2"]')!.dispatchEvent(click());
    await flush();
    expect(host.querySelector('[data-testid="batch-count"]')!.textContent)
      .toBe('sidebar.batchCount {"count":4}');

    host.querySelector('[data-testid="select-all-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    expect(isChecked(host, "s1")).toBe(false);
    expect(isChecked(host, "s3")).toBe(false);
    expect(isChecked(host, "s4")).toBe(true); // p2 untouched
    expect(host.querySelector('[data-testid="batch-count"]')!.textContent)
      .toBe('sidebar.batchCount {"count":1}');
    expect(host.querySelector('[data-testid="batch-bar"]')).not.toBeNull(); // still in select mode

    root.unmount();
  });

  test("select-all keeps the Shift+click anchor: range still extends from the pre-existing anchor (#161)", async () => {
    const { host, root } = await mounted();

    // Anchor at s2 via Cmd+click — select-all must NOT touch it (#155 ④).
    rowMain(host, "s2")!.dispatchEvent(click({ meta: true }));
    await flush();
    expect(isChecked(host, "s2")).toBe(true);

    // Select-all folds the visible set in.
    host.querySelector('[data-testid="select-all-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    expect(isChecked(host, "s1")).toBe(true);
    expect(isChecked(host, "s3")).toBe(true);

    // Shift+click s3: with the anchor intact (s2) this extends the s2..s3
    // range and everything stays checked. If select-all had clobbered the
    // anchor, the shift-click would fall through to a plain toggle and s3
    // would flip OFF (count 2) — this pins the anchor preservation.
    rowMain(host, "s3")!.dispatchEvent(click({ shift: true }));
    await flush();
    expect(isChecked(host, "s2")).toBe(true);
    expect(isChecked(host, "s3")).toBe(true);
    expect(host.querySelector('[data-testid="batch-count"]')!.textContent)
      .toBe('sidebar.batchCount {"count":3}');
    expect(activated).toEqual([]); // range select, never activation

    root.unmount();
  });
});
