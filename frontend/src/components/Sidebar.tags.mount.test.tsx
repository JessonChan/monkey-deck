// Mount-test Sidebar session tags (#150 MVP; #160 interaction realignment,
// #181 named-chip revival).
//
// Pins the tag contract end-to-end from props/state down to what a user can
// see and click:
//  1. Inline named chips (#181 — revives #150's text chips, replacing
//     #174's dot family): tagged rows render up to 3 named chips in the
//     meta cluster (same tagColor() as everywhere), tags beyond 3 fold
//     into one +N overflow chip whose tooltip lists the full set, untagged
//     rows stay bare; the dot rules stay gone from index.css.
//  2. Ctx「标签 ›」submenu: Enter on the new-tag input appends to the LIVE tag
//     set (onSetSessionTags(id, [...live, value])), input clears for rapid entry.
//  3. Removal: clicking a checked tag row calls onSetSessionTags without it.
//  4. Panel-gated OR multi-select filter (#160b/#160c): the chip row is
//     closed by default, opens from the project-row tag button, and carries
//     the project's FULL tag union; the selected set narrows the list to
//     sessions matching ANY selected tag (OR); re-click removes one tag;
//     emptying the selection lifts the filter.
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
  test("1. inline named chips (#181): ≤3 chips per row, +N overflow with full tooltip, untagged bare", async () => {
    const { host } = await mounted({
      p1: [
        sess("s1", "p1", { tags: ["api", "db"] }),
        sess("s2", "p1", { tags: ["a", "b", "c", "d", "e"] }),
        sess("s3", "p1"),
      ],
    });

    // Tagged rows carry named chips keyed tagchip-<sid>-<tag>; untagged none.
    const chipApi = host.querySelector('[data-testid="tagchip-s1-api"]')!;
    const chipDb = host.querySelector('[data-testid="tagchip-s1-db"]')!;
    expect(host.querySelectorAll('[data-testid^="tagchip-s1-"]').length).toBe(2);
    expect(chipApi.textContent).toBe("api");
    // Colors come from the shared palette math (filter panel / ctx menu / chips).
    expect(chipApi.getAttribute("style")).toContain(tagColor("api"));
    expect(chipDb.getAttribute("style")).toContain(tagColor("db"));
    expect(TAG_PALETTE).toContain(tagColor("api"));
    expect(tagColor("api")).toBe(tagColor("api")); // deterministic
    // Cap 3: five tags render exactly three chips — the first three only…
    expect(host.querySelectorAll('[data-testid^="tagchip-s2-"]').length).toBe(3);
    expect(host.querySelector('[data-testid="tagchip-s2-a"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="tagchip-s2-b"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="tagchip-s2-c"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="tagchip-s2-d"]')).toBeNull();
    expect(host.querySelector('[data-testid="tagchip-s2-e"]')).toBeNull();
    // …plus one +N overflow chip whose tooltip carries the FULL list.
    const more = host.querySelector('[data-testid="tagchip-more-s2"]')!;
    expect(more.textContent).toBe("+2");
    expect(more.getAttribute("data-tooltip-content"))
      .toBe('sidebar.tagDotsTip {"tags":"a, b, c, d, e"}');

    // Untagged rows stay bare (no chips, no overflow chip).
    expect(host.querySelector('[data-testid^="tagchip-s3-"]')).toBeNull();
    expect(host.querySelector('[data-testid="tagchip-more-s3"]')).toBeNull();
    expect(host.querySelectorAll(".session-tag-chip").length).toBe(5); // 2 + 3
    expect(host.querySelectorAll(".session-tag-more").length).toBe(1);
    // The dot family stays gone (chip revival replaces dots entirely).
    expect(host.querySelectorAll('[data-testid^="tag-dots-"]').length).toBe(0);
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.session-tag-chip\s*\{/);
    expect(css).toMatch(/\.session-tag-more\s*\{/);
    expect(css).not.toMatch(/\.session-tag-dots?\s*\{/);
    // Ellipsis gate (#181 rework): text-overflow applies to block containers
    // only (css-overflow-3) — an inline-flex chip hard-cuts long tag names
    // with no "…" glyph. Pin the display so this can't silently regress.
    const chipRule = css.match(/\.session-tag-chip\s*\{([^}]*)\}/)![1];
    const moreRule = css.match(/\.session-tag-more\s*\{([^}]*)\}/)![1];
    expect(chipRule).toContain("display: block");
    expect(chipRule).not.toContain("inline-flex");
    expect(chipRule).toContain("text-overflow: ellipsis");
    expect(moreRule).toContain("display: block");
    expect(moreRule).not.toContain("inline-flex");
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

  test("4. panel-gated OR multi-select (#160c): full tag union rendered, A+B union visible, non-matching hidden, re-click removes, empty lifts", async () => {
    const { host } = await mounted({
      p1: [sess("s1", "p1", { tags: ["api"] }), sess("s2", "p1", { tags: ["db"] }), sess("s3", "p1", { tags: ["redis"] })],
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
    // The expanded set view carries the project's FULL tag union — every tag
    // seen on any session (api/db/redis), not just one session's subset.
    expect(host.querySelectorAll('[data-testid="tag-row-p1"] .session-tag-filter').length).toBe(3);

    // One selected tag: only its carriers survive.
    host.querySelector<HTMLElement>('[data-testid="tagfilter-p1-api"]')!.dispatchEvent(click());
    await flush();
    expect(rows().s1).not.toBeNull();
    expect(rows().s2).toBeNull();
    expect(rows().s3).toBeNull();

    // Adding db keeps OR semantics: api-OR-db carriers both stay visible;
    // the session carrying neither selected tag (redis only) is hidden.
    host.querySelector<HTMLElement>('[data-testid="tagfilter-p1-db"]')!.dispatchEvent(click());
    await flush();
    expect(rows().s1).not.toBeNull();
    expect(rows().s2).not.toBeNull();
    expect(rows().s3).toBeNull();
    // Chip state + tooltip follow set membership, not "last clicked".
    expect(host.querySelector('[data-testid="tagfilter-p1-api"]')!.className).toContain("active");
    expect(host.querySelector('[data-testid="tagfilter-p1-db"]')!.className).toContain("active");
    expect(host.querySelector('[data-testid="tagfilter-p1-db"]')!.getAttribute("data-tooltip-content"))
      .toBe("sidebar.tagFilterActive");
    expect(host.querySelector('[data-testid="tagfilter-p1-redis"]')!.getAttribute("data-tooltip-content"))
      .toBe('sidebar.tagFilterIdle {"tag":"redis"}');

    // Re-click removes just that tag from the selection: db-only filter remains.
    host.querySelector<HTMLElement>('[data-testid="tagfilter-p1-api"]')!.dispatchEvent(click());
    await flush();
    expect(rows().s1).toBeNull();
    expect(rows().s2).not.toBeNull();
    expect(rows().s3).toBeNull();

    // Emptying the selection lifts the filter entirely: full list, no active chip.
    host.querySelector<HTMLElement>('[data-testid="tagfilter-p1-db"]')!.dispatchEvent(click());
    await flush();
    expect(rows().s1).not.toBeNull();
    expect(rows().s2).not.toBeNull();
    expect(rows().s3).not.toBeNull();
    expect(host.querySelector(".session-tag-filter.active")).toBeNull();
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

  test("6. closing the panel clears the whole selection — no hidden state (#160b/#160c)", async () => {
    const { host } = await mounted({
      p1: [sess("s1", "p1", { tags: ["api"] }), sess("s2", "p1", { tags: ["db"] }), sess("s3", "p1")],
    });

    host.querySelector<HTMLElement>('[data-testid="tag-filter-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    host.querySelector<HTMLElement>('[data-testid="tagfilter-p1-api"]')!.dispatchEvent(click());
    await flush();
    host.querySelector<HTMLElement>('[data-testid="tagfilter-p1-db"]')!.dispatchEvent(click());
    await flush();
    // api OR db active: s1 + s2 visible, untagged s3 filtered out.
    expect(host.querySelector('[data-testid="session-s1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="session-s2"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="session-s3"]')).toBeNull();

    // Closing the panel drops the ENTIRE selection (not just one chip):
    // the full list returns and the row hides.
    host.querySelector<HTMLElement>('[data-testid="tag-filter-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    expect(host.querySelector('[data-testid="tag-row-p1"]')).toBeNull();
    expect(host.querySelector('[data-testid="session-s1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="session-s2"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="session-s3"]')).not.toBeNull();

    // Reopening starts clean: the row is back, nothing pre-activated.
    host.querySelector<HTMLElement>('[data-testid="tag-filter-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    expect(host.querySelector('[data-testid="tag-row-p1"]')).not.toBeNull();
    expect(host.querySelector(".session-tag-filter.active")).toBeNull();
    expect(host.querySelector('[data-testid="session-s3"]')).not.toBeNull();
  });

  test("7. ctx tag assignment reflects immediately in the open panel's chips and filter", async () => {
    const sessions = () => ({
      p1: [sess("s1", "p1", { tags: ["api"] }), sess("s2", "p1", { tags: ["db"] })],
    });
    const { host, root } = await mounted({
      p1: [sess("s1", "p1", { tags: ["api"] }), sess("s2", "p1")],
    });

    // Panel already open: chips render the CURRENT union (api only).
    host.querySelector<HTMLElement>('[data-testid="tag-filter-sessions-p1"]')!.dispatchEvent(click());
    await flush();
    expect(host.querySelectorAll('[data-testid="tag-row-p1"] .session-tag-filter').length).toBe(1);

    // Assign "db" to s2 via the ctx「标签」submenu.
    ctxOpen(host, "s2");
    await flush();
    const input = host.querySelector<HTMLInputElement>('[data-testid="tag-new-input-s2"]')!;
    expect(input).not.toBeNull();
    setInputValue(input, "db");
    pressEnter(input);
    await flush();
    expect(tagCallsOf(setTagsMock)).toEqual([["s2", ["db"]]]);

    // Parent lands the optimistic update as a re-render with the new tag set —
    // no panel reopen: the chip row picks the new tag up immediately…
    root.render(<Sidebar {...(baseProps(sessions()) as never)} />);
    await flush();
    expect(host.querySelectorAll('[data-testid="tag-row-p1"] .session-tag-filter').length).toBe(2);
    expect(host.querySelector('[data-testid="tagfilter-p1-db"]')).not.toBeNull();

    // …and the freshly assigned tag filters right away.
    host.querySelector<HTMLElement>('[data-testid="tagfilter-p1-db"]')!.dispatchEvent(click());
    await flush();
    expect(host.querySelector('[data-testid="session-s1"]')).toBeNull();
    expect(host.querySelector('[data-testid="session-s2"]')).not.toBeNull();

    root.unmount();
  });

  test("8. ctx tags submenu two sections (#174): project quick-add appends, then flips sections live", async () => {
    const sessions = (s1Tags: string[] = ["api"]) => ({
      p1: [
        sess("s1", "p1", { tags: s1Tags }),
        sess("s2", "p1", { tags: ["db", "api"] }),
        sess("s3", "p1", { tags: ["redis"] }),
      ],
    });
    const { host, root } = await mounted(sessions());

    ctxOpen(host, "s1");
    await flush();
    // Section 1: the session's own tags — remove contract unchanged.
    expect(host.querySelector('[data-testid="tag-remove-s1-api"]')).not.toBeNull();
    // Section 2: the project's remaining tags, first-seen order, own excluded.
    const addIds = Array.from(host.querySelectorAll('[data-testid^="tag-add-s1-"]')).map(
      (el) => el.getAttribute("data-testid")
    );
    expect(addIds).toEqual(["tag-add-s1-db", "tag-add-s1-redis"]);
    // Clicking a project tag appends to the LIVE set.
    host.querySelector<HTMLElement>('[data-testid="tag-add-s1-db"]')!.dispatchEvent(click());
    await flush();
    expect(tagCallsOf(setTagsMock)).toEqual([["s1", ["api", "db"]]]);

    // Optimistic update lands as a re-render with the new tag set — the menu
    // stays open and db flips from quick-add to the assigned section in place.
    root.render(<Sidebar {...(baseProps(sessions(["api", "db"])) as never)} />);
    await flush();
    expect(host.querySelector('[data-testid="tag-remove-s1-db"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="tag-add-s1-db"]')).toBeNull();
    expect(host.querySelector('[data-testid="tag-add-s1-redis"]')).not.toBeNull();
    root.unmount();
  });

  test("9. tags-empty message only when the project has no tags at all (#174)", async () => {
    // Project carries other tags: quick-add section replaces the empty message.
    const a = await mounted({
      p1: [sess("s1", "p1"), sess("s2", "p1", { tags: ["db"] })],
    });
    ctxOpen(a.host, "s1");
    await flush();
    expect(a.host.querySelector('[data-testid="tags-empty-s1"]')).toBeNull();
    expect(a.host.querySelector('[data-testid="tag-add-s1-db"]')).not.toBeNull();
    a.root.unmount();

    // Fully tagless project: legacy empty state, no quick-add rows.
    const b = await mounted({
      p1: [sess("s9", "p1")],
    });
    ctxOpen(b.host, "s9");
    await flush();
    expect(b.host.querySelector('[data-testid="tags-empty-s9"]')).not.toBeNull();
    expect(b.host.querySelector('[data-testid^="tag-add-s9-"]')).toBeNull();
    b.root.unmount();
  });
});
