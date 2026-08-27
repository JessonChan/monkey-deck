// Mount-test Sidebar scheduled-send alarm (#138 / issue #138).
//
// Pins the row-marker contract end-to-end from the prop the App derives out of
// authoritative chat:queue snapshots down to what a user can see/click:
//  1. A future earliest-scheduledAt renders the amber .scheduled-indicator chip
//     (AlarmClock glyph, tooltip keyed sidebar.scheduledTip) on that session row.
//  2. Absent/empty prop → no chip anywhere; rows fall back to .session-time.
//  3. A past timestamp never renders the chip (the "> now" gate hides it early,
//     before the next backend snapshot drops the entry).
//  4. The alarm is an INDEPENDENT mark: a session with both a composer draft and
//     a pending schedule shows BOTH chips (neither masks the other).
//
// Same mock scaffolding as Sidebar.batch.mount.test.tsx (bindings / i18n /
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
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
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
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: "3rd-party" },
  default: { useTranslation: () => ({ t: (k: string) => k }) },
}));
mock.module("../lib/clipboard", () => ({
  copyText: async () => true,
  copyTextQuiet: () => {},
  execCommandCopy: () => true,
}));

// Import the component only after the mocks are registered.
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

const baseProps = () => ({
  projects: [proj("p1", "alpha")],
  selectedProjectId: null,
  sessionsByProject: { p1: [sess("s1", "p1"), sess("s2", "p1"), sess("s3", "p1")] },
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
});

function mount(extra: Record<string, unknown> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<Sidebar {...({ ...baseProps(), ...extra } as never)} />);
  return { host, root };
}

async function flush() {
  for (let i = 0; i < 8; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
}

async function mounted(extra: Record<string, unknown> = {}) {
  localStorage.setItem(EXPANDED_KEY, JSON.stringify(["p1"]));
  const m = mount(extra);
  await flush();
  return m;
}

const alarmChip = (host: HTMLElement, id: string): HTMLElement | null =>
  host.querySelector(`[data-testid="scheduled-${id}"]`);

describe("Sidebar scheduled-send alarm (#138)", () => {
  beforeEach(() => {
    localStorage.clear();
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  });

  test("future earliest scheduledAt renders the alarm chip with its glyph", async () => {
    const future = Date.now() + 60 * 60_000;
    const { host } = await mounted({ scheduledBySession: { s1: future } });

    const chip = alarmChip(host, "s1");
    expect(chip).not.toBeNull();
    expect(chip!.className).toContain("scheduled-indicator");
    // AlarmClock lucide glyph inside the chip.
    expect(chip!.querySelector("svg")).not.toBeNull();
    // Tooltip keyed to the sidebar tip (i18n mock echoes the key verbatim).
    expect(chip!.getAttribute("data-tooltip-content")).toContain("sidebar.scheduledTip");

    // Other rows without schedules stay plain. The alarm is an INDEPENDENT mark,
    // so even the scheduled row's tail keeps its session-time fallback — the chip
    // never eats the exclusive tail slot (perm/unread/draft signals stay intact).
    expect(alarmChip(host, "s2")).toBeNull();
    expect(host.querySelectorAll(".session-time").length).toBe(3);
  });

  test("absent or empty prop renders no chips and keeps the session-time fallback", async () => {
    const { host } = await mounted({});
    expect(host.querySelectorAll(".scheduled-indicator").length).toBe(0);
    expect(host.querySelectorAll(".session-time").length).toBe(3);

    const none = await mounted({ scheduledBySession: {} });
    expect(none.host.querySelectorAll(".scheduled-indicator").length).toBe(0);
  });

  test("a past timestamp never renders the chip (> now gate)", async () => {
    const past = Date.now() - 60_000;
    const { host } = await mounted({ scheduledBySession: { s2: past } });
    expect(alarmChip(host, "s2")).toBeNull();
    expect(host.querySelectorAll(".scheduled-indicator").length).toBe(0);
  });

  test("alarm and draft chips coexist on one row (independent marks)", async () => {
    const future = Date.now() + 5 * 60_000;
    const { host } = await mounted({
      draftBySession: { s3: "pending text" },
      scheduledBySession: { s3: future },
    });
    expect(alarmChip(host, "s3")).not.toBeNull();
    expect(host.querySelector('[data-testid="draft-s3"]')).not.toBeNull();
  });
});
