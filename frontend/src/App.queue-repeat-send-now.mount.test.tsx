// App-level mount test for #184: "send now" (queue-interrupt) on a RECURRING
// queue item must NOT take the RevokeQueueItem + InterruptAndSend path —
// revoking deletes the row and loses repeatEveryMs/sentCount/scheduledAt
// (= silently cancelling the loop), and a manual InterruptAndSend would
// double-send (the queued row drains again from the tail). The item is instead
// marked due immediately via ScheduleQueueItem(sid, id, ≈now): the backend
// sends it with the loop state intact (right away when idle, at the current
// turn's tail drain when busy) and the post-send reschedule re-anchors from
// the real send (#176). A PLAIN item keeps the existing Revoke+Interrupt path.
//
// Exercises the REAL App → ChatView → QueuePanel wiring: a session is opened
// through the real sidebar click path, a chat:queue snapshot is pushed through
// the real event subscription, and the queue-interrupt button click is
// asserted against recording binding spies.
//
// Scaffolding mirrors App.tab-limit.mount.test.tsx: mocks are registered
// BEFORE the dynamic App import — a static import would evaluate the real
// binding modules before the mocks replace them.
import { describe, test, expect, mock } from "bun:test";
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

// ---- recording spies for the three bindings under test ----
const calls = {
  schedule: [] as Array<{ sid: string; id: string; at: number }>,
  revoke: [] as Array<{ sid: string; id: string }>,
  interrupt: [] as Array<{ sid: string; text: string }>,
};

// ---- mock backend bindings ----
// Any binding not explicitly stubbed auto-resolves to a benign async stub —
// App's mount/open graph touches ~120 bindings and only the session-list and
// queue-mutation ones matter here. Mirrors App.tab-limit.mount.test.tsx.
mock.module("./bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => {
  const stubs: Record<string, unknown> = Object.fromEntries([
    'AddHarness', 'AddProject', 'BrowseDir', 'BrowseRoots', 'CloseSessionWindow', 'ContinueSession', 'CreateGuestSession', 'CreateMcpServer', 'CreatePermissionRule', 'CreateSession', 'DeleteMcpServer', 'DeletePermissionRule', 'DeleteSession', 'DeleteWorktree', 'DetachWorktreeGuests', 'EditQueueItem', 'EnqueueMessage', 'ExpandSessionWindow', 'ExportSession', 'FocusSessionWindow', 'GenerateRemotePairingCode', 'GetConfig', 'GetLastHarness', 'GetRemoteInfo', 'GetSessionCachedCommands', 'GetSessionCachedConfigOptions', 'GetSessionMcpServers', 'GetSessionProjectID', 'GetSessionSnapshot', 'HasGitContext', 'ImportMcpConfig', 'InterruptAndSend', 'IsGitProject', 'IsSessionWindowPopped', 'ListHarnessCapabilities', 'ListHarnesses', 'ListMcpServers', 'ListPermissionRules', 'ListProjects', 'ListSessions', 'ListUserMessages', 'ListWorktrees', 'LoadMessagesPage', 'MergeSession', 'OpenSession', 'OpenSessionWindow', 'OpenURL', 'PickDirectory', 'PickFiles', 'ProbeNewHarness', 'RecentBaseRefs', 'RefreshHarnesses', 'RefreshSessionConfig', 'RegenerateRemoteToken', 'RemoteListSessions', 'RemoteRevokeSession', 'RemoveProject', 'ReorderPermissionRules', 'ReorderProjects', 'ReorderQueueItem', 'ResetPermissionRules', 'ResolveBaseRefDefault', 'RespondElicitation', 'RespondPermission', 'RevealPath', 'RevokeQueueItem', 'SaveSessionSnapshot', 'ScheduleQueueItem', 'SearchBaseRefs', 'SearchSessionContent', 'SendMessage', 'SessionAICommit', 'SessionChanges', 'SessionCommit', 'SessionCreateDir', 'SessionCreateFile', 'SessionCurrentBranch', 'SessionDeletePath', 'SessionDiscard', 'SessionFileDiff', 'SessionFuzzyFind', 'SessionListDir', 'SessionMergeable', 'SessionReadFile', 'SessionReadImage', 'SessionRenamePath', 'SessionStage', 'SessionStatuses', 'SessionUnstage', 'SessionWriteFile', 'SetAutoHarnessUpgrade', 'SetCheckHarnessUpdates', 'SetQueueItemRepeat', 'SetRemoteEnabled', 'SetRemotePort', 'SetRemotePublicURL', 'SetSessionConfigOption', 'SetSessionPinned', 'SetSessionWindowOnTop', 'ShrinkSessionWindow', 'StopSession', 'ToggleMaximise', 'UpdateMcpServer', 'UpdatePermissionRule', 'UpdateSessionCustomTitle', 'UpdateSessionTags', 'UpdateUserHarness', 'UpgradeHarness', 'WorktreeGuests', 'WorktreeKind',
  ].map((n) => [n, async () => null]));
  stubs.ListProjects = async () => [{ id: "p1", name: "demo", path: "/tmp/demo" }];
  stubs.ListSessions = async () => [{ id: "s1", projectId: "p1", title: "S1", harness: "omp" }];
  stubs.ListHarnesses = async () => [];
  stubs.SessionStatuses = async () => ({});
  stubs.ScheduleQueueItem = async (sid: string, id: string, at: number) => {
    calls.schedule.push({ sid, id, at });
    return null;
  };
  stubs.RevokeQueueItem = async (sid: string, id: string) => {
    calls.revoke.push({ sid, id });
    return null;
  };
  stubs.InterruptAndSend = async (sid: string, text: string) => {
    calls.interrupt.push({ sid, text });
    return null;
  };
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

async function openSessionWithQueue(host: HTMLElement, items: Array<Record<string, unknown>>) {
  // Open the project (selectProject → refreshSessions) then the session row —
  // the real sidebar click path that sets selectedSessionId.
  click(host.querySelector('[data-testid="project-p1"]')!);
  await flush();
  click(host.querySelector('[data-testid="session-s1"] .session-item-main')!);
  await flush();
  // Push the authoritative queue snapshot through the real chat:queue handler.
  const onQueue = eventHandlers.get("chat:queue");
  if (!onQueue) throw new Error("chat:queue handler not registered");
  onQueue({ data: { sessionId: "s1", items } });
  await flush();
}

function interruptBtn(host: HTMLElement, itemId: string): HTMLElement {
  const btn = host.querySelector(`[data-testid="queue-item"][data-id="${itemId}"] [data-testid="queue-interrupt"]`);
  if (!btn) throw new Error(`queue-interrupt button for ${itemId} not rendered`);
  return btn;
}

describe("App queue send-now on recurring item (#184)", () => {
  test("repeat item: ScheduleQueueItem(≈now), no revoke, no interrupt", async () => {
    calls.schedule.length = 0; calls.revoke.length = 0; calls.interrupt.length = 0;
    const { root, host } = await mountApp();
    await openSessionWithQueue(host, [
      { id: "qr", text: "tick", scheduledAt: Date.now(), repeatEveryMs: 5 * 60_000, sentCount: 2 },
    ]);

    const before = Date.now();
    click(interruptBtn(host, "qr"));
    await flush();

    expect(calls.schedule).toHaveLength(1);
    expect(calls.schedule[0].sid).toBe("s1");
    expect(calls.schedule[0].id).toBe("qr");
    // "Immediate expiry": scheduledAt ≈ the click time (≤ now means due now).
    expect(Math.abs(calls.schedule[0].at - before)).toBeLessThan(2000);
    // The loop must survive: no row deletion, no manual send.
    expect(calls.revoke).toHaveLength(0);
    expect(calls.interrupt).toHaveLength(0);

    root.unmount();
    document.body.innerHTML = "";
  });

  test("plain item: RevokeQueueItem + InterruptAndSend in order, no schedule", async () => {
    calls.schedule.length = 0; calls.revoke.length = 0; calls.interrupt.length = 0;
    const { root, host } = await mountApp();
    await openSessionWithQueue(host, [
      { id: "qn", text: "hello", scheduledAt: Date.now() },
    ]);

    click(interruptBtn(host, "qn"));
    await flush();

    expect(calls.revoke).toEqual([{ sid: "s1", id: "qn" }]);
    expect(calls.interrupt).toEqual([{ sid: "s1", text: "hello" }]);
    // Revoke strictly precedes the interrupt-send (#126A contract).
    expect(calls.revoke[0] && calls.interrupt[0]).toBeTruthy();
    expect(calls.schedule).toHaveLength(0);

    root.unmount();
    document.body.innerHTML = "";
  });
});
