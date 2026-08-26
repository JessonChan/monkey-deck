// Mount-test Sidebar expanded-state persistence (issue #57): which projects the
// user left expanded must survive remounts/restarts via localStorage
// (`md:sidebar-expanded`, JSON array of project IDs). Pins the three legs:
// lazy init restores on mount, caret toggles write back, corrupt storage falls
// back to the empty set without crashing. Same mock scaffolding as
// ChatView.sidedrawer.mount.test.tsx (bindings / i18n / tooltip stubbed;
// 挂载期不触发真后端调用).

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
  projects: [proj("p1", "alpha"), proj("p2", "beta")],
  selectedProjectId: null,
  sessionsByProject: { p1: [sess("s1", "p1")], p2: [sess("s2", "p2")] },
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

// Caret button of a project row (the collapse/expand chevron next to its name).
const caretOf = (host: HTMLElement, projectId: string): HTMLElement | null =>
  host.querySelector(`[data-testid="project-${projectId}"]`)?.closest(".project-item")?.querySelector("button.caret") ?? null;

describe("Sidebar expanded-state persistence (#57)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("lazy init restores the persisted expanded set on mount", async () => {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(["p1"]));
    const { host, root } = mount();
    await flush();

    // p1 expanded → its session list renders; p2 stays collapsed.
    expect(host.querySelector('[data-testid="session-s1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="session-s2"]')).toBeNull();
    expect(caretOf(host, "p1")?.classList.contains("open")).toBe(true);
    expect(caretOf(host, "p2")?.classList.contains("open")).toBe(false);

    root.unmount();
  });

  test("caret toggle writes back to localStorage (expand then collapse)", async () => {
    const { host, root } = mount();
    await flush();
    expect(localStorage.getItem(EXPANDED_KEY)).toBe("[]"); // mount writeback of the empty set

    const caret = caretOf(host, "p1");
    expect(caret).not.toBeNull();

    caret!.dispatchEvent(click());
    await flush();
    expect(localStorage.getItem(EXPANDED_KEY)).toBe(JSON.stringify(["p1"]));
    expect(host.querySelector('[data-testid="session-s1"]')).not.toBeNull();

    caretOf(host, "p1")!.dispatchEvent(click());
    await flush();
    expect(localStorage.getItem(EXPANDED_KEY)).toBe("[]");
    expect(host.querySelector('[data-testid="session-s1"]')).toBeNull();

    root.unmount();
  });

  test("corrupt / non-array storage falls back to nothing expanded, no crash", async () => {
    localStorage.setItem(EXPANDED_KEY, "{not json");
    const a = mount();
    await flush();
    expect(a.host.querySelector('[data-testid="session-s1"]')).toBeNull();
    a.root.unmount();

    localStorage.setItem(EXPANDED_KEY, JSON.stringify({ p1: true }));
    const b = mount();
    await flush();
    expect(b.host.querySelector('[data-testid="session-s1"]')).toBeNull();
    // Non-string entries are dropped too: only the valid ID survives the filter.
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([42, null, "p2"]));
    b.root.unmount();

    const c = mount();
    await flush();
    expect(c.host.querySelector('[data-testid="session-s2"]')).not.toBeNull();
    expect(c.host.querySelector('[data-testid="session-s1"]')).toBeNull();
    expect(localStorage.getItem(EXPANDED_KEY)).toBe(JSON.stringify(["p2"]));
    c.root.unmount();
  });
});
