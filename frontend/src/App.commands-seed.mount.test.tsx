// App-level mount test for the slash command cache seed (#152).
//
// Exercises the REAL App component (popout boot = openSession trigger, same as
// backend OpenSessionWindow) with the backend bindings mocked:
//   1. Seed: first open reads sessions.commands_cache via GetSessionCachedCommands
//      and the slash menu renders the cached table (value "/" opens the palette —
//      pure derivation from value + commands, no focus needed).
//   2. Only-once: a re-open of the same session (remote:resync path — the real
//      re-open trigger) must NOT re-read the DB (commandsSeededRef guard).
//   3. Event overwrite: an available_commands chat:event replaces the in-memory
//      table (applyEvent branch, full-table replace).
//   4. Restart simulation + no frontend write: a SECOND fresh mount re-seeds the
//      ORIGINAL cache — if the frontend had written the overwritten table back,
//      mount 2 would seed the overwritten one. The mock holder never changes, so
//      seeding the original table proves the frontend never participates in writes.
//
// Composer palette semantics are covered in Composer.mount.test.tsx; here we only
// pin App's seed/overwrite wiring (the :170 state, seed block, :336 branch, :478
// derived slice).
//
// NOTE: App (and the binding modules it transitively imports) is imported
// dynamically AFTER mock.module registration on purpose — a static import would
// evaluate the real binding modules before the mocks replace them (same
// scaffolding as ChatView.sidedrawer.mount.test.tsx).

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

// Popout boot: App opens the target session on mount (backend normally creates
// this window with the hash; here it is the deterministic openSession trigger).
window.location.hash = "#popout=s1";
// Mock by RESOLVED path: bare-specifier mocks do not reliably intercept the
// same module when imported transitively by first-party code (lib/clipboard,
// lib/termRegistry) — the resolved absolute path matches every importer.
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

// ---- ResizeObserver mock: panels/ChatView measure on mount ----
class MockResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) { this.cb = cb; }
  observe(_el: Element) {}
  unobserve(_el: Element) {}
  disconnect() {}
}
(globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;
const eventHandlers = new Map<string, (e: unknown) => void>();
// Mock by RESOLVED path: bare-specifier mocks do not reliably intercept the
// same module when imported transitively by first-party code (lib/clipboard,
// lib/termRegistry) — the resolved absolute path matches every importer.
// ---- mock backend bindings ----
// The commands cache holder never changes across mounts: mount 2 re-seeding the
// ORIGINAL table is the observable proof that the frontend never wrote the
// event-overwritten table back to the backend (#152: 前端不参与写).
const CACHED_COMMANDS = [
  { name: "model", description: "Show model", inputHint: "[on|off]" },
  { name: "test", description: "Run tests" },
];
const calls: string[] = [];
// Any binding not explicitly stubbed auto-resolves to a benign async stub via the
// Proxy — App's mount/open graph touches ~120 bindings and only a handful matter
// here; the explicit entries below carry the test-relevant behavior.
// Every ChatService binding App's graph may touch, auto-stubbed benignly; the
// handful under test get explicit behavior below. (A static map, because bun
// materializes the mocked module namespace eagerly — Proxy traps are lost.)
mock.module("./bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => {
  const stubs: Record<string, unknown> = Object.fromEntries([
'AddHarness', 'AddProject', 'BrowseDir', 'BrowseRoots', 'CloseSessionWindow', 'ContinueSession', 'CreateGuestSession', 'CreateMcpServer', 'CreatePermissionRule', 'CreateSession', 'DeleteMcpServer', 'DeletePermissionRule', 'DeleteSession', 'DeleteWorktree', 'DetachWorktreeGuests', 'EditQueueItem', 'EnqueueMessage', 'ExpandSessionWindow', 'ExportSession', 'FocusSessionWindow', 'GenerateRemotePairingCode', 'GetConfig', 'GetLastHarness', 'GetRemoteInfo', 'GetSessionCachedCommands', 'GetSessionCachedConfigOptions', 'GetSessionMcpServers', 'GetSessionProjectID', 'GetSessionSnapshot', 'HasGitContext', 'ImportMcpConfig', 'InterruptAndSend', 'IsGitProject', 'IsSessionWindowPopped', 'ListHarnessCapabilities', 'ListHarnesses', 'ListMcpServers', 'ListPermissionRules', 'ListProjects', 'ListSessions', 'ListUserMessages', 'ListWorktrees', 'LoadMessagesPage', 'MergeSession', 'OpenSession', 'OpenSessionWindow', 'OpenURL', 'PickDirectory', 'PickFiles', 'ProbeNewHarness', 'RecentBaseRefs', 'RefreshHarnesses', 'RefreshSessionConfig', 'RegenerateRemoteToken', 'RemoteListSessions', 'RemoteRevokeSession', 'RemoveProject', 'ReorderPermissionRules', 'ReorderProjects', 'ReorderQueueItem', 'ResetPermissionRules', 'ResolveBaseRefDefault', 'RespondElicitation', 'RespondPermission', 'RevealPath', 'RevokeQueueItem', 'SaveSessionSnapshot', 'ScheduleQueueItem', 'SearchBaseRefs', 'SearchSessionContent', 'SendMessage', 'SessionAICommit', 'SessionChanges', 'SessionCommit', 'SessionCreateDir', 'SessionCreateFile', 'SessionCurrentBranch', 'SessionDeletePath', 'SessionDiff', 'SessionDiscard', 'SessionFileDiff', 'SessionFuzzyFind', 'SessionListDir', 'SessionMergeable', 'SessionReadFile', 'SessionReadImage', 'SessionRenamePath', 'SessionStage', 'SessionStatuses', 'SessionUnstage', 'SessionWriteFile', 'SetAutoHarnessUpgrade', 'SetCheckHarnessUpdates', 'SetQueueItemRepeat', 'SetRemoteEnabled', 'SetRemotePort', 'SetRemotePublicURL', 'SetSessionConfigOption', 'SetSessionPinned', 'SetSessionWindowOnTop', 'ShrinkSessionWindow', 'StopSession', 'ToggleMaximise', 'UpdateMcpServer', 'UpdatePermissionRule', 'UpdateSessionCustomTitle', 'UpdateSessionTags', 'UpdateUserHarness', 'UpgradeHarness', 'WorktreeGuests', 'WorktreeKind',
  ].map((n) => [n, async () => null]));
  // --- explicit behavior for the bindings under test ---
  stubs.GetSessionProjectID = async () => "p1";
  stubs.OpenSession = async () => { calls.push("OpenSession"); return null; };
  stubs.SessionStatuses = async () => ({});
  stubs.ListProjects = async () => [{ id: "p1", name: "demo", path: "/tmp/demo" }];
  stubs.HasGitContext = async () => false;
  stubs.ListSessions = async () => [{ id: "s1", projectId: "p1", title: "t", harness: "omp" }];
  stubs.ListHarnesses = async () => [];
  stubs.LoadMessagesPage = async () => [];
  stubs.ListUserMessages = async () => [];
  stubs.GetSessionCachedConfigOptions = async () => [];
  stubs.GetSessionCachedCommands = async () => {
    calls.push("GetSessionCachedCommands");
    return CACHED_COMMANDS;
  };
  stubs.GetSessionSnapshot = async () => JSON.stringify({ draft: "/" });
  stubs.SessionChanges = async () => null;
  stubs.SessionCurrentBranch = async () => "";
  stubs.SessionMergeable = async () => false;
  stubs.WorktreeKind = async () => "project";
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

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  }
};

function paletteCommands(): string[] {
  return [...document.querySelectorAll('[data-testid="slash-popover"] .slash-item .slash-cmd')]
    .map((el) => el.textContent || "");
}

async function mountApp(): Promise<Root> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(React.createElement(App));
  await flush();
  return root;
}

describe("App slash command cache seed (#152)", () => {
  test("mount seeds cache once → event overwrites → remount re-seeds original", async () => {
    // ---- Mount 1 (restart simulation) ----
    const root1 = await mountApp();

    // Seed: exactly one read for the first open, and the palette shows the cached table.
    expect(calls.filter((c) => c === "GetSessionCachedCommands").length).toBe(1);
    expect(paletteCommands()).toEqual(["/model", "/test"]);

    // Only-once: remote:resync re-opens the session (real path) — no second DB read.
    const resync = eventHandlers.get("remote:resync");
    expect(resync).toBeDefined();
    resync!({ data: {} });
    await flush();
    expect(calls.filter((c) => c === "GetSessionCachedCommands").length).toBe(1);

    // Event overwrite: available_commands full-table replaces the in-memory table.
    const onEvent = eventHandlers.get("chat:event");
    expect(onEvent).toBeDefined();
    onEvent!({ data: { kind: "available_commands", sessionId: "s1", commands: [
      { name: "fast", description: "Toggle fast mode" },
      { name: "new", description: "New task" },
    ] } });
    await flush();
    expect(paletteCommands()).toEqual(["/fast", "/new"]);

    root1.unmount();
    await flush();

    // ---- Mount 2 (fresh App = fresh refs; backend store unchanged) ----
    const root2 = await mountApp();
    // Second read: the restart re-seeds (per-mount ref, not module-global).
    expect(calls.filter((c) => c === "GetSessionCachedCommands").length).toBe(2);
    // The re-seeded table is the ORIGINAL cache — the frontend never wrote the
    // overwritten table back (writes are handler-direct on the backend only).
    expect(paletteCommands()).toEqual(["/model", "/test"]);

    root2.unmount();
    document.body.innerHTML = "";
  });
});
