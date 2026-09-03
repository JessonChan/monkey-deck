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
// Step-3 fast path stubs: bulk snapshot + batch popout. Default = bulk fixture
// from the same per-project fixture data (mirrors the Go contract: a key for
// EVERY project, empty arrays included). Tests that exercise the per-project
// fallback make the bulk REJECT.
const bulkFixture = (): Record<string, SessionStub[]> =>
  Object.fromEntries(PROJECTS.map((p) => [p.id, sessionsOf(p.id)]));
let listAllSessionsImpl: () => Promise<Record<string, SessionStub[]>> = async () => bulkFixture();
let listPoppedReturn: string[] = [];
let lastPoppedArg: string[] | null = null;

mock.module("./bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => {
  const stubs: Record<string, unknown> = Object.fromEntries([
'AddHarness', 'AddProject', 'BrowseDir', 'BrowseRoots', 'CloseSessionWindow', 'ContinueSession', 'CreateGuestSession', 'CreateMcpServer', 'CreatePermissionRule', 'CreateSession', 'DeleteMcpServer', 'DeletePermissionRule', 'DeleteSession', 'DeleteWorktree', 'DetachWorktreeGuests', 'EditQueueItem', 'EnqueueMessage', 'ExpandSessionWindow', 'ExportSession', 'FocusSessionWindow', 'GenerateRemotePairingCode', 'GetConfig', 'GetLastHarness', 'GetRemoteInfo', 'GetSessionCachedCommands', 'GetSessionCachedConfigOptions', 'GetSessionMcpServers', 'GetSessionProjectID', 'GetSessionSnapshot', 'HasGitContext', 'ImportMcpConfig', 'InterruptAndSend', 'IsGitProject', 'IsSessionWindowPopped', 'ListHarnessCapabilities', 'ListHarnesses', 'ListMcpServers', 'ListPermissionRules', 'ListProjects', 'ListSessions', 'ListUserMessages', 'ListWorktrees', 'LoadMessagesPage', 'MergeSession', 'OpenSession', 'OpenSessionWindow', 'OpenURL', 'PickDirectory', 'PickFiles', 'ProbeNewHarness', 'RecentBaseRefs', 'RefreshHarnesses', 'RefreshSessionConfig', 'RegenerateRemoteToken', 'RemoteListSessions', 'RemoteRevokeSession', 'RemoveProject', 'ReorderPermissionRules', 'ReorderProjects', 'ReorderQueueItem', 'ResetPermissionRules', 'ResolveBaseRefDefault', 'RespondElicitation', 'RespondPermission', 'RevealPath', 'RevokeQueueItem', 'SaveSessionSnapshot', 'ScheduleQueueItem', 'SearchBaseRefs', 'SearchSessionContent', 'SendMessage', 'SessionAICommit', 'SessionChanges', 'SessionCommit', 'SessionCreateDir', 'SessionCreateFile', 'SessionCurrentBranch', 'SessionDeletePath', 'SessionDiscard', 'SessionFileDiff', 'SessionFuzzyFind', 'SessionListDir', 'SessionMergeable', 'SessionReadFile', 'SessionReadImage', 'SessionRenamePath', 'SessionStage', 'SessionStatuses', 'SessionUnstage', 'SessionWriteFile', 'SetAutoHarnessUpgrade', 'SetCheckHarnessUpdates', 'SetQueueItemRepeat', 'SetRemoteEnabled', 'SetRemotePort', 'SetRemotePublicURL', 'SetSessionConfigOption', 'SetSessionPinned', 'SetSessionWindowOnTop', 'ShrinkSessionWindow', 'StopSession', 'ToggleMaximise', 'UpdateMcpServer', 'UpdatePermissionRule', 'UpdateSessionCustomTitle', 'UpdateSessionTags', 'UpdateUserHarness', 'UpgradeHarness', 'WorktreeGuests', 'WorktreeKind',
  ].map((n) => [n, async () => null]));
  stubs.ListProjects = async () => PROJECTS;
  stubs.ListSessions = (pid: string) => {
    calls.push(`ListSessions:${pid}`);
    return listSessionsImpl(pid);
  };
  stubs.ListAllSessions = () => {
    calls.push("ListAllSessions");
    return listAllSessionsImpl();
  };
  stubs.ListPoppedSessions = async (sids: string[]) => {
    calls.push(`ListPoppedSessions:${sids.length}`);
    lastPoppedArg = sids;
    return listPoppedReturn;
  };
  stubs.HasGitContext = (pid: string) => {
    calls.push(`HasGitContext:${pid}`);
    return hasGitContextImpl(pid);
  };
  stubs.IsGitProject = async (pid: string) => {
    calls.push(`IsGitProject:${pid}`);
    return false;
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

const clickProject = async (pid: string) => {
  const el = document.querySelector(`[data-testid="project-${pid}"]`) as HTMLElement | null;
  if (!el) throw new Error(`project row not found: ${pid}`);
  el.click();
  await flush();
};

describe("App boot request budget (request-storm fix)", () => {
  test("T1: bulk down + staggered responses — exactly one ListSessions per project", async () => {
    calls.length = 0;
    pendingResolvers.clear();
    listAllSessionsImpl = async () => { throw new Error("bulk down"); };
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

  test("T2: happy path — one bulk snapshot fills everything, fallback stays silent", async () => {
    calls.length = 0;
    listAllSessionsImpl = async () => bulkFixture();
    listSessionsImpl = async (pid) => sessionsOf(pid);
    const root = await mountApp();
    await flush();

    // The fast path is the ONLY session-list request; the per-project loop
    // fires zero calls because every key landed in one commit.
    expect(countCalls("ListAllSessions")).toBe(1);
    expect(countCalls("ListSessions:")).toBe(0);
    // Completeness: the reconcile fired (allLoaded was true) and asked about
    // every session (28 = 31 projects − 3 empty ones) in ONE bulk call.
    expect(calls.filter((c) => c.startsWith("ListPoppedSessions:")).length).toBe(1);
    expect(lastPoppedArg?.length).toBe(28);
    root.unmount();
    await flush();
    document.body.innerHTML = "";
  });

  test("T3: chat:status prompting forces a refresh that bypasses the boot guard", async () => {
    calls.length = 0;
    listAllSessionsImpl = async () => bulkFixture();
    listSessionsImpl = async (pid) => sessionsOf(pid);
    const root = await mountApp();
    await flush();
    expect(countCalls("ListSessions:p01")).toBe(0);

    // A prompting turn on a session of p01 must re-pull that project even
    // though the bulk snapshot already loaded it — event refreshes never go
    // through the boot guard.
    const onStatus = eventHandlers.get("chat:status");
    expect(onStatus).toBeDefined();
    onStatus!({ data: { sessionId: "s-p01", status: "prompting" } });
    await flush();
    expect(countCalls("ListSessions:p01")).toBeGreaterThanOrEqual(1);

    root.unmount();
    await flush();
    document.body.innerHTML = "";
  });

  test("T4: bulk down + a rejected ListSessions is retried, no unhandled rejection", async () => {
    calls.length = 0;
    pendingResolvers.clear();
    listAllSessionsImpl = async () => { throw new Error("bulk down"); };
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

  test("T5: bulk snapshot and per-project loads produce the identical session sequence", async () => {
    // p01 gets two sessions, pinned first — order must survive both paths.
    const withPinned = (pid: string): SessionStub[] =>
      pid === "p01"
        ? [
            { id: "s-p01-pin", projectId: pid, title: "pinned", harness: "omp" },
            ...sessionsOf(pid),
          ]
        : sessionsOf(pid);
    const bulkMap = Object.fromEntries(PROJECTS.map((p) => [p.id, withPinned(p.id)]));

    // Mode A: bulk snapshot.
    calls.length = 0;
    lastPoppedArg = null;
    listAllSessionsImpl = async () => bulkMap;
    listSessionsImpl = async (pid) => withPinned(pid);
    const rootA = await mountApp();
    await flush();
    const seqA = lastPoppedArg ?? [];
    rootA.unmount();
    await flush();
    document.body.innerHTML = "";

    // Mode B: bulk down, per-project loads in project order.
    calls.length = 0;
    lastPoppedArg = null;
    listAllSessionsImpl = async () => { throw new Error("bulk down"); };
    const rootB = await mountApp();
    for (const p of PROJECTS) {
      const q = pendingResolvers.get(p.id);
      if (q && q.length > 0) (q.shift()!)(withPinned(p.id));
      await flush(1);
    }
    await flush();
    const seqB = lastPoppedArg ?? [];
    rootB.unmount();
    await flush();
    document.body.innerHTML = "";

    expect(seqB.length).toBe(seqA.length);
    expect(seqB).toEqual(seqA);
    // The pinned session of p01 leads its bucket in both modes.
    expect(seqA[0]).toBe("s-p01-pin");
  });

  test("T6: boot reconcile batches — IsSessionWindowPopped never fires", async () => {
    calls.length = 0;
    listAllSessionsImpl = async () => bulkFixture();
    const root = await mountApp();
    await flush();

    // happy-dom is not a remote client, so the reconcile DOES run here — and
    // must use exactly one bulk call instead of one RPC per session (432 on
    // the real dataset).
    expect(countCalls("IsSessionWindowPopped:")).toBe(0);
    expect(calls.filter((c) => c.startsWith("ListPoppedSessions:")).length).toBe(1);
    root.unmount();
    await flush();
    document.body.innerHTML = "";
  });

  test("T7: bulk snapshot failure falls back to the per-project loop (all 31 load)", async () => {
    calls.length = 0;
    pendingResolvers.clear();
    listAllSessionsImpl = async () => { throw new Error("bulk down"); };
    listSessionsImpl = async (pid) => sessionsOf(pid);
    const root = await mountApp();
    await flush();

    expect(countCalls("ListSessions:")).toBe(31);
    expect(distinctPids().size).toBe(31);
    root.unmount();
    await flush();
    document.body.innerHTML = "";
  });

  test("T13: reconcile seeds poppedSessionIds — popped session hidden, sibling visible", async () => {
    calls.length = 0;
    localStorage.setItem("md:sidebar-expanded", JSON.stringify(["p01", "p02"]));
    listAllSessionsImpl = async () => bulkFixture();
    listPoppedReturn = ["s-p01"];
    const root = await mountApp();
    await flush();

    expect(calls.filter((c) => c.startsWith("ListPoppedSessions:")).length).toBe(1);
    // poppedSessionIds seeded from the bulk reply: the popped session's row
    // carries the popout marker, its sibling's does not.
    expect(document.querySelector('[data-testid="popout-s-p01"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="popout-s-p02"]')).toBeNull();

    root.unmount();
    await flush();
    document.body.innerHTML = "";
    localStorage.removeItem("md:sidebar-expanded");
    listPoppedReturn = [];
  });

  test("T9: no boot git fan-out; selection probes once and true is cached", async () => {
    calls.length = 0;
    const gitTrue = new Set(["p01"]);
    hasGitContextImpl = async (pid) => gitTrue.has(pid);
    listSessionsImpl = async (pid) => sessionsOf(pid);
    const root = await mountApp();
    await flush();

    // Boot must not probe ANY project (the old code probed all 31 here).
    expect(countCalls("HasGitContext:")).toBe(0);

    await clickProject("p01");
    expect(calls.filter((c) => c === "HasGitContext:p01").length).toBe(1);
    // Re-selecting a known-true project skips the probe (R4 cache semantics).
    await clickProject("p01");
    expect(calls.filter((c) => c === "HasGitContext:p01").length).toBe(1);

    root.unmount();
    await flush();
    document.body.innerHTML = "";
  });

  test("T10: non-git projects re-probe per selection (false is not cached)", async () => {
    calls.length = 0;
    hasGitContextImpl = async () => false;
    listSessionsImpl = async (pid) => sessionsOf(pid);
    const root = await mountApp();
    await flush();

    await clickProject("p02");
    expect(calls.filter((c) => c === "HasGitContext:p02").length).toBe(1);
    await clickProject("p03");
    await clickProject("p02");
    // p02 selected twice → probed twice (agents may git init between selections).
    expect(calls.filter((c) => c === "HasGitContext:p02").length).toBe(2);
    expect(calls.filter((c) => c === "HasGitContext:p03").length).toBe(1);

    root.unmount();
    await flush();
    document.body.innerHTML = "";
  });

  test("T11: in-flight probe dedup — double-click while pending fires one request", async () => {
    calls.length = 0;
    const pendingGit = new Map<string, (v: boolean) => void>();
    hasGitContextImpl = (pid) =>
      new Promise<boolean>((res) => {
        if (!pendingGit.has(pid)) pendingGit.set(pid, res);
      });
    listSessionsImpl = async (pid) => sessionsOf(pid);
    const root = await mountApp();
    await flush();

    await clickProject("p04");
    await clickProject("p04"); // still pending → dropped
    expect(calls.filter((c) => c === "HasGitContext:p04").length).toBe(1);
    pendingGit.get("p04")!(true);
    await flush();
    await clickProject("p04"); // now true-cached → still 1
    expect(calls.filter((c) => c === "HasGitContext:p04").length).toBe(1);

    root.unmount();
    await flush();
    document.body.innerHTML = "";
  });

  test("T12: selection never touches the STRICT worktree gate (IsGitProject)", async () => {
    calls.length = 0;
    hasGitContextImpl = async () => true;
    listSessionsImpl = async (pid) => sessionsOf(pid);
    const root = await mountApp();
    await flush();
    await clickProject("p01");
    await clickProject("p02");
    await clickProject("p01");
    // IsGitProject is createSession's on-demand strict gate — not the boot or
    // selection path.
    expect(countCalls("IsGitProject:")).toBe(0);

    root.unmount();
    await flush();
    document.body.innerHTML = "";
  });
});
