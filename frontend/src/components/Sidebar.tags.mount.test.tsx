// Mount-test Sidebar session tags (#150 MVP; #160 interaction realignment).
//
// Pins the tag contract end-to-end from props/state down to what a user can
// see and click:
//  1. Zero inline footprint (#160a): sessions carrying tags render NO row
//     chips at all — not by default, not on hover — and the .session-tag-chip
//     rule is gone from index.css (clean cutover).
//  2. Ctx「标签 ›」submenu: Enter on the new-tag input appends to the LIVE tag
//     set (onSetSessionTags(id, [...live, value])), input clears for rapid entry.
//  3. Removal: clicking a checked tag row calls onSetSessionTags without it.
//  4. Panel-gated single-select filter (#160b): the chip row is closed by
//     default and opens from the project-row tag button; the active chip
//     narrows the list to sessions carrying that tag; re-click cancels;
//     another chip re-keys the filter.
//  5. Search AND: with a tag filter active, an active search further narrows
//     to the INTERSECTION (title match ∪ content hits, then tag).
//  6. Closing the panel clears that project's filter (no hidden state): the
//     full list returns, the row hides, and reopening shows no active chip.
//
// Same mock scaffolding as Sidebar.scheduled.mount.test.tsx (bindings / i18n /
// tooltip / clipboard stubbed; no real backend calls during mount).

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
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
// Realm bridge (same as QueuePanel.* tests): React's value tracking and the
// native-setter typing helper must see the same element constructors.
globalThis.HTMLInputElement = window.HTMLInputElement;
globalThis.Event = window.Event;
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
  // Echo the key, appending interpolation args so tests can pin the tooltip
  // payloads (e.g. tagFilterIdle receives the tag name).
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

// Import the component only after the mocks are registered.
const { default: Sidebar } = await import("./Sidebar.tsx");
// Real (unmocked) util — same module instance the component uses.
const { tagColor, TAG_PALETTE } = await import("../lib/tagColor");

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
  const m = mount({
    ...baseProps(sessionsByProject),
    // Record every tag mutation for per-test call assertions.
    onSetSessionTags: setTagsMock,
    ...extra,
  });
  await flush();
  return m;
}

const click = (opts: Record<string, unknown> = {}) =>
  new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...opts });

const ctxOpen = (host: HTMLElement, id: string) =>
  host
    .querySelector(`[data-testid="session-${id}"]`)!
    .dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));

function setInputValue(el: HTMLInputElement, value: string) {
  // The search input is uncontrolled + driven by a native "input" listener
  // (FilePanel precedent — see Sidebar.tsx), so a plain value assignment +
  // dispatched input event reaches setSearchQ in happy-dom and real webviews.
  el.value = value;
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

const pressEnter = (el: HTMLElement) => {
  // happy-dom + React 19: delegated keydown reaches the handler reliably only
  // once the target has focus — mirror the real interaction (click into the
  // input, then press Enter).
  el.focus();
  el.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
};
const tagCallsOf = (fn: unknown): [string, string[]][] => (fn as MockFn).mock.calls as [string, string[]][];

let setTagsMock: ReturnType<typeof mock>;
beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  setTagsMock = mock(() => Promise.resolve());
});

describe("Sidebar session tags (#150 MVP)", () => {
  test("1. zero inline footprint: tagged rows render no chips, CSS rule cut over", async () => {
    const { host } = await mounted({
      p1: [sess("s1", "p1", { tags: ["api", "db"] }), sess("s2", "p1")],
    });

    // No chips anywhere — not on tagged rows, not on untagged ones (#160a).
    expect(host.querySelectorAll('[data-testid^="tagchip-"]').length).toBe(0);
    expect(host.querySelectorAll(".session-tag-chip").length).toBe(0);
    // Palette math itself unchanged (still feeds filter chips + ctx dots).
    expect(TAG_PALETTE).toContain(tagColor("api"));
    expect(tagColor("api")).toBe(tagColor("api")); // deterministic
    // Clean cutover: the dead chip rule is gone from index.css.
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/\.session-tag-chip\s*\{/);
  });

  test("2. ctx「标签 ›」Enter appends to the live set and clears the input", async () => {
    const { host } = await mounted({
      p1: [sess("s1", "p1", { tags: ["api"] })],
    });
    ctxOpen(host, "s1");
    await flush();
    expect(host.querySelector(`[data-testid="tags-menu-s1"]`)).not.toBeNull();

    const input = host.querySelector<HTMLInputElement>('[data-testid="tag-new-input-s1"]')!;
    expect(input).not.toBeNull();
    setInputValue(input, "db");
    pressEnter(input);
    await flush();

    expect(tagCallsOf(setTagsMock)).toEqual([["s1", ["api", "db"]]]);
    expect(input.value).toBe(""); // cleared for rapid multi-tag entry
  });

  test("3. removal: clicking a checked tag row drops exactly that tag", async () => {
    const { host } = await mounted({
      p1: [sess("s1", "p1", { tags: ["api", "db"] })],
    });
    ctxOpen(host, "s1");
    await flush();

    host.querySelector<HTMLElement>('[data-testid="tag-remove-s1-api"]')!.dispatchEvent(click());
    await flush();
    expect(tagCallsOf(setTagsMock)).toEqual([["s1", ["db"]]]);
  });

  test("4. panel-gated filter (#160b): closed by default; open → narrow, re-click → cancel, other chip → re-key", async () => {
    const { host } = await mounted({
      p1: [sess("s1", "p1", { tags: ["api"] }), sess("s2", "p1", { tags: ["db"] }), sess("s3", "p1")],
    });
    const rows = () => ({
      s1: host.querySelector('[data-testid="session-s1"]'),
      s2: host.querySelector('[data-testid="session-s2"]'),
      s3: host.querySelector('[data-testid="session-s3"]'),
    });

    // Zero footprint by default: tags exist but the chip row stays closed.
    expect(host.querySelector('[data-testid="tag-row-p1"]')).toBeNull();

    host.querySelector<HTMLElement>('[data-testid="tag-filter-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    expect(host.querySelector('[data-testid="tag-row-p1"]')).not.toBeNull();

    host.querySelector<HTMLElement>('[data-testid="tagfilter-p1-api"]')!.dispatchEvent(click());
    await flush();
    expect(rows().s1).not.toBeNull();
    expect(rows().s2).toBeNull();
    expect(rows().s3).toBeNull();

    // Re-click the active chip cancels the filter: full list returns.
    host.querySelector<HTMLElement>('[data-testid="tagfilter-p1-api"]')!.dispatchEvent(click());
    await flush();
    expect(rows().s1).not.toBeNull();
    expect(rows().s2).not.toBeNull();
    expect(rows().s3).not.toBeNull();

    // Clicking another chip re-keys the filter (single-select).
    host.querySelector<HTMLElement>('[data-testid="tagfilter-p1-db"]')!.dispatchEvent(click());
    await flush();
    expect(rows().s1).toBeNull();
    expect(rows().s2).not.toBeNull();
    expect(rows().s3).toBeNull();
  });

  test("5. search AND tag filter: intersection only", async () => {
    const { host } = await mounted({
      p1: [
        sess("s1", "p1", { title: "alpha", tags: ["api"] }),
        sess("s2", "p1", { title: "zeta", tags: ["api"] }),
        sess("s3", "p1", { title: "alpha", tags: ["db"] }),
      ],
    });

    // Open the per-project search box and type "alpha" → s1 + s3 (title match), s2 hidden.
    host.querySelector<HTMLElement>('[data-testid="search-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    const input = host.querySelector<HTMLInputElement>('[data-testid="session-search-p1"]')!;
    expect(input).not.toBeNull();
    setInputValue(input, "alpha");
    await flush();
    expect(host.querySelector('[data-testid="session-s1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="session-s2"]')).toBeNull();
    expect(host.querySelector('[data-testid="session-s3"]')).not.toBeNull();

    // Activate the api filter → AND narrows to the intersection: only s1.
    host.querySelector<HTMLElement>('[data-testid="tag-filter-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    host.querySelector<HTMLElement>('[data-testid="tagfilter-p1-api"]')!.dispatchEvent(click());
    await flush();
    expect(host.querySelector('[data-testid="session-s1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="session-s2"]')).toBeNull();
    expect(host.querySelector('[data-testid="session-s3"]')).toBeNull();
  });

  test("6. closing the panel clears the filter — no hidden state (#160b)", async () => {
    const { host } = await mounted({
      p1: [sess("s1", "p1", { tags: ["api"] }), sess("s2", "p1")],
    });

    host.querySelector<HTMLElement>('[data-testid="tag-filter-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    host.querySelector<HTMLElement>('[data-testid="tagfilter-p1-api"]')!.dispatchEvent(click());
    await flush();
    expect(host.querySelector('[data-testid="session-s2"]')).toBeNull(); // filtering

    // Second click on the toggle closes the panel AND lifts the filter.
    host.querySelector<HTMLElement>('[data-testid="tag-filter-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    expect(host.querySelector('[data-testid="tag-row-p1"]')).toBeNull();
    expect(host.querySelector('[data-testid="session-s1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="session-s2"]')).not.toBeNull();

    // Reopening starts clean: the row is back, nothing pre-activated.
    host.querySelector<HTMLElement>('[data-testid="tag-filter-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    expect(host.querySelector('[data-testid="tag-row-p1"]')).not.toBeNull();
    expect(host.querySelector(".session-tag-filter.active")).toBeNull();
    expect(host.querySelector('[data-testid="session-s2"]')).not.toBeNull();
  });
});
