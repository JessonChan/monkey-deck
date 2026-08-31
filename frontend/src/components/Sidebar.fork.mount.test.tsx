// Mount-test Sidebar session ctx-menu fork item (#172 Phase 2).
//
// Pins the declared-bit gate + click chain on the sidebar face:
//  1. canForkSession(s)=true → the session ctx menu renders 「基于最后的对话分叉」
//     (fork-session-<id>); clicking calls onForkSession with the session id and
//     closes the menu.
//  2. canForkSession(s)=false (undeclared harness) → the menu item is NOT
//     rendered at all (hide, not disable — iron rule ①).
//  3. zh/en locale copy pinned (sidebar.forkSession / forkSessionTip).
// Same mock scaffolding as Sidebar.renamed.mount.test.tsx (bindings / i18n /
// tooltip / clipboard stubbed; no real backend calls during mount).

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
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.MouseEvent = window.MouseEvent;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.localStorage = window.localStorage;
window.React = React;

// ---- binding / i18n / tooltip / clipboard mocks ----
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => ({
  ToggleMaximise: async () => {},
  RevealPath: async () => {},
  ExportSession: async () => "",
  SearchSessionContent: async () => [],
}));
mock.module("react-tooltip", () => ({ Tooltip: () => null, default: () => null }));
mock.module("react-i18next", () => {
  const t = (k: string, opts?: Record<string, unknown>) =>
    opts && Object.keys(opts).length ? `${k} ${JSON.stringify(opts)}` : k;
  return {
    useTranslation: () => ({ t }),
    initReactI18next: { type: "3rd-party" },
    default: { useTranslation: () => ({ t }) },
  };
});
mock.module("../lib/clipboard", () => ({
  copyText: async () => true,
  copyTextQuiet: () => {},
  execCommandCopy: () => true,
}));

// Dynamic import is intentional (module-loading-boundary exception): Sidebar
// must load after the mock.module() registrations above (same as the other
// Sidebar.*.mount.test.tsx files).
const { default: Sidebar } = await import("./Sidebar.tsx");
// Real locale JSONs — pin the actual copy, not just the key path.
import zh from "../i18n/locales/zh.json";
import en from "../i18n/locales/en.json";

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

const sess = (id: string, projectId: string, extra: Record<string, unknown> = {}) => ({
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
  tags: [] as string[],
  ...extra,
});

const baseProps = (sessionsByProject: Record<string, unknown[]>) => ({
  projects: [proj("p1", "alpha")],
  selectedProjectId: null,
  sessionsByProject,
  selectedSessionId: null,
  onSelectProject: async () => {},
  onSelectSession: () => {},
  onCreateSession: () => {},
  onAddProject: () => {},
  onRemoveProject: async () => {},
  onRemoveSession: async () => {},
  onTogglePin: () => {},
  onSetSessionTags: () => {},
  onRenameSession: () => {},
  statusBySession: {},
  activityBySession: {},
  unreadBySession: {},
  permPendingBySession: {},
  onReorderProjects: () => {},
  onOpenSettings: () => {},
});

function mount(extra: Record<string, unknown> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<Sidebar {...({ ...extra } as never)} />);
  return { host, root };
}

async function flush() {
  for (let i = 0; i < 8; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
}
async function mounted(sessionsByProject: Record<string, unknown[]>, extra: Record<string, unknown> = {}) {
  localStorage.setItem(EXPANDED_KEY, JSON.stringify(["p1"]));
  const m = mount({ ...baseProps(sessionsByProject), ...extra });
  await flush();
  return m;
}

const ctxOpen = (host: HTMLElement, id: string) =>
  host
    .querySelector(`[data-testid="session-${id}"]`)!
    .dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));

const forkCallsOf = (fn: unknown): unknown[][] => (fn as { mock: { calls: unknown[][] } }).mock.calls;

let forkSessionMock: ReturnType<typeof mock>;
beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  forkSessionMock = mock(() => Promise.resolve());
});

describe("Sidebar ctx 菜单 fork 项(#172 声明位门控)", () => {
  test("declared:菜单渲染「基于最后的对话分叉」,点击以 session id 调 onForkSession 并关菜单", async () => {
    const { host } = await mounted(
      { p1: [sess("s1", "p1")] },
      { canForkSession: () => true, onForkSession: forkSessionMock },
    );
    ctxOpen(host, "s1");
    await flush();

    const item = host.querySelector<HTMLElement>('[data-testid="fork-session-s1"]');
    expect(item).not.toBeNull();
    expect(item!.textContent).toContain("sidebar.forkSession");

    item!.click();
    await flush();
    const calls = forkCallsOf(forkSessionMock);
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe("s1");
    // Menu closed after the action.
    expect(host.querySelector('[data-testid="fork-session-s1"]')).toBeNull();
  });

  test("undeclared:菜单项完全不渲染(隐藏而非禁用)", async () => {
    const { host } = await mounted(
      { p1: [sess("s1", "p1")] },
      { canForkSession: () => false, onForkSession: forkSessionMock },
    );
    ctxOpen(host, "s1");
    await flush();

    expect(host.querySelector('[data-testid="fork-session-s1"]')).toBeNull();
    // The rest of the menu still renders (rename item present).
    expect(host.querySelector('[data-testid="rename-session-s1"]')).not.toBeNull();
    expect(forkCallsOf(forkSessionMock).length).toBe(0);
  });

  test("zh/en 文案钉死", () => {
    expect((zh as Record<string, any>).sidebar.forkSession).toBe("基于最后的对话分叉");
    expect((zh as Record<string, any>).sidebar.forkSessionTip).toBe("从当前对话末尾复制出一个新会话");
    expect((en as Record<string, any>).sidebar.forkSession).toBe("Fork from last conversation");
    expect((en as Record<string, any>).sidebar.forkSessionTip).toBe("Create a new chat from the end of this conversation");
  });
});
