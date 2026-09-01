// Mount-test: the sidebar scrolls the selected session's row into view (#180).
//
// The selection can change without pointer interaction near the sidebar
// (tab-bar switching, restore on mount), so an effect keyed on
// props.selectedSessionId scrolls the row to visibility:
//  1. Selected session beyond the rendered pagination slice (page 2): the
//     effect auto-opens exactly ONE page — the same setSessionLimit increment
//     the manual "load more" button uses — then scrollIntoView({block:
//     "nearest"}) lands on the target row. No further pages are opened.
//  2. Already-visible row: scrolls directly, zero pagination (the slice never
//     grows past its initial page).
//  3. Id absent from the full session list: zero scroll calls, zero
//     pagination, no error (silent no-op).
//
// scrollIntoView is recorded via a prototype spy (happy-dom implements it as
// a no-op); the row is located through the same [data-testid="session-<id>"]
// selector the effect itself uses (both render branches share that testid).
//
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

// ---- scrollIntoView spy (records receiver + argument) ----
const scrollCalls: { el: Element; arg: unknown }[] = [];
(window.Element.prototype as unknown as Record<string, unknown>).scrollIntoView =
  function (this: Element, arg?: unknown) {
    scrollCalls.push({ el: this, arg });
  };

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

// Import the component only after the mocks are registered — bun:test
// mock.module only affects modules imported afterwards, so the component
// import must stay dynamic (intentional module-loading boundary, same
// scaffolding as every other Sidebar mount test in this repo).
const { default: Sidebar } = await import("./Sidebar.tsx");

const EXPANDED_KEY = "md:sidebar-expanded";
const SESSION_PAGE = 25;

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

// 60 sessions in p1: ids s0..s59 in render order. Default slice renders s0..s24;
// s30 is the page-2 probe, s55 sits beyond the first auto-opened page (limit 50).
const sixtySessions = { p1: Array.from({ length: 60 }, (_, i) => sess(`s${i}`, "p1")) };

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  scrollCalls.length = 0;
});

describe("Sidebar scrolls to the selected session row (#180)", () => {
  test("1. selected page-2 session: auto-opens one page, then scrollIntoView({block:'nearest'}) on the row", async () => {
    const { host } = await mounted(sixtySessions, { selectedSessionId: "s30" });

    // Pagination auto-stepped once: target row now rendered...
    const row = host.querySelector('[data-testid="session-s30"]');
    expect(row).not.toBeNull();
    expect(row!.classList.contains("session-item-row")).toBe(true);
    // ...but exactly one page (limit 25 -> 50): s55 stays hidden and the
    // load-more button is still there for the remaining tail.
    expect(host.querySelector('[data-testid="session-s55"]')).toBeNull();
    expect(host.querySelector('[data-testid="load-more-sessions-p1"]')).not.toBeNull();

    // The scroll landed on the target row with the kbd-precedent options.
    expect(scrollCalls.length).toBe(1);
    expect(scrollCalls[0].el).toBe(row);
    expect(scrollCalls[0].arg).toEqual({ block: "nearest" });
  });

  test("2. already-visible selected row: direct scroll, zero pagination", async () => {
    const { host } = await mounted(sixtySessions, { selectedSessionId: "s3" });

    const row = host.querySelector('[data-testid="session-s3"]');
    expect(row).not.toBeNull();
    expect(scrollCalls.length).toBe(1);
    expect(scrollCalls[0].el).toBe(row);
    expect(scrollCalls[0].arg).toEqual({ block: "nearest" });

    // Zero pagination: the slice never grew past the initial page, so page-2
    // rows are absent without any load-more interaction.
    expect(host.querySelector('[data-testid="session-s30"]')).toBeNull();
  });

  test("3. id absent from the full list: zero scroll, zero pagination, no error", async () => {
    const { host } = await mounted(sixtySessions, { selectedSessionId: "ghost" });

    expect(scrollCalls.length).toBe(0);
    // Zero pagination: slice still the initial page only.
    expect(host.querySelector('[data-testid="session-s30"]')).toBeNull();
    // Still exactly SESSION_PAGE rows rendered (s0..s24).
    expect(host.querySelectorAll(".session-item-row").length).toBe(SESSION_PAGE);
  });
});
