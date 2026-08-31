// Mount-test Sidebar session-row fork badge (#172 visibility card).
//
// Pins the lineage badge on the sidebar face:
//  1. session with forked_from → GitFork badge renders (fork-badge-<id>),
//     tooltip carries the SOURCE session's display title resolved through the
//     full cross-project sessionsByProject map (customTitle preferred).
//  2. native session (no forked_from) → no badge.
//  3. forked_from = empty string → no badge (same as absent).
//  4. unresolvable source id → tooltip degrades to the source id prefix.
//  5. zh/en locale copy pinned (sidebar.forkedFromTip).
// Pure visibility: no fork business chain (gating / action) involved here —
// the ctx-menu fork item is covered by Sidebar.fork.mount.test.tsx.
// Same mock scaffolding as Sidebar.fork.mount.test.tsx (bindings / i18n /
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

const baseProps = (sessionsByProject: Record<string, unknown[]>, projects: unknown[]) => ({
  projects,
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
async function mounted(
  sessionsByProject: Record<string, unknown[]>,
  projects: unknown[] = [proj("p1", "alpha")],
) {
  localStorage.setItem(EXPANDED_KEY, JSON.stringify(projects.map((p) => (p as { id: string }).id)));
  const m = mount({ ...baseProps(sessionsByProject, projects) });
  await flush();
  return m;
}

const badgeOf = (host: HTMLElement, id: string) =>
  host.querySelector<HTMLElement>(`[data-testid="fork-badge-${id}"]`);

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("Sidebar session 行 fork 徽章(#172 可见性)", () => {
  test("有 forked_from:渲染徽章,tooltip 解析出源会话标题(跨项目全量映射,customTitle 优先)", async () => {
    const source = sess("src1", "p2", { customTitle: "源会话定制名" });
    const fork = sess("s1", "p1", { forkedFrom: "src1" });
    const { host } = await mounted(
      { p1: [fork], p2: [source] },
      [proj("p1", "alpha"), proj("p2", "beta")],
    );

    const badge = badgeOf(host, "s1");
    expect(badge).not.toBeNull();
    // Tooltip content = mocked t() output carrying the resolved source title
    // (customTitle preferred over the auto title; source lives in ANOTHER
    // project — resolution must span the full sessionsByProject map).
    const tip = badge!.getAttribute("data-tooltip-content") ?? "";
    expect(tip).toContain("sidebar.forkedFromTip");
    expect(tip).toContain("源会话定制名");
    // #175: the harness icon moved to the row TAIL — last element child of
    // session-item-main, behind the whole meta cluster. The badge stays at
    // the cluster head (here: label → badge, the time fallback follows).
    const main = host.querySelector<HTMLElement>('[data-testid="session-s1"] .session-item-main')!;
    expect(main.lastElementChild?.classList.contains("session-harness-icon")).toBe(true);
    expect(badge!.previousElementSibling?.classList.contains("session-label")).toBe(true);
  });

  test("tooltip 解析不到源会话:回退源 id 前 8 位", async () => {
    const fork = sess("s1", "p1", { forkedFrom: "deadbeef12345678" });
    const { host } = await mounted({ p1: [fork] });

    const tip = badgeOf(host, "s1")!.getAttribute("data-tooltip-content") ?? "";
    expect(tip).toContain("deadbeef");
    expect(tip).not.toContain("deadbeef12345678");
  });

  test("无 forked_from(原生会话):不渲染徽章", async () => {
    const { host } = await mounted({ p1: [sess("s1", "p1")] });
    expect(badgeOf(host, "s1")).toBeNull();
  });

  test("forked_from 为空串:不渲染徽章", async () => {
    const fork = sess("s1", "p1", { forkedFrom: "" });
    const { host } = await mounted({ p1: [fork] });
    expect(badgeOf(host, "s1")).toBeNull();
  });

  test("zh/en 文案钉死", () => {
    expect((zh as Record<string, any>).sidebar.forkedFromTip).toBe("分叉自 {{src}}");
    expect((en as Record<string, any>).sidebar.forkedFromTip).toBe("Forked from {{src}}");
  });
});
