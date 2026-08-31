// App-level mount test for ⌘/Ctrl+1-9 switching OPEN TABS (issue #87).
//
// The digit handler used to index the sidebar session list (sessionsRef — "Nth
// session of the selected project"); it now indexes openTabsRef — digit N
// activates the Nth OPEN tab, digit order = openTabs array order = TabBar
// display order. Exercises the REAL App component (main window + one popout
// boot) with the backend bindings mocked:
//   1. 3 tabs, ⌘2 → the 2nd tab's session becomes the selected/active one
//      (TabBar active state follows the selection) and consumes the event.
//   2. Out of range (⌘4/⌘5 with 3 tabs) → silent passthrough: no
//      preventDefault, no switch — even though the sidebar list holds 60
//      sessions, which the OLD list-indexing semantics would have jumped into.
//   3. Closing a tab renumbers the digits: [s1,s2,s3] → close s2 → ⌘2
//      activates s3.
//   4. Popout window: the listener is not attached — ⌘2 is a no-op there.
//
// NOTE: no legacy test existed for the old list-indexing behavior (commit
// 101f315 shipped the handler without tests); these pin the new tab semantics.
//
// NOTE: App (and the binding modules it transitively imports) is imported
// dynamically AFTER mock.module registration on purpose — a static import would
// evaluate the real binding modules before the mocks replace them (same
// scaffolding as App.tab-limit.mount.test.tsx).
import { describe, test, expect, mock } from "bun:test";
import React from "react";
import { Window } from "happy-dom";
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
// 60 sidebar sessions: deliberately MORE than the 3 open tabs, so an
// out-of-range digit would switch under the old list-indexing semantics but
// must not under the tab semantics.
const SESSIONS = Array.from({ length: 60 }, (_, i) => ({
  id: `s${i + 1}`,
  projectId: "p1",
  title: `Session ${i + 1}`,
  harness: "omp",
}));
// OpenSession call log, one entry per invoked session id (in order).
const calls: string[] = [];
mock.module("./bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => {
  const stubs: Record<string, unknown> = Object.fromEntries([
    'AddHarness', 'AddProject', 'BrowseDir', 'BrowseRoots', 'CloseSessionWindow', 'ContinueSession', 'CreateGuestSession', 'CreateMcpServer', 'CreatePermissionRule', 'CreateSession', 'DeleteMcpServer', 'DeletePermissionRule', 'DeleteSession', 'DeleteWorktree', 'DetachWorktreeGuests', 'EditQueueItem', 'EnqueueMessage', 'ExpandSessionWindow', 'ExportSession', 'FocusSessionWindow', 'GenerateRemotePairingCode', 'GetConfig', 'GetLastHarness', 'GetRemoteInfo', 'GetSessionCachedCommands', 'GetSessionCachedConfigOptions', 'GetSessionMcpServers', 'GetSessionProjectID', 'GetSessionSnapshot', 'HasGitContext', 'ImportMcpConfig', 'InterruptAndSend', 'IsGitProject', 'IsSessionWindowPopped', 'ListHarnessCapabilities', 'ListHarnesses', 'ListMcpServers', 'ListPermissionRules', 'ListProjects', 'ListSessions', 'ListUserMessages', 'ListWorktrees', 'LoadMessagesPage', 'MergeSession', 'OpenSession', 'OpenSessionWindow', 'OpenURL', 'PickDirectory', 'PickFiles', 'ProbeNewHarness', 'RecentBaseRefs', 'RefreshHarnesses', 'RefreshSessionConfig', 'RegenerateRemoteToken', 'RemoteListSessions', 'RemoteRevokeSession', 'RemoveProject', 'ReorderPermissionRules', 'ReorderProjects', 'ReorderQueueItem', 'ResetPermissionRules', 'ResolveBaseRefDefault', 'RespondElicitation', 'RespondPermission', 'RevealPath', 'RevokeQueueItem', 'SaveSessionSnapshot', 'ScheduleQueueItem', 'SearchBaseRefs', 'SearchSessionContent', 'SendMessage', 'SessionAICommit', 'SessionChanges', 'SessionCommit', 'SessionCreateDir', 'SessionCreateFile', 'SessionCurrentBranch', 'SessionDeletePath', 'SessionDiscard', 'SessionFileDiff', 'SessionFuzzyFind', 'SessionListDir', 'SessionMergeable', 'SessionReadFile', 'SessionReadImage', 'SessionRenamePath', 'SessionStage', 'SessionStatuses', 'SessionUnstage', 'SessionWriteFile', 'SetAutoHarnessUpgrade', 'SetCheckHarnessUpdates', 'SetQueueItemRepeat', 'SetRemoteEnabled', 'SetRemotePort', 'SetRemotePublicURL', 'SetSessionConfigOption', 'SetSessionPinned', 'SetSessionWindowOnTop', 'ShrinkSessionWindow', 'StopSession', 'ToggleMaximise', 'UpdateMcpServer', 'UpdatePermissionRule', 'UpdateSessionCustomTitle', 'UpdateSessionTags', 'UpdateUserHarness', 'UpgradeHarness', 'WorktreeGuests', 'WorktreeKind',
  ].map((n) => [n, async () => null]));
  // --- explicit behavior for the bindings the open path needs ---
  stubs.ListProjects = async () => [{ id: "p1", name: "demo", path: "/tmp/demo" }];
  stubs.ListSessions = async () => SESSIONS;
  stubs.ListHarnesses = async () => [];
  stubs.SessionStatuses = async () => ({});
  stubs.GetSessionProjectID = async () => "p1";
  stubs.OpenSession = async (sessionId: string) => { calls.push(`OpenSession:${sessionId}`); return null; };
  stubs.LoadMessagesPage = async () => [];
  stubs.ListUserMessages = async () => [];
  stubs.GetSessionCachedConfigOptions = async () => [];
  stubs.GetSessionCachedCommands = async () => [];
  stubs.SessionChanges = async () => null;
  stubs.SessionCurrentBranch = async () => "";
  stubs.SessionMergeable = async () => false;
  stubs.WorktreeKind = async () => "project";
  return stubs;
});
mock.module("./bindings/github.com/jessonchan/monkey-deck/internal/terminal/terminalservice", () => ({
  GetTerminalScrollback: async () => "",
  Kill: async () => {},
  KillSessionTerminals: async () => {},
  ListTerminalsBySession: async () => [],
  Resize: async () => {},
  Start: async () => "",
  Write: async () => {},
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

async function mountApp(): Promise<Root> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(React.createElement(App));
  await flush();
  return root;
}

// Restore-path tab registration: popout window closed → session returns to the
// strip (registers the tab WITHOUT selecting it).
async function restoreSession(sid: string) {
  const onPopoutChanged = eventHandlers.get("chat:popout-changed");
  if (!onPopoutChanged) throw new Error("chat:popout-changed handler not registered");
  onPopoutChanged({ data: { sessionId: sid, popped: false } });
  await flush();
}

function tab(id: string): Element | null {
  return document.querySelector(`[data-testid="tab-${id}"]`);
}
function activeTabId(): string | null {
  return document.querySelector<HTMLElement>(".tabbar-tab.active")?.dataset.testid?.replace(/^tab-/, "") ?? null;
}
// Real user paths only: tabs open via the restore event, activation via a tab
// click (TabBar onSelect → openSession), close via the tab's × button.
async function openThreeTabsAndSelectFirst() {
  await restoreSession("s1");
  await restoreSession("s2");
  await restoreSession("s3");
  tab("s1")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
  await flush();
}
// Dispatch a Cmd+<digit> keydown on window; returns the event so tests can
// assert defaultPrevented (consumed vs. silently passed through).
function cmdDigit(digit: string): KeyboardEvent {
  const ev = new window.KeyboardEvent("keydown", { key: digit, metaKey: true, bubbles: true, cancelable: true });
  window.dispatchEvent(ev);
  return ev;
}

async function cleanup(root: Root) {
  root.unmount();
  document.body.innerHTML = "";
  await flush();
}

describe("App ⌘1-9 switches open tabs (#87)", () => {
  test("⌘2 with 3 tabs activates the 2nd tab's session", async () => {
    const root = await mountApp();
    try {
      await openThreeTabsAndSelectFirst();
      expect(document.querySelectorAll(".tabbar-tab").length).toBe(3);
      expect(activeTabId()).toBe("s1");

      const ev = cmdDigit("2");
      await flush();
      // Selection followed the digit: 2nd tab active, event consumed.
      expect(ev.defaultPrevented).toBe(true);
      expect(activeTabId()).toBe("s2");
      expect(calls).toContain("OpenSession:s2");
    } finally {
      await cleanup(root);
    }
  });

  test("out-of-range digit is a silent passthrough, even though the sidebar list has 60 sessions", async () => {
    const root = await mountApp();
    try {
      await openThreeTabsAndSelectFirst();
      const before = calls.length;

      for (const digit of ["4", "9"]) {
        const ev = cmdDigit(digit);
        await flush();
        // Old list-indexing semantics would have jumped to s4/s9 here (the
        // sidebar list holds 60); tab semantics must ignore and pass through.
        expect(ev.defaultPrevented).toBe(false);
        expect(activeTabId()).toBe("s1");
      }
      expect(calls.length).toBe(before);
    } finally {
      await cleanup(root);
    }
  });

  test("closing a tab renumbers: [s1,s2,s3] → close s2 → ⌘2 activates s3", async () => {
    const root = await mountApp();
    try {
      await openThreeTabsAndSelectFirst();

      // Close the non-active middle tab via its × button (idle session → no dialog).
      const closeBtn = document.querySelector('[data-testid="tab-close-s2"]');
      closeBtn!.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
      await flush();
      expect(document.querySelectorAll(".tabbar-tab").length).toBe(2);
      expect(activeTabId()).toBe("s1"); // closing a background tab keeps the selection

      // s3 is now the 2nd tab: ⌘2 must land on it.
      const ev = cmdDigit("2");
      await flush();
      expect(ev.defaultPrevented).toBe(true);
      expect(activeTabId()).toBe("s3");
    } finally {
      await cleanup(root);
    }
  });

  test("popout window: ⌘2 is a no-op (listener not attached)", async () => {
    // Popout boot: App opens the hash-target session on mount (backend normally
    // creates this window with the hash).
    window.location.hash = "#popout=s1";
    const root = await mountApp();
    try {
      await flush();
      expect(calls).toContain("OpenSession:s1"); // boot opened exactly the popout target
      expect(document.querySelector('[data-testid="tabbar"]')).toBeNull(); // no tab bar in popout
      const openCalls = calls.filter((c) => c.startsWith("OpenSession:")).length;

      const ev = cmdDigit("2");
      await flush();
      expect(ev.defaultPrevented).toBe(false);
      expect(calls.filter((c) => c.startsWith("OpenSession:")).length).toBe(openCalls);
    } finally {
      window.location.hash = "";
      await cleanup(root);
    }
  });
});
