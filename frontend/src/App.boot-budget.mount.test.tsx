// App-level mount test for the boot request budget (request-storm fix, see
// docs/worklog/2026-09-03-runtime-request-storm-final-plan.md).
//
// Main-window boot (no popout hash) against the REAL App component with the
// backend bindings mocked. The storm under test: the boot session-list loop
// re-fired ListSessions for every project whose response had not landed yet
// (TOCTOU — 7 overlapping rounds, ~163 calls for 31 projects, O(P²) worst
// case). Tests here pin the FIXED budget and the guards' edge semantics.
//
// T1 determinism note: responses are resolved ONE AT A TIME with a flush
// between — naive setTimeout(1) spacing lets React 18 batch same-macrotask
// responses into one commit, making the pre-fix red assertion flaky.

import { describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";

// ---- happy-dom setup (same scaffolding as App.commands-seed.mount.test.tsx) ----
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
  Clipboard: { setText: async () => {}, readText: async () => "" },
}));

class MockResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) { this.cb = cb; }
  observe(_el: Element) {}
  unobserve(_el: Element) {}
  disconnect() {}
}
(globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;

// ---- fixture: 31 projects (matches the real-world project count that made
// the storm visible); a few projects have ZERO sessions on purpose (T2). ----
const PROJECTS = Array.from({ length: 31 }, (_, i) => ({
  id: `p${String(i + 1).padStart(2, "0")}`,
  name: `proj-${i + 1}`,
  path: `/tmp/proj-${i + 1}`,
}));
const sessionsOf = (pid: string) =>
  pid.endsWith("0") // p10/p20/p30 stay empty — 0-session projects must still load
    ? []
    : [{ id: `s-${pid}`, projectId: pid, title: `t-${pid}`, harness: "omp" }];

// ---- call recorder + swappable behavior (stubs close over these) ----
const calls: string[] = [];
type SessionStub = { id: string; projectId: string; title: string; harness: string };
// Per-project FIFO of pending ListSessions resolvers: the pre-fix bug REFIRES
// ListSessions for in-flight projects, so one pid can have several pending
// promises. Resolving only the first of each is enough to land the data.
const pendingResolvers = new Map<string, Array<(v: SessionStub[]) => void>>();
let listSessionsImpl: (pid: string) => Promise<SessionStub[]> = async () => [];
let hasGitContextImpl: (pid: string) => Promise<boolean> = async () => false;

mock.module("./bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => {
  const stubs: Record<string, unknown> = Object.fromEntries([
'AddHarness', 'AddProject', 'BrowseDir', 'BrowseRoots', 'CloseSessionWindow', 'ContinueSession', 'CreateGuestSession', 'CreateMcpServer', 'CreatePermissionRule', 'CreateSession', 'DeleteMcpServer', 'DeletePermissionRule', 'DeleteSession', 'DeleteWorktree', 'DetachWorktreeGuests', 'EditQueueItem', 'EnqueueMessage', 'ExpandSessionWindow', 'ExportSession', 'FocusSessionWindow', 'GenerateRemotePairingCode', 'GetConfig', 'GetLastHarness', 'GetRemoteInfo', 'GetSessionCachedCommands', 'GetSessionCachedConfigOptions', 'GetSessionMcpServers', 'GetSessionProjectID', 'GetSessionSnapshot', 'HasGitContext', 'ImportMcpConfig', 'InterruptAndSend', 'IsGitProject', 'IsSessionWindowPopped', 'ListHarnessCapabilities', 'ListHarnesses', 'ListMcpServers', 'ListPermissionRules', 'ListProjects', 'ListSessions', 'ListUserMessages', 'ListWorktrees', 'LoadMessagesPage', 'MergeSession', 'OpenSession', 'OpenSessionWindow', 'OpenURL', 'PickDirectory', 'PickFiles', 'ProbeNewHarness', 'RecentBaseRefs', 'RefreshHarnesses', 'RefreshSessionConfig', 'RegenerateRemoteToken', 'RemoteListSessions', 'RemoteRevokeSession', 'RemoveProject', 'ReorderPermissionRules', 'ReorderProjects', 'ReorderQueueItem', 'ResetPermissionRules', 'ResolveBaseRefDefault', 'RespondElicitation', 'RespondPermission', 'RevealPath', 'RevokeQueueItem', 'SaveSessionSnapshot', 'ScheduleQueueItem', 'SearchBaseRefs', 'SearchSessionContent', 'SendMessage', 'SessionAICommit', 'SessionChanges', 'SessionCommit', 'SessionCreateDir', 'SessionCreateFile', 'SessionCurrentBranch', 'SessionDeletePath', 'SessionDiscard', 'SessionFileDiff', 'SessionFuzzyFind', 'SessionListDir', 'SessionMergeable', 'SessionReadFile', 'SessionReadImage', 'SessionRenamePath', 'SessionStage', 'SessionStatuses', 'SessionUnstage', 'SessionWriteFile', 'SetAutoHarnessUpgrade', 'SetCheckHarnessUpdates', 'SetQueueItemRepeat', 'SetRemoteEnabled', 'SetRemotePort', 'SetRemotePublicURL', 'SetSessionConfigOption', 'SetSessionPinned', 'SetSessionWindowOnTop', 'ShrinkSessionWindow', 'StopSession', 'ToggleMaximise', 'UpdateMcpServer', 'UpdatePermissionRule', 'UpdateSessionCustomTitle', 'UpdateSessionTags', 'UpdateUserHarness', 'UpgradeHarness', 'WorktreeGuests', 'WorktreeKind',
  ].map((n) => [n, async () => null]));
  stubs.ListProjects = async () => PROJECTS;
  stubs.ListSessions = (pid: string) => {
    calls.push(`ListSessions:${pid}`);
    return listSessionsImpl(pid);
  };
  stubs.HasGitContext = (pid: string) => {
    calls.push(`HasGitContext:${pid}`);
    return hasGitContextImpl(pid);
  };
  stubs.IsSessionWindowPopped = async (sid: string) => {
    calls.push(`IsSessionWindowPopped:${sid}`);
    return false;
  };
  stubs.ListHarnesses = async () => [];
  stubs.SessionStatuses = async () => ({});
  stubs.ListTerminalsBySession = async () => ({});
  return stubs;
});
mock.module("./bindings/github.com/jessonchan/monkey-deck/internal/terminal/terminalservice", () => ({
  ListTerminalsBySession: async () => ({}),
}));
mock.module("react-resizable-panels", () => {
  const div = (props: Record<string, unknown>) => React.createElement("div", props);
  const handle = { collapse: () => {}, expand: () => {}, isCollapsed: () => false, resize: () => {} };
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

// ---- imports AFTER mocks ----
const { default: App } = await import("./App.tsx");

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  }
};

async function mountApp(): Promise<Root> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(React.createElement(App));
  await flush();
  return root;
}

const countCalls = (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length;
const distinctPids = () =>
  new Set(calls.filter((c) => c.startsWith("ListSessions:")).map((c) => c.slice("ListSessions:".length)));

describe("App boot request budget (request-storm fix)", () => {
  test("T1: staggered responses — exactly one ListSessions per project (no refire rounds)", async () => {
    calls.length = 0;
    pendingResolvers.clear();
    listSessionsImpl = (pid) =>
      new Promise<SessionStub[]>((res) => {
        const q = pendingResolvers.get(pid) ?? [];
        q.push(res);
        pendingResolvers.set(pid, q);
      });
    const root = await mountApp();

    // Resolve one project's session list at a time, flushing between each so
    // every landing is its own React commit — the maximal refire interleaving.
    for (const p of PROJECTS) {
      const q = pendingResolvers.get(p.id);
      if (q && q.length > 0) (q.shift()!)(sessionsOf(p.id));
      await flush(1);
    }
    await flush();

    expect(countCalls("ListSessions:")).toBe(31);
    expect(distinctPids().size).toBe(31);
    root.unmount();
    await flush();
    document.body.innerHTML = "";
  });

  test("T2: happy path — every project loads, 0-session projects included", async () => {
    calls.length = 0;
    listSessionsImpl = async (pid) => sessionsOf(pid);
    const root = await mountApp();
    await flush();

    expect(countCalls("ListSessions:")).toBe(31);
    expect(distinctPids().size).toBe(31);
    // 0-session projects (p10/p20/p30) were requested too, not skipped.
    for (const zero of ["p10", "p20", "p30"]) {
      expect(calls).toContain(`ListSessions:${zero}`);
    }
    root.unmount();
    await flush();
    document.body.innerHTML = "";
  });

  test("T3: chat:status prompting forces a refresh that bypasses the boot guard", async () => {
    calls.length = 0;
    listSessionsImpl = async (pid) => sessionsOf(pid);
    const root = await mountApp();
    await flush();
    expect(countCalls("ListSessions:p01")).toBe(1);

    // A prompting turn on a session of p01 must re-pull that project even
    // though it already loaded — event refreshes never go through the boot guard.
    const onStatus = eventHandlers.get("chat:status");
    expect(onStatus).toBeDefined();
    onStatus!({ data: { sessionId: "s-p01", status: "prompting" } });
    await flush();
    expect(countCalls("ListSessions:p01")).toBeGreaterThanOrEqual(2);

    root.unmount();
    await flush();
    document.body.innerHTML = "";
  });

  test("T4: a rejected ListSessions is retried by later effect runs, no unhandled rejection", async () => {
    calls.length = 0;
    pendingResolvers.clear();
    let p02Failures = 0;
    listSessionsImpl = (pid) => {
      if (pid === "p02") {
        p02Failures++;
        if (p02Failures === 1) return Promise.reject(new Error("boom"));
        return Promise.resolve(sessionsOf(pid));
      }
      return new Promise<SessionStub[]>((res) => {
        const q = pendingResolvers.get(pid) ?? [];
        q.push(res);
        pendingResolvers.set(pid, q);
      });
    };
    const root = await mountApp();

    // p02 fails first; every later landing re-runs the effect and the failed
    // project (no longer in-flight) is picked up again.
    for (const p of PROJECTS) {
      if (p.id === "p02") continue;
      const q = pendingResolvers.get(p.id);
      if (q && q.length > 0) (q.shift()!)(sessionsOf(p.id));
      await flush(1);
    }
    await flush();

    expect(calls.filter((c) => c === "ListSessions:p02").length).toBeGreaterThanOrEqual(2);
    // And the rest still loaded exactly once each.
    expect(countCalls("ListSessions:")).toBeLessThanOrEqual(31 + 1); // 31 first round + 1 retry
    root.unmount();
    await flush();
    document.body.innerHTML = "";
  });
});
