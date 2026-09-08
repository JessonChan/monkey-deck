// App-level mount tests for #197: a fork row's upward pagination must reach
// the inherited base prefix — own pages first, then the source's watermarked
// prefix (negative seq offsets), seamlessly, and stop at the base top.
//
// The reported defect: once the oldestSeq cursor is lost (memory-saver drop +
// #208 busy switch-back skips the re-pull), loadMoreMessages fell back to
// beforeSeq=0 — which the backend correctly serves as the NEWEST merged page
// — and prepended it: page 1 duplicates forever, the base prefix stays
// unreachable. Scenarios:
//   1. Walk pin: fresh open → one click crosses the merged boundary into the
//      base, head terminates the walk, every row exactly once (#189 guard).
//   2. Heal pin (the bug): dropped-while-idle busy switch-back leaves the
//      session without page/cursor/hasMore; when the turn ends the app must
//      re-pull full history so the base prefix becomes reachable again.
//
// Scaffolding mirrors App.busy-switch-back.mount.test.tsx: ALL mocks (runtime
// + full ChatService surface) are registered BEFORE the dynamic App import —
// a static import would evaluate the real binding modules before the mocks
// replace them (bun's mock.module does not relink evaluated modules). The
// surface is built from the generated binding's SOURCE TEXT so a stale method
// list fails loudly.
import { describe, test, expect, mock } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import type { Message } from "./bindings/github.com/jessonchan/monkey-deck/internal/store/models";

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
globalThis.localStorage = window.localStorage;
window.React = React;

const realSetTimeout = globalThis.setTimeout.bind(globalThis);

// Deterministic IntersectionObserver stub: the real one auto-fires onLoadMore
// when the button enters the viewport; under happy-dom there is no layout, so
// a firing stub would race the manual clicks this test drives. Never firing
// keeps the cursor call log exact.
class MockLoadMoreIO {
  constructor(_cb: unknown) {}
  observe(_el: Element) {}
  unobserve(_el: Element) {}
  disconnect() {}
}
(globalThis as { IntersectionObserver: unknown }).IntersectionObserver = MockLoadMoreIO;

// Mock by RESOLVED path: bare-specifier mocks do not reliably intercept the
// same module when imported transitively by first-party code.
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
  Clipboard: { setText: async () => {}, readText: async () => "" },
}));

// ---- geometry stubs (mirrors ChatView.virtual.mount.test.tsx) ----
// The message list is virtualized; under happy-dom there is no layout engine,
// so offsetHeight/clientHeight are all 0 and the window collapses to ~0 rows.
// Pin the geometry: 10px rows in a 5000px viewport → even with the
// virtualizer's unmeasured 48px/item prior estimate, the whole 53-row merged
// transcript (own 3 + base 50) fits the window, making full-DOM assertions
// deterministic.
const VIEWPORT = 5000;
const ROW_H = 10;
const HEAD_H = 22;
const TAIL_H = 22;
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    const iid = this.dataset?.iid;
    if (iid === "__head__") return HEAD_H;
    if (iid === "__tail__") return TAIL_H;
    if (this.classList?.contains("cv-item")) return ROW_H;
    return 0;
  },
});
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList?.contains("chat-body") ? VIEWPORT : 0;
  },
});
// Real-browser scrollTop clamps to [0, scrollHeight - clientHeight] and fires
// the scroll event synchronously (WebKit semantics).
const scrollTopStore = new WeakMap<Element, number>();
Object.defineProperty(window.HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get(this: HTMLElement) {
    if (this.classList?.contains("chat-body")) {
      const content = this.querySelector(".chat-content") as HTMLElement | null;
      if (!content) return 0;
      let h = 0;
      for (const child of content.children) {
        h += child.classList.contains("cv-spacer")
          ? parseInt((child as HTMLElement).style.height, 10) || 0
          : (child as HTMLElement).offsetHeight;
      }
      return h;
    }
    return 0;
  },
});
Object.defineProperty(window.HTMLElement.prototype, "scrollTop", {
  configurable: true,
  get(this: HTMLElement) {
    return scrollTopStore.get(this) ?? 0;
  },
  set(this: HTMLElement, v: number) {
    const max = Math.max(0, this.scrollHeight - this.clientHeight);
    const clamped = Math.max(0, Math.min(v, max));
    const old = scrollTopStore.get(this) ?? 0;
    scrollTopStore.set(this, clamped);
    if (clamped !== old && this.classList?.contains("chat-body")) {
      this.dispatchEvent(new window.Event("scroll"));
    }
  },
});

// ---- ResizeObserver mock: panels/ChatView measure on mount ----
class MockResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) { this.cb = cb; }
  observe(_el: Element) {}
  unobserve(_el: Element) {}
  disconnect() {}
}
(globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;

// ---- backend bindings mock: the #197 fork lineage fixture ----
// 50-message source prefix (watermark 50) + 3 own messages; the mock ports
// internal/chat/chat.go forkLineagePage verbatim (own branch with beforeSeq<=0
// = newest window, base tail-fill with negative offsets m.seq-watermark-1,
// ascending merge trimmed to limit+1) so the REAL App pagination state machine
// runs against the REAL backend contract.
const FORK = "f1";
const WM = 50;

let fork: { own: Message[]; base: Message[] };
let calls: Array<{ sid: string; before: number; limit: number }>;
const events: string[] = [];
// Backend-truth statuses (SessionStatuses snapshot): the real backend reports
// a mid-turn session as "prompting" — mirror that so the snapshot merge cannot
// spuriously clear a busy status the push stream set.
const statusesSnapshot: Record<string, string> = {};

function mkMsg(sid: string, seq: number, content: string, role: string): Message {
  return { id: `${sid}-${seq}`, sessionId: sid, role, kind: "", content, seq, createdAt: seq };
}

function resetFixtures() {
  events.length = 0;
  for (const k of Object.keys(statusesSnapshot)) delete statusesSnapshot[k];
  calls = [];
  fork = {
    own: [
      mkMsg(FORK, 1, "own-user", "user"),
      mkMsg(FORK, 2, "own-agent-2", "agent"),
      mkMsg(FORK, 3, "own-agent-3", "agent"),
    ],
    base: Array.from({ length: WM }, (_, i) => mkMsg("src", i + 1, `src-${i + 1}`, "agent")),
  };
}
resetFixtures();

// Port of forkLineagePage (chat.go): same cursor algebra, same +1 probe.
function forkLineagePage(before: number, limit: number): Message[] {
  const L = limit + 1;
  let own: Message[] = [];
  if (before >= 0) {
    own = fork.own.filter((m) => before <= 0 || m.seq < before).slice(-L);
  }
  const need = L - own.length;
  const cursorInBase = before < 0;
  let base: Message[] = [];
  if (need > 0 || cursorInBase) {
    const srcBefore = cursorInBase ? before + WM : WM;
    base = srcBefore > 0 ? fork.base.filter((m) => m.seq <= srcBefore) : [];
    if (base.length > need) base = base.slice(base.length - need);
    base = base.map((m) => ({ ...m, sessionId: FORK, seq: m.seq - WM - 1 }));
  }
  const merged = [...base, ...own];
  return merged.length > L ? merged.slice(merged.length - L) : merged;
}

const emit = (name: string, data: unknown) => eventHandlers.get(name)?.({ data });

// Method names parsed from the generated binding source (no module load).
const CHAT_METHODS: string[] = [
  ...readFileSync(new URL("./bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice.ts", import.meta.url), "utf8")
    .matchAll(/export function (\w+)/g),
].map((m) => m[1]);
if (CHAT_METHODS.length === 0) throw new Error("fork-prefix test: could not parse ChatService methods from the generated binding");

const chatserviceOverrides: Record<string, unknown> = {
  ListProjects: async () => [{ id: "p1", name: "demo", path: "/tmp/demo" }],
  HasGitContext: async () => false,
  ListSessions: async () => [
    { id: "s2", projectId: "p1", title: "helper", harness: "omp" },
    { id: FORK, projectId: "p1", title: "src (fork)", harness: "omp" },
  ],
  ListHarnesses: async () => [],
  SessionStatuses: async () => ({ ...statusesSnapshot }),
  OpenSession: async () => null,
  LoadMessagesPage: async (sid: string, before: number, limit: number) => {
    events.push(`loadMsg:${sid}`);
    if (sid !== FORK) return [];
    calls.push({ sid, before, limit });
    return forkLineagePage(before ?? 0, limit);
  },
  ListUserMessages: async () => [],
  GetSessionCachedConfigOptions: async () => [],
  GetSessionCachedCommands: async () => [],
  GetSessionSnapshot: async () => JSON.stringify({ draft: "" }),
  SessionChanges: async () => null,
  SessionMergeable: async () => false,
  WorktreeKind: async () => "project",
};

mock.module("./bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => {
  const surface: Record<string, unknown> = {};
  for (const name of CHAT_METHODS) surface[name] = async () => undefined;
  return { ...surface, ...chatserviceOverrides };
});
mock.module("./bindings/github.com/jessonchan/monkey-deck/internal/terminal/terminalservice", () => ({
  ListTerminalsBySession: async () => [],
}));
// react-resizable-panels: real library measures the DOM and its imperative
// collapse() throws "Group not found" under happy-dom (no layout engine).
mock.module("react-resizable-panels", () => {
  const div = (props: Record<string, unknown>) => React.createElement("div", props);
  const handle = {
    collapse: () => {},
    expand: () => {},
    isCollapsed: () => false,
    resize: () => {},
  };
  return {
    Group: div,
    Panel: div,
    Separator: () => null,
    useDefaultLayout: (_opts?: unknown) => ({ defaultLayout: undefined, onLayoutChanged: () => {} }),
    usePanelRef: () => ({ current: handle }),
  };
});
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

async function mountApp(): Promise<{ root: Root; host: HTMLElement }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(React.createElement(App));
  await flush();
  return { root, host };
}

function click(el: Element) {
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
}

async function openSession(host: HTMLElement, sid: string) {
  click(host.querySelector(`[data-testid="session-${sid}"] .session-item-main`)!);
  await flush();
}

async function openProject(host: HTMLElement) {
  click(host.querySelector('[data-testid="project-p1"]')!);
  await flush();
}

function chatRows(host: HTMLElement): Element[] {
  return [...host.querySelectorAll('[data-testid="msg-agent"], [data-testid="msg-user"]')];
}

// Bubble text is exactly the message content (meta/timestamps live in a
// sibling .msg-meta), so match bubbles by exact text — row-level matching
// collides ("src-50" + timestamp "01-01…" reads as "src-5001…"). Streaming
// bubbles carry the trailing caret glyph (U+258B), stripped before compare.
function countText(host: HTMLElement, marker: string): number {
  return [...host.querySelectorAll(".bubble-agent, .bubble-user")]
    .filter((el) => (el.textContent || "").replace(/\u258B/g, "").trimEnd() === marker).length;
}
function hasText(host: HTMLElement, marker: string): boolean {
  return countText(host, marker) > 0;
}
const loadMoreBtn = (host: HTMLElement) => host.querySelector('[data-testid="load-more"]');
const loadCount = (sid: string) => events.filter((e) => e === `loadMsg:${sid}`).length;

describe("App fork pagination reaches the inherited base prefix (#197)", () => {
  test("walk: merged boundary page, seamless base continuation, head stop", async () => {
    resetFixtures();
    const { root, host } = await mountApp();
    await openProject(host);
    await openSession(host, FORK);

    // Page 1 = newest merged window (30 displayed of the 31-row probe page):
    // base tail src-24..50 (offsets -27..-1) + own 1..3.
    expect(calls.map((c) => c.before)).toEqual([0]);
    expect(hasText(host, "src-50")).toBe(true);
    expect(hasText(host, "src-24")).toBe(true);
    expect(hasText(host, "src-23")).toBe(false);
    expect(hasText(host, "own-user")).toBe(true);
    expect(hasText(host, "own-agent-3")).toBe(true);
    expect(loadMoreBtn(host)).not.toBeNull();

    // One click: own exhausted → the base continues seamlessly from src-23 down.
    click(loadMoreBtn(host)!);
    await flush();

    expect(calls.map((c) => c.before)).toEqual([0, -27]);
    expect(hasText(host, "src-1")).toBe(true);
    // Full merged transcript on screen, every row exactly once (no dup, no gap).
    for (let i = 1; i <= 50; i++) expect(countText(host, `src-${i}`)).toBe(1);
    expect(countText(host, "own-user")).toBe(1);
    expect(countText(host, "own-agent-2")).toBe(1);
    expect(countText(host, "own-agent-3")).toBe(1);
    // Base top reached → hasMore=false → the walk stops (button gone).
    expect(loadMoreBtn(host)).toBeNull();

    root.unmount();
    document.body.innerHTML = "";
  });

  test("dropped-while-idle busy switch-back heals at turn end: base prefix reachable again", async () => {
    resetFixtures();
    const { root, host } = await mountApp();
    await openProject(host);
    await openSession(host, FORK);
    expect(loadCount(FORK)).toBe(1);

    // Switch away while the fork is idle → memory saver drops the whole cache
    // (items, hasMore, oldestSeq cursor).
    await openSession(host, "s2");

    // A turn starts in the background; the streaming tail rebuilds the cache.
    statusesSnapshot[FORK] = "prompting";
    emit("chat:status", { sessionId: FORK, status: "prompting" });
    emit("chat:event", { sessionId: FORK, kind: "agent_message_chunk", messageId: "live-m1", text: "live-tail" });
    await flush();

    // Switch back while BUSY: #208 skips the re-pull (tail stays authoritative)
    // — and the session is left with NO page, NO cursor, NO hasMore: the
    // load-more path is dead, the base prefix unreachable.
    await openSession(host, FORK);
    expect(loadCount(FORK)).toBe(1);
    expect(hasText(host, "live-tail")).toBe(true);
    expect(hasText(host, "src-50")).toBe(false);
    expect(loadMoreBtn(host)).toBeNull();

    // Turn ends. The completed turn is persisted (incremental turn
    // persistence) — mirror that in the fixture — so a full re-pull is now
    // authoritative and must restore page + cursor + hasMore in one step.
    fork.own.push(mkMsg(FORK, 4, "live-tail", "agent"));
    delete statusesSnapshot[FORK];
    emit("chat:status", { sessionId: FORK, status: "idle" });
    await flush();
    await flush();

    // THE FIX: the busy → idle edge heals the dropped-cache session.
    expect(loadCount(FORK)).toBe(2);
    expect(hasText(host, "live-tail")).toBe(true);
    expect(hasText(host, "src-50")).toBe(true);
    expect(loadMoreBtn(host)).not.toBeNull();

    // And the walk continues into the base from the restored cursor.
    click(loadMoreBtn(host)!);
    await flush();
    expect(calls.map((c) => c.before)).toEqual([0, 0, -26]);
    expect(hasText(host, "src-1")).toBe(true);
    for (let i = 1; i <= 50; i++) expect(countText(host, `src-${i}`)).toBe(1);
    expect(countText(host, "live-tail")).toBe(1);
    expect(loadMoreBtn(host)).toBeNull();

    root.unmount();
    document.body.innerHTML = "";
  });
});
