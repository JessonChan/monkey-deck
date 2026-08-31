// Mount-test for the stray "0" on project rows (#28911): the session-list
// empty guard used to read `(searching || activeTags.length) && ...`, so the
// default state (not searching, no tag filter) evaluated to the NUMBER 0 and
// React rendered a literal "0" text node under every expanded project's
// session list. Pins both directions: no stray "0" in the default state, and
// the no-match branch still renders when a search genuinely matches nothing.
// Same mock scaffolding as Sidebar.expanded.mount.test.tsx (bindings / i18n /
// tooltip stubbed; 挂载期不触发真后端调用).

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

// ---- binding / i18n / tooltip mock(挂载期不触发真后端调用)----
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

// 在 mock 注册后再导入组件(确保拿到 mocked 依赖)。
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

const sess = (id: string, projectId: string) => ({
  id,
  projectId,
  acpSession: "",
  title: `t-${id}`,
  customTitle: "",
  model: "",
  harness: "opencode",
  worktreePath: "",
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

const baseProps = {
  projects: [proj("p1", "alpha")],
  selectedProjectId: null,
  sessionsByProject: { p1: [sess("s1", "p1")] },
  selectedSessionId: null,
  onSelectProject: async () => {},
  onSelectSession: () => {},
  onCreateSession: () => {},
  onAddProject: () => {},
  onRemoveProject: async () => {},
  onRemoveSession: async () => {},
  onTogglePin: () => {},
  onRenameSession: () => {},
  statusBySession: {},
  activityBySession: {},
  unreadBySession: {},
  permPendingBySession: {},
  onReorderProjects: () => {},
  onOpenSettings: () => {},
};

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<Sidebar {...(baseProps as never)} />);
  return { host, root };
}

async function flush() {
  for (let i = 0; i < 8; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
}

const click = () => new window.MouseEvent("click", { bubbles: true, button: 0 });

// Stray-zero probe: a bare number guard in JSX renders a text node (not an
// element) directly under the session list. `false` renders nothing at all.
const strayZeroNodes = (list: HTMLElement) =>
  Array.from(list.childNodes).filter(
    (n) => n.nodeType === 3 && (n.textContent ?? "").trim() === "0"
  );

function sessionListOf(host: HTMLElement): HTMLElement {
  const list = host.querySelector<HTMLElement>(".session-list");
  expect(list).not.toBeNull();
  return list!;
}

function setInputValue(el: HTMLInputElement, value: string) {
  // The search input is uncontrolled + driven by a native "input" listener
  // (Sidebar.tsx precedent), so a plain value assignment + dispatched input
  // event reaches setSearchQ in happy-dom and real webviews.
  el.value = value;
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

describe("Sidebar session-list stray zero (#28911)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("default state (no search, no tags) renders no stray '0' in the session list", async () => {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(["p1"]));
    const { host, root } = mount();
    await flush();

    // Sanity: the expanded project's session list really rendered.
    const list = sessionListOf(host);
    expect(host.querySelector('[data-testid="session-s1"]')).not.toBeNull();

    // Regression: the numeric `0` from the old `(searching || activeTags.length)`
    // guard used to leak into JSX here as a bare "0" text node.
    expect(strayZeroNodes(list)).toHaveLength(0);

    root.unmount();
  });

  test("search with no matches still shows the noMatch branch, no stray '0'", async () => {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(["p1"]));
    const { host, root } = mount();
    await flush();

    // Open the per-project search box and type a query matching no session.
    host.querySelector<HTMLElement>('[data-testid="search-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    const input = host.querySelector<HTMLInputElement>('[data-testid="session-search-p1"]')!;
    expect(input).not.toBeNull();
    setInputValue(input, "zzz");
    await flush();

    const list = sessionListOf(host);
    expect(host.querySelector(".session-search-empty")).not.toBeNull();
    expect(list.querySelector(".session-search-empty")!.textContent).toBe("sidebar.noMatch");
    expect(strayZeroNodes(list)).toHaveLength(0);

    root.unmount();
  });
});
