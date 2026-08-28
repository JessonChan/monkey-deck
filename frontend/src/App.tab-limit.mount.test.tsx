// App-level mount test for the 50-tab cap (#156).
//
// Exercises the REAL App component (main window — no popout hash) with the
// backend bindings mocked, and drives tab registration through the REAL
// chat:popout-changed restore path (popout window closes → session returns to
// the main window's tab strip → registerTab). Assertions:
//  1. Cap: 50 restore events fill the strip; the 51st is REJECTED — still 50
//     rendered tabs (the updater re-checks prev, so the cap holds).
//  2. Hint: the rejected open bumps tabLimitHintSeq → TabBar renders the
//     transient inline hint.
//  3. Self-dismiss: the hint disappears after 1.5s (fake timers).
//  4. Re-opening an EXISTING tab at the cap is not a rejection (no new hint).
//
// NOTE: App (and the binding modules it transitively imports) is imported
// dynamically AFTER mock.module registration on purpose — a static import would
// evaluate the real binding modules before the mocks replace them (same
// scaffolding as App.commands-seed.mount.test.tsx).
import { describe, test, expect, mock, vi } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";

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

// Main window boot: NO popout hash — the tab strip is a main-window-only feature.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

// Mock by RESOLVED path: bare-specifier mocks do not reliably intercept the
// same module when imported transitively by first-party code (lib/clipboard,
// lib/termRegistry) — the resolved absolute path matches every importer.
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

// ---- ResizeObserver mock: panels/ChatView/TabBar measure on mount.
// No fire = TabBar stripWidth stays null = wide form (titles render).
class MockResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) { this.cb = cb; }
  observe(_el: Element) {}
  unobserve(_el: Element) {}
  disconnect() {}
}
(globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;

// ---- mock backend bindings ----
// Any binding not explicitly stubbed auto-resolves to a benign async stub — App's
// mount/open graph touches ~120 bindings and only the session-list ones matter
// here (they must resolve so sessionById finds every registered tab and the
// TabBar actually renders it). Mirrors App.commands-seed.mount.test.tsx.
const SESSIONS = Array.from({ length: 60 }, (_, i) => ({
  id: `s${i + 1}`,
  projectId: "p1",
  title: `Session ${i + 1}`,
  harness: "omp",
}));
mock.module("./bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => {
  const stubs: Record<string, unknown> = Object.fromEntries([
    'AddHarness', 'AddProject', 'BrowseDir', 'BrowseRoots', 'CloseSessionWindow', 'ContinueSession', 'CreateGuestSession', 'CreateMcpServer', 'CreatePermissionRule', 'CreateSession', 'DeleteMcpServer', 'DeletePermissionRule', 'DeleteSession', 'DeleteWorktree', 'DetachWorktreeGuests', 'EditQueueItem', 'EnqueueMessage', 'ExpandSessionWindow', 'ExportSession', 'FocusSessionWindow', 'GenerateRemotePairingCode', 'GetConfig', 'GetLastHarness', 'GetRemoteInfo', 'GetSessionCachedCommands', 'GetSessionCachedConfigOptions', 'GetSessionMcpServers', 'GetSessionProjectID', 'GetSessionSnapshot', 'HasGitContext', 'ImportMcpConfig', 'InterruptAndSend', 'IsGitProject', 'IsSessionWindowPopped', 'ListHarnessCapabilities', 'ListHarnesses', 'ListMcpServers', 'ListPermissionRules', 'ListProjects', 'ListSessions', 'ListUserMessages', 'ListWorktrees', 'LoadMessagesPage', 'MergeSession', 'OpenSession', 'OpenSessionWindow', 'OpenURL', 'PickDirectory', 'PickFiles', 'ProbeNewHarness', 'RecentBaseRefs', 'RefreshHarnesses', 'RefreshSessionConfig', 'RegenerateRemoteToken', 'RemoteListSessions', 'RemoteRevokeSession', 'RemoveProject', 'ReorderPermissionRules', 'ReorderProjects', 'ReorderQueueItem', 'ResetPermissionRules', 'ResolveBaseRefDefault', 'RespondElicitation', 'RespondPermission', 'RevealPath', 'RevokeQueueItem', 'SaveSessionSnapshot', 'ScheduleQueueItem', 'SearchBaseRefs', 'SearchSessionContent', 'SendMessage', 'SessionAICommit', 'SessionChanges', 'SessionCommit', 'SessionCreateDir', 'SessionCreateFile', 'SessionCurrentBranch', 'SessionDeletePath', 'SessionDiff', 'SessionDiscard', 'SessionFileDiff', 'SessionFuzzyFind', 'SessionListDir', 'SessionMergeable', 'SessionReadFile', 'SessionReadImage', 'SessionRenamePath', 'SessionStage', 'SessionStatuses', 'SessionUnstage', 'SessionWriteFile', 'SetAutoHarnessUpgrade', 'SetCheckHarnessUpdates', 'SetQueueItemRepeat', 'SetRemoteEnabled', 'SetRemotePort', 'SetRemotePublicURL', 'SetSessionConfigOption', 'SetSessionPinned', 'SetSessionWindowOnTop', 'ShrinkSessionWindow', 'StopSession', 'ToggleMaximise', 'UpdateMcpServer', 'UpdatePermissionRule', 'UpdateSessionCustomTitle', 'UpdateSessionTags', 'UpdateUserHarness', 'UpgradeHarness', 'WorktreeGuests', 'WorktreeKind',
  ].map((n) => [n, async () => null]));
  stubs.ListProjects = async () => [{ id: "p1", name: "demo", path: "/tmp/demo" }];
  stubs.ListSessions = async () => SESSIONS;
  stubs.ListHarnesses = async () => [];
  stubs.SessionStatuses = async () => ({});
  return stubs;
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
const { TAB_LIMIT } = await import("./components/TabBar.tsx");

const delay = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  realSetTimeout(resolve, ms);
  return promise;
};
async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) await delay(0);
}

async function mountApp(): Promise<Root> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(React.createElement(App));
  await flush();
  return root;
}

// Restore-path registration: popout window closed → session returns to the strip.
// One flush per event mirrors real user pacing (each event lands in its own
// render batch, keeping openTabsRef fresh — the ref-based hint decision depends
// on committed state).
async function restoreSession(sid: string) {
  const onPopoutChanged = eventHandlers.get("chat:popout-changed");
  if (!onPopoutChanged) throw new Error("chat:popout-changed handler not registered");
  onPopoutChanged({ data: { sessionId: sid, popped: false } });
  await flush();
}

describe("App 50-tab cap (#156)", () => {
  test("51st tab rejected, transient hint shows and self-dismisses; existing-tab reopen is not a rejection", async () => {
    expect(TAB_LIMIT).toBe(50);
    const root = await mountApp();
    const renderedTabs = () => document.querySelectorAll(".tabbar-tab").length;
    const hint = () => document.querySelector('[data-testid="tabbar-limit-hint"]');

    // Fill the strip to the cap through the real restore path.
    for (let i = 1; i <= TAB_LIMIT; i++) await restoreSession(`s${i}`);
    expect(renderedTabs()).toBe(TAB_LIMIT);
    expect(hint()).toBeNull();

    // The 51st restore is rejected: no new tab, transient hint appears.
    await restoreSession("s51");
    expect(renderedTabs()).toBe(TAB_LIMIT);
    expect(hint()).not.toBeNull();
    expect(hint()!.textContent).toBe("tabbar.limitTip");

    // Hint self-dismisses after 1.5s (TabBar-owned timer under fake timers).
    vi.useFakeTimers();
    vi.advanceTimersByTime(1500);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await delay(5);
    vi.useRealTimers();
    expect(hint()).toBeNull();

    // Re-opening an EXISTING tab at the cap: not a rejection — no new hint, count unchanged.
    await restoreSession("s3");
    expect(renderedTabs()).toBe(TAB_LIMIT);
    expect(hint()).toBeNull();

    root.unmount();
    document.body.innerHTML = "";
  });
});
