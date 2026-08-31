// App-level mount tests for panel layout persistence (#157).
//
// Exercises the REAL App component with the REAL react-resizable-panels
// useDefaultLayout hook — only Group/Panel/Separator/usePanelRef are mocked
// (the real components need a layout engine; the persistence seam under test
// runs for real through the storage object App passes). Assertions:
//  1. Popout isolation: a popout window neither reads nor writes the layout
//     storage key (react-resizable-panels:monkey-deck-layout) nor
//     md:panel-collapsed — even when a user-interaction layout save and
//     collapse/expand toggles fire. Popout keeps its defaults (attr
//     data-sidebar-collapsed="popout", right panel collapsed).
//  2. Main window: rail-toggle collapses persist to md:panel-collapsed as
//     JSON {"left":bool,"right":bool}; expand rewrites it; a user-interaction
//     layout save still lands in the layout key (contrast with popout).
//  3. Reload restore: a seeded md:panel-collapsed re-collapses the matching
//     panels at mount via the imperative collapse() path (recorded on the
//     mocked panel handles + data-sidebar-collapsed/data-side-collapsed);
//     corrupt values fall back to expanded without crashing.
//  4. Narrow-window (750px) auto-collapse at mount is unchanged.
//
// Scaffolding mirrors App.tab-limit.mount.test.tsx: mocks are registered
// BEFORE the dynamic App import — a static import would evaluate the real
// binding modules before the mocks replace them.
import { describe, test, expect, mock } from "bun:test";
import React, { type Root } from "react";
import { createRoot } from "react-dom/client";
import { Window, type Storage } from "happy-dom";

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
window.React = React;

// Fake localStorage with call recording (happy-dom's Storage instance cannot
// be spied on — method assignment is ignored). BOTH the real useDefaultLayout
// hook (default storage) and App's md:* persistence resolve
// globalThis.localStorage at call time, so the fake sees every access.
const storageCalls: { get: string[]; set: string[] } = { get: [], set: [] };
const storageMap = new Map<string, string>();
const fakeStorage: Storage = {
  get length() { return storageMap.size; },
  key: (i: number) => [...storageMap.keys()][i] ?? null,
  getItem: (k: string) => {
    storageCalls.get.push(k);
    return storageMap.has(k) ? storageMap.get(k)! : null;
  },
  setItem: (k: string, v: string) => {
    storageCalls.set.push(k);
    storageMap.set(k, String(v));
  },
  removeItem: (k: string) => { storageMap.delete(k); },
  clear: () => { storageMap.clear(); },
};
globalThis.localStorage = fakeStorage;

// Storage keys under test (literals per #157 spec + lib key derivation).
const LAYOUT_KEY = "react-resizable-panels:monkey-deck-layout";
const COLLAPSED_KEY = "md:panel-collapsed";

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
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

// ---- mock backend bindings ----
// Any binding App's mount graph touches resolves to a benign async stub —
// openSession is fully null-tolerant, so no session data is needed here.
// Mirrors App.tab-limit.mount.test.tsx.
mock.module("./bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => {
  const stubs: Record<string, unknown> = Object.fromEntries([
    'AddHarness', 'AddProject', 'BrowseDir', 'BrowseRoots', 'CloseSessionWindow', 'ContinueSession', 'CreateGuestSession', 'CreateMcpServer', 'CreatePermissionRule', 'CreateSession', 'DeleteMcpServer', 'DeletePermissionRule', 'DeleteSession', 'DeleteWorktree', 'DetachWorktreeGuests', 'EditQueueItem', 'EnqueueMessage', 'ExpandSessionWindow', 'ExportSession', 'FocusSessionWindow', 'GenerateRemotePairingCode', 'GetConfig', 'GetLastHarness', 'GetRemoteInfo', 'GetSessionCachedCommands', 'GetSessionCachedConfigOptions', 'GetSessionMcpServers', 'GetSessionProjectID', 'GetSessionSnapshot', 'HasGitContext', 'ImportMcpConfig', 'InterruptAndSend', 'IsGitProject', 'IsSessionWindowPopped', 'ListHarnessCapabilities', 'ListHarnesses', 'ListMcpServers', 'ListPermissionRules', 'ListProjects', 'ListSessions', 'ListUserMessages', 'ListWorktrees', 'LoadMessagesPage', 'MergeSession', 'OpenSession', 'OpenSessionWindow', 'OpenURL', 'PickDirectory', 'PickFiles', 'ProbeNewHarness', 'RecentBaseRefs', 'RefreshHarnesses', 'RefreshSessionConfig', 'RegenerateRemoteToken', 'RemoteListSessions', 'RemoteRevokeSession', 'RemoveProject', 'ReorderPermissionRules', 'ReorderProjects', 'ReorderQueueItem', 'ResetPermissionRules', 'ResolveBaseRefDefault', 'RespondElicitation', 'RespondPermission', 'RevealPath', 'RevokeQueueItem', 'SaveSessionSnapshot', 'ScheduleQueueItem', 'SearchBaseRefs', 'SearchSessionContent', 'SendMessage', 'SessionAICommit', 'SessionChanges', 'SessionCommit', 'SessionCreateDir', 'SessionCreateFile', 'SessionCurrentBranch', 'SessionDeletePath', 'SessionDiscard', 'SessionFileDiff', 'SessionFuzzyFind', 'SessionListDir', 'SessionMergeable', 'SessionReadFile', 'SessionReadImage', 'SessionRenamePath', 'SessionStage', 'SessionStatuses', 'SessionUnstage', 'SessionWriteFile', 'SetAutoHarnessUpgrade', 'SetCheckHarnessUpdates', 'SetQueueItemRepeat', 'SetRemoteEnabled', 'SetRemotePort', 'SetRemotePublicURL', 'SetSessionConfigOption', 'SetSessionPinned', 'SetSessionWindowOnTop', 'ShrinkSessionWindow', 'StopSession', 'ToggleMaximise', 'UpdateMcpServer', 'UpdatePermissionRule', 'UpdateSessionCustomTitle', 'UpdateSessionTags', 'UpdateUserHarness', 'UpgradeHarness', 'WorktreeGuests', 'WorktreeKind',
  ].map((n) => [n, async () => null]));
  stubs.ListProjects = async () => [{ id: "p1", name: "demo", path: "/tmp/demo" }];
  stubs.ListSessions = async () => [];
  stubs.ListHarnesses = async () => [];
  stubs.SessionStatuses = async () => ({});
  return stubs;
});
mock.module("./bindings/github.com/jessonchan/monkey-deck/internal/terminal/terminalservice", () => ({
  ListTerminalsBySession: async () => [],
}));

// ---- react-resizable-panels: mock the COMPONENTS, keep the REAL hook ----
// The real Group/Panel measure the DOM and imperative collapse() throws
// "Group not found" under happy-dom (no layout engine), so components render
// as plain divs with a stateful imperative handle that drives the same
// onResize → syncCollapsed path the library uses. useDefaultLayout stays
// REAL: it is the persistence seam under test — App's popout isolation
// (noop storage) only shows up if the hook actually reads/writes through
// the storage App passes.
const realPanels = await import("react-resizable-panels");

interface MockHandle {
  collapsed: boolean;
  calls: string[];
  onResize: (() => void) | null;
  collapse(): void;
  expand(): void;
  isCollapsed(): boolean;
}

const makeHandle = (): MockHandle => {
  const h: MockHandle = {
    collapsed: false,
    calls: [],
    onResize: null,
    collapse() {
      h.collapsed = true;
      h.calls.push("collapse");
      if (h.onResize) h.onResize();
    },
    expand() {
      h.collapsed = false;
      h.calls.push("expand");
      if (h.onResize) h.onResize();
    },
    isCollapsed() { return h.collapsed; },
  };
  return h;
};

// Creation order per mount: App calls usePanelRef() for the left sidebar
// first, then the right side panel → slice(base)[0] / [1].
const panelHandles: MockHandle[] = [];
let groupProps: Record<string, unknown> | null = null;

mock.module("react-resizable-panels", () => ({
  ...realPanels,
  Group: (props: Record<string, unknown>) => {
    groupProps = props;
    return React.createElement("div", props);
  },
  Panel: (props: Record<string, unknown>) => {
    const ref = props.panelRef as { current: MockHandle | null } | undefined;
    if (ref && ref.current) ref.current.onResize = (props.onResize as (() => void) | undefined) ?? null;
    return React.createElement("div", props);
  },
  Separator: () => null,
  usePanelRef: () => {
    const ref = React.useRef<MockHandle | null>(null);
    if (!ref.current) {
      ref.current = makeHandle();
      panelHandles.push(ref.current);
    }
    return ref;
  },
}));

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

async function mountApp(popoutSid: string | null): Promise<{ root: Root; host: HTMLElement }> {
  window.location.hash = popoutSid ? `#popout=${popoutSid}` : "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(React.createElement(App));
  await flush();
  return { root, host };
}

function resetStorage() {
  storageMap.clear();
  storageCalls.get.length = 0;
  storageCalls.set.length = 0;
}

function groupProp(key: string): unknown {
  if (!groupProps) throw new Error("Group not mounted yet");
  return groupProps[key];
}

type OnLayoutChangedFn = (layout: Record<string, number>, meta: { isUserInteraction: boolean }) => void;

// Drive a user-interaction layout save through the REAL hook (what a
// separator drag produces in the real library).
function driveLayoutSave(layout: Record<string, number>) {
  const cb = groupProp("onLayoutChanged") as OnLayoutChangedFn | undefined;
  if (!cb) throw new Error("onLayoutChanged not wired on Group");
  cb(layout, { isUserInteraction: true });
}

function click(el: Element) {
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
}

function attr(host: HTMLElement, name: string): string {
  const el = host.querySelector(`[${name}]`);
  if (!el) throw new Error(`missing [${name}] attribute holder`);
  return el.getAttribute(name)!;
}
function byTestId(host: HTMLElement, id: string): HTMLElement {
  const el = host.querySelector(`[data-testid="${id}"]`);
  if (!el) throw new Error(`missing [data-testid="${id}"]`);
  return el as HTMLElement;
}

describe("App panel layout persistence (#157)", () => {
  test("popout reads/writes neither the layout key nor md:panel-collapsed", async () => {
    resetStorage();
    // Seed a VALID layout (all numeric values): if the real hook ever read
    // this key it would surface it as defaultLayout — undefined proves no read.
    const seeded = JSON.stringify({ sidebar: 18, "chat-area": 82 });
    storageMap.set(LAYOUT_KEY, seeded);
    const base = panelHandles.length;
    const { root, host } = await mountApp("s1");
    const h = panelHandles.slice(base);

    // No read: defaultLayout stays undefined despite the seeded valid layout.
    expect(groupProp("defaultLayout")).toBeUndefined();
    // Popout defaults intact: no left sidebar (attr "popout"), right collapsed.
    expect(attr(host, "data-sidebar-collapsed")).toBe("popout");
    expect(attr(host, "data-side-collapsed")).toBe("true");
    expect(h[1].calls).toContain("collapse");

    // A user-interaction layout save attempt lands nowhere.
    driveLayoutSave({ "chat-area": 100 });
    await flush();
    expect(storageMap.get(LAYOUT_KEY)).toBe(seeded);

    // Collapse/expand toggles (the main-window write path) never write the key.
    click(byTestId(host, "expand-side"));
    await flush();
    expect(attr(host, "data-side-collapsed")).toBe("false");
    expect(storageMap.get(COLLAPSED_KEY)).toBeUndefined();
    click(byTestId(host, "collapse-side"));
    await flush();
    expect(attr(host, "data-side-collapsed")).toBe("true");

    // Spy sweep: the layout key family and md:panel-collapsed were never touched.
    expect(storageCalls.get.filter((k) => k.includes("monkey-deck-layout"))).toEqual([]);
    expect(storageCalls.set.filter((k) => k.includes("monkey-deck-layout"))).toEqual([]);
    expect(storageCalls.get).not.toContain(COLLAPSED_KEY);
    expect(storageCalls.set).not.toContain(COLLAPSED_KEY);
    root.unmount();
  });

  test("main window reads the seeded layout and persists collapses to md:panel-collapsed", async () => {
    resetStorage();
    // Control for the popout no-read assertion: the main window DOES read.
    storageMap.set(LAYOUT_KEY, JSON.stringify({ sidebar: 18, "chat-area": 82 }));
    const { root, host } = await mountApp(null);

    expect(groupProp("defaultLayout")).toEqual({ sidebar: 18, "chat-area": 82 });
    expect(attr(host, "data-sidebar-collapsed")).toBe("false");
    expect(attr(host, "data-side-collapsed")).toBe("false");

    // Left rail toggle → key written with left:true.
    click(byTestId(host, "collapse-sidebar"));
    await flush();
    expect(attr(host, "data-sidebar-collapsed")).toBe("true");
    expect(storageMap.get(COLLAPSED_KEY)).toBe('{"left":true,"right":false}');

    // Right rail toggle → right:true.
    click(byTestId(host, "collapse-side"));
    await flush();
    expect(attr(host, "data-side-collapsed")).toBe("true");
    expect(storageMap.get(COLLAPSED_KEY)).toBe('{"left":true,"right":true}');

    // Expanding rewrites the key.
    click(byTestId(host, "expand-side"));
    await flush();
    expect(storageMap.get(COLLAPSED_KEY)).toBe('{"left":true,"right":false}');
    click(byTestId(host, "expand-sidebar"));
    await flush();
    expect(storageMap.get(COLLAPSED_KEY)).toBe('{"left":false,"right":false}');

    // Contrast with popout: a user-interaction layout save DOES persist here.
    driveLayoutSave({ sidebar: 25, "chat-area": 75 });
    await flush();
    expect(storageMap.get(LAYOUT_KEY)).toBe('{"sidebar":25,"chat-area":75}');
    root.unmount();
  });

  test("seeded md:panel-collapsed restores at mount through imperative collapse()", async () => {
    resetStorage();
    storageMap.set(COLLAPSED_KEY, '{"left":true,"right":false}');
    const base = panelHandles.length;
    const m1 = await mountApp(null);
    const h1 = panelHandles.slice(base);

    // Restore goes through the imperative collapse() path (recorded on the
    // handle), left only — and the visible attrs follow.
    expect(h1[0].calls).toContain("collapse");
    expect(h1[1].calls).toEqual([]);
    expect(attr(m1.host, "data-sidebar-collapsed")).toBe("true");
    expect(attr(m1.host, "data-side-collapsed")).toBe("false");
    // Round-trip: the write effect re-persists the restored value.
    expect(storageMap.get(COLLAPSED_KEY)).toBe('{"left":true,"right":false}');
    m1.root.unmount();

    // Reload simulation: a second mount on the same storage restores again.
    const base2 = panelHandles.length;
    const m2 = await mountApp(null);
    const h2 = panelHandles.slice(base2);
    expect(h2[0].calls).toContain("collapse");
    expect(attr(m2.host, "data-sidebar-collapsed")).toBe("true");
    m2.root.unmount();

    // Right-only variant: right panel restored, left untouched.
    resetStorage();
    storageMap.set(COLLAPSED_KEY, '{"left":false,"right":true}');
    const base3 = panelHandles.length;
    const m3 = await mountApp(null);
    const h3 = panelHandles.slice(base3);
    expect(h3[1].calls).toContain("collapse");
    expect(h3[0].calls).toEqual([]);
    expect(attr(m3.host, "data-side-collapsed")).toBe("true");
    expect(attr(m3.host, "data-sidebar-collapsed")).toBe("false");
    m3.root.unmount();
  });

  test("corrupt md:panel-collapsed falls back to expanded without crashing", async () => {
    resetStorage();
    storageMap.set(COLLAPSED_KEY, "{not json");
    const base = panelHandles.length;
    const { root, host } = await mountApp(null);
    const h = panelHandles.slice(base);
    expect(h[0].calls).toEqual([]);
    expect(h[1].calls).toEqual([]);
    expect(attr(host, "data-sidebar-collapsed")).toBe("false");
    expect(attr(host, "data-side-collapsed")).toBe("false");
    root.unmount();
  });

  test("750px narrow-window auto-collapse at mount is unchanged", async () => {
    resetStorage();
    const happy = (window as Window & { happyDOM?: { setViewport?: (v: { width: number }) => void } }).happyDOM;
    if (!happy?.setViewport) throw new Error("happyDOM.setViewport unavailable");
    happy.setViewport({ width: 600 });
    const { root, host } = await mountApp(null);
    // Narrow mount collapses the right panel even with no persisted state.
    expect(attr(host, "data-side-collapsed")).toBe("true");
    // A manual expand persists right:false (user intent beats the width rule).
    click(byTestId(host, "expand-side"));
    await flush();
    expect(storageMap.get(COLLAPSED_KEY)).toBe('{"left":false,"right":false}');
    root.unmount();
    happy.setViewport({ width: 1024 });
  });
});
