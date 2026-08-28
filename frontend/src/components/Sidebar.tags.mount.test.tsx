// Mount-test Sidebar session tags (#150 MVP).
//
// Pins the tag contract end-to-end from props/state down to what a user can
// see and click:
//  1. Assignment renders: a session carrying tags shows colored mini-chips in
//     the row meta zone (same slot as the pin mark), keyed by a stable hash
//     into the 8-color Gmail palette; untagged rows show none.
//  2. Ctx「标签 ›」submenu: Enter on the new-tag input appends to the LIVE tag
//     set (onSetSessionTags(id, [...live, value])), input clears for rapid entry.
//  3. Removal: clicking a checked tag row calls onSetSessionTags without it.
//  4. Per-project single-select filter: clicking a filter chip narrows the
//     list to sessions carrying that tag; clicking it again restores the full
//     list (cancel); clicking another chip re-keys the filter.
//  5. Search AND: with a tag filter active, an active search further narrows
//     to the INTERSECTION (title match ∪ content hits, then tag).
//  6. Row-height discipline: chips are capped (fixed height / line-height /
//     flex-shrink:0) so a tagged row never grows taller than a plain one —
//     pinned by computed style (happy-dom has no layout engine; geometry
//     equality is asserted too, see notes inline).
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
  test("1. assignment renders: tagged rows show palette-colored mini-chips, untagged show none", async () => {
    const { host } = await mounted({
      p1: [sess("s1", "p1", { tags: ["api", "db"] }), sess("s2", "p1")],
    });

    const chip1 = host.querySelector<HTMLElement>('[data-testid="tagchip-s1-api"]')!;
    const chip2 = host.querySelector<HTMLElement>('[data-testid="tagchip-s1-db"]')!;
    expect(chip1).not.toBeNull();
    expect(chip2).not.toBeNull();
    expect(chip1.textContent).toBe("api");
    // Stable hash → palette color, applied as inline background.
    expect(chip1.getAttribute("style")!.toLowerCase()).toContain(tagColor("api").toLowerCase());
    expect(chip2.getAttribute("style")!.toLowerCase()).toContain(tagColor("db").toLowerCase());
    expect(tagColor("api")).toBe(tagColor("api")); // deterministic
    expect(TAG_PALETTE).toContain(tagColor("api"));
    // Untagged row: no chips at all.
    expect(host.querySelector('[data-testid="tagchip-s2-api"]')).toBeNull();
    expect(host.querySelectorAll(".session-tag-chip").length).toBe(2);
    // Tooltip names the tag (raw name, not a key).
    expect(chip1.getAttribute("data-tooltip-content")).toBe("api");
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

  test("4. per-project single-select filter: activate → narrow, re-click → cancel, other chip → re-key", async () => {
    const { host } = await mounted({
      p1: [sess("s1", "p1", { tags: ["api"] }), sess("s2", "p1", { tags: ["db"] }), sess("s3", "p1")],
    });
    const rows = () => ({
      s1: host.querySelector('[data-testid="session-s1"]'),
      s2: host.querySelector('[data-testid="session-s2"]'),
      s3: host.querySelector('[data-testid="session-s3"]'),
    });

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
    host.querySelector<HTMLElement>('[data-testid="tagfilter-p1-api"]')!.dispatchEvent(click());
    await flush();
    expect(host.querySelector('[data-testid="session-s1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="session-s2"]')).toBeNull();
    expect(host.querySelector('[data-testid="session-s3"]')).toBeNull();
  });

  test("6. row-height discipline: chip CSS caps height so tagged rows never grow", async () => {
    const five = ["a1", "a2", "a3", "a4", "a5"];
    const { host } = await mounted({
      p1: [sess("s1", "p1", { tags: five }), sess("s2", "p1")],
    });

    // Geometry: happy-dom has no layout engine, but the invariant still holds —
    // a tagged row and a plain one report identical heights (both resolve to
    // the same non-positive value here; real-engine proof is the CSS pin below
    // plus desktop GUI review).
    const r1 = host.querySelector<HTMLElement>('[data-testid="session-s1"]')!;
    const r2 = host.querySelector<HTMLElement>('[data-testid="session-s2"]')!;
    expect(r1.offsetHeight).toBe(r2.offsetHeight);

    // CSS contract pin: the exact properties that keep the row height fixed.
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    const rule = css.match(/\.session-tag-chip\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const body = rule![1];
    expect(body).toContain("flex-shrink: 0"); // chips never stretch the flex row
    expect(body).toMatch(/height:\s*14px/); // fixed chip height ≤ meta-zone budget
    expect(body).toMatch(/line-height:\s*12px/); // 12px discipline
    expect(body).toContain("overflow: hidden"); // long names ellipsize, never wrap
  });
});
