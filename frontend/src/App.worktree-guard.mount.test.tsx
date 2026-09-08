// App-level mount tests for #199: the worktree live-guest guard on the delete chain.
//
// Locks the two frontend fixes of #199 against the REAL App → Sidebar → dialog wiring:
//  1. removeSession with a FAILED WorktreeGuests query must NOT degrade to "no guests"
//     (the old catch{} swallowed the error and deleted the worktree under a possibly-live
//     guest). Conservative path: DeleteSession only — the worktree survives as an orphan
//     (forks stay alive); DeleteWorktree is never called.
//  2. confirmDeleteWorktree "keep" chain must NOT swallow a DetachWorktreeGuests failure:
//     a failed detach leaves live guests on the worktree; DeleteWorktree (the backend
//     guard would refuse anyway) and owner DeleteSession are both skipped —
//     the error surfaces on the error bar and the status quo is kept.
//  3. Happy chains pin the wire contract: "keep" → Detach → DeleteWorktree(sid,false) →
//     DeleteSession(sid); "all" → per-guest DeleteSession → DeleteWorktree(sid,TRUE) →
//     DeleteSession(sid) (force=true — the user confirmed deleting everything).
//
// Scaffolding mirrors App.queue-repeat-send-now.mount.test.tsx: mocks are registered
// BEFORE the dynamic App import — a static import would evaluate the real binding
// modules before the mocks replace them.
import { describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { registerChatserviceMock } from "./test/chatservice-mock";

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
globalThis.localStorage = window.localStorage;
window.React = React;

const realSetTimeout = globalThis.setTimeout.bind(globalThis);

// Mock by RESOLVED path: bare-specifier mocks do not reliably intercept the
// same module when imported transitively by first-party code.
const eventHandlers = new Map<string, (e: unknown) => void>();
mock.module(require.resolve("@wailsio/runtime"), () => ({
  Events: {
    On: (name: string, cb: (e: unknown) => void) => {
      eventHandlers.set(name, cb);
      return () => eventHandlers.delete(name);
    },
    Off: (name: string) => { eventHandlers.delete(name); },
    Emit: () => {},
  },
  // clipboard.ts imports Clipboard at module level (App → ChatView → … reach it).
  Clipboard: { setText: async () => {}, readText: async () => "" },
}));

// ---- ResizeObserver mock: panels/ChatView/TabBar measure on mount. ----
class MockResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) { this.cb = cb; }
  observe(_el: Element) {}
  unobserve(_el: Element) {}
  disconnect() {}
}
(globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;

// ---- per-test behavior switches + call-order recording ----
// `events` pins the exact wire ORDER of the delete chain; `behavior` flips per-test
// stub responses (the mock module is registered once, before the App import).
const behavior = {
  kind: "owner",
  guests: [] as Array<Record<string, unknown>>,
  guestsError: null as unknown,
  detachError: null as unknown,
};
let events: string[] = [];
const reset = () => {
  behavior.kind = "owner";
  behavior.guests = [];
  behavior.guestsError = null;
  behavior.detachError = null;
  events = [];
};

registerChatserviceMock(mock, {
  WorktreeKind: async () => behavior.kind,
  WorktreeGuests: async () => {
    if (behavior.guestsError) throw behavior.guestsError;
    return behavior.guests;
  },
  DetachWorktreeGuests: async (sid: string) => {
    events.push(`detach:${sid}`);
    if (behavior.detachError) throw behavior.detachError;
    return null;
  },
  DeleteWorktree: async (sid: string, force: boolean) => {
    events.push(`deleteWt:${sid}:${force ? "force" : "plain"}`);
    return null;
  },
  DeleteSession: async (sid: string) => {
    events.push(`deleteSession:${sid}`);
    return null;
  },
});
mock.module("./bindings/github.com/jessonchan/monkey-deck/internal/terminal/terminalservice", () => ({
  ListTerminalsBySession: async () => [],
}));
// react-resizable-panels: real library measures the DOM and its imperative
// collapse() throws "Group not found" under happy-dom (no layout engine). The
// panel layout is not the SUT — render as plain divs with inert imperative handles.
mock.module("react-resizable-panels", () => {
  const div = (props: Record<string, unknown>) => React.createElement("div", props);
  const handle = {
    collapse: () => {},
    expand: () => {},
    isCollapsed: () => false,
    resize: () => {},
  };
  return {
    Group: div,
    Panel: div,
    Separator: () => null,
    useDefaultLayout: (_opts?: unknown) => ({ defaultLayout: undefined, onLayoutChanged: () => {} }),
    usePanelRef: () => ({ current: handle }),
  };
});
mock.module("react-tooltip", () => ({ Tooltip: () => null, default: () => null }));
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "zh" } }),
  initReactI18next: { type: "3rd-party" },
  default: { useTranslation: () => ({ t: (k: string) => k, i18n: { language: "zh" } }) },
}));

// ---- imports AFTER mocks (see NOTE at top) ----
const { default: App } = await import("./App.tsx");

const delay = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  realSetTimeout(resolve, ms);
  return promise;
};
async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) await delay(0);
}

async function mountApp(): Promise<{ root: Root; host: HTMLElement }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(React.createElement(App));
  await flush();
  return { root, host };
}

function click(el: Element) {
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
}

// Open the project (loads sessions), open the session (mounts ChatView so the
// error bar is assertable), right-click the row, pick 删除会话 from the ctx menu.
async function openDeleteConfirm(host: HTMLElement) {
  click(host.querySelector('[data-testid="project-p1"]')!);
  await flush();
  click(host.querySelector('[data-testid="session-s1"] .session-item-main')!);
  await flush();
  host
    .querySelector('[data-testid="session-s1"]')!
    .dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  await flush();
}

const guest = (id: string): Record<string, unknown> => ({ id, projectId: "p1", title: id, harness: "omp" });

describe("App worktree live-guest guard on the delete chain (#199)", () => {
  test("removeSession: failed guest query deletes ONLY the chat row, worktree untouched", async () => {
    reset();
    behavior.guestsError = new Error("db locked");
    const { root, host } = await mountApp();
    await openDeleteConfirm(host);

    // Confirm modal is up; confirming runs the conservative path.
    click(host.querySelector('[data-testid="confirm-remove-session"]')!);
    await flush();

    expect(events).toEqual(["deleteSession:s1"]);
    // No worktree deletion and no dialog detour: the failed query must NOT be
    // read as "no guests".
    expect(host.querySelector('[data-testid="confirm-remove-session"]')).toBeNull();
    expect(host.querySelector('[data-testid="delete-wt-keep"]')).toBeNull();

    root.unmount();
    document.body.innerHTML = "";
  });

  test("keep chain: failed detach keeps the status quo, error floats up, worktree untouched", async () => {
    reset();
    behavior.guests = [guest("g1")];
    behavior.detachError = new Error("detach boom");
    const { root, host } = await mountApp();
    await openDeleteConfirm(host);

    // Guests present → the 3-option dialog drives the rest.
    expect(host.querySelector('[data-testid="delete-wt-guests"]')).not.toBeNull();
    click(host.querySelector('[data-testid="delete-wt-keep"]')!);
    await flush();

    // Detach attempted; on failure NOTHING else runs (no worktree delete, no owner
    // delete) — the backend guard would refuse anyway, and #199 forbids swallowing.
    expect(events).toEqual(["detach:s1"]);
    const msg = host.querySelector('[data-testid="error-bar-msg"]');
    expect(msg).not.toBeNull();
    expect(msg!.textContent).toContain("detach boom");
    // Status quo kept: the owner session is still around (not purged from the list).
    expect(host.querySelector('[data-testid="session-s1"]')).not.toBeNull();

    root.unmount();
    document.body.innerHTML = "";
  });

  test("keep chain (happy): Detach → DeleteWorktree(sid, plain) → DeleteSession(sid), in order", async () => {
    reset();
    behavior.guests = [guest("g1")];
    const { root, host } = await mountApp();
    await openDeleteConfirm(host);

    click(host.querySelector('[data-testid="delete-wt-keep"]')!);
    await flush();

    // Guests detached BEFORE the worktree delete (the unforced guard must pass),
    // and the owner chat goes last.
    expect(events).toEqual(["detach:s1", "deleteWt:s1:plain", "deleteSession:s1"]);

    root.unmount();
    document.body.innerHTML = "";
  });

  test("all chain (happy): guests deleted, then DeleteWorktree(sid, FORCE), then owner", async () => {
    reset();
    behavior.guests = [guest("g1"), guest("g2")];
    const { root, host } = await mountApp();
    await openDeleteConfirm(host);

    click(host.querySelector('[data-testid="delete-wt-all"]')!);
    await flush();

    // Guests first (their harnesses run in the worktree), then the forced worktree
    // delete (the user already confirmed deleting everything), then the owner chat.
    expect(events).toEqual([
      "deleteSession:g1",
      "deleteSession:g2",
      "deleteWt:s1:force",
      "deleteSession:s1",
    ]);

    root.unmount();
    document.body.innerHTML = "";
  });
});
