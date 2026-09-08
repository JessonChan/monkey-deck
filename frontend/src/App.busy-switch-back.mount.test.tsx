// App-level mount tests for #208: switching back to a BUSY session must skip
// the LoadMessagesPage re-pull so the in-memory streaming tail survives.
//
// Background: chat:event handlers write itemsBySession[sid] keyed on the
// EVENT's sessionId, not the selection — a backgrounded mid-turn session keeps
// accumulating its streaming tail in memory. openSession's pull REPLACES that
// array, so re-pulling a busy target clobbers the tail (mid-flight entry +
// segments not repulled). The gate: target status "prompting" → skip the pull.
//
// Scenarios (real App → Sidebar → openSession wiring, bindings mocked):
//   1. Busy target, first open: no DB pull at all; the event-built tail renders.
//   2. Drift (prompting push lands AFTER the switch-away drop): the tail rebuilt
//      by background events survives the switch-back — one pull total, no clobber.
//   3. Idle switch-back still re-pulls (2026-07-18 memory-saver reload intact).
//   4. Protected busy switch-back (cache never dropped): tail intact, one pull.
//
// Scaffolding mirrors App.commands-seed.mount.test.tsx: ALL mocks (runtime +
// full ChatService surface) are registered BEFORE the dynamic App import — a
// static import would evaluate the real binding modules before the mocks
// replace them, and bun's mock.module does not relink already-evaluated
// modules (that is why test/chatservice-mock's statically-imported helper
// cannot be used here: importing it pre-loads the real binding). The surface
// is built from the generated binding's SOURCE TEXT instead of importing it,
// so a stale method list fails loudly instead of silently dropping a method.
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

// ---- ResizeObserver mock: panels/ChatView measure on mount ----
class MockResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) { this.cb = cb; }
  observe(_el: Element) {}
  unobserve(_el: Element) {}
  disconnect() {}
}
(globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;

// ---- backend bindings mock ----
const events: string[] = [];
// The persisted page for s1 carries distinctive content: if a re-pull ever
// lands on a busy target, "db-history" appears and the live tail vanishes —
// the clobber is observable in both directions.
let s1Page: Message[] = [];
function resetFixtures() {
  events.length = 0;
  s1Page = [
    { id: "db1", sessionId: "s1", role: "agent", kind: "", content: "db-history", seq: 1, createdAt: 1 },
  ];
}
resetFixtures();

const emit = (name: string, data: unknown) => eventHandlers.get(name)?.({ data });

// Method names parsed from the generated binding source (no module load — see
// the scaffolding NOTE at the top of this file).
const CHAT_METHODS: string[] = [
  ...readFileSync(new URL("./bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice.ts", import.meta.url), "utf8")
    .matchAll(/export function (\w+)/g),
].map((m) => m[1]);
if (CHAT_METHODS.length === 0) throw new Error("busy-switch-back test: could not parse ChatService methods from the generated binding");

const chatserviceOverrides: Record<string, unknown> = {
  ListProjects: async () => [{ id: "p1", name: "demo", path: "/tmp/demo" }],
  HasGitContext: async () => false,
  ListSessions: async () => [
    { id: "s1", projectId: "p1", title: "one", harness: "omp" },
    { id: "s2", projectId: "p1", title: "two", harness: "omp" },
  ],
  ListHarnesses: async () => [],
  SessionStatuses: async () => ({}),
  OpenSession: async () => null,
  LoadMessagesPage: async (sid: string) => {
    events.push(`loadMsg:${sid}`);
    return sid === "s1" ? s1Page : [];
  },
  ListUserMessages: async () => [],
  GetSessionCachedConfigOptions: async () => [],
  GetSessionCachedCommands: async () => [],
  GetSessionSnapshot: async () => JSON.stringify({ draft: "" }),
  SessionChanges: async () => null,
  SessionMergeable: async () => false,
  WorktreeKind: async () => "project",
};

// Raw event payload — emit() wraps it in the { data } envelope exactly once.
const chunk = (text: string) => ({ sessionId: "s1", kind: "agent_message_chunk", messageId: "m1", text });
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

function agentTexts(host: HTMLElement): string[] {
  return [...host.querySelectorAll('[data-testid="msg-agent"]')].map((el) => el.textContent || "");
}

// Row textContent concatenates the bubble text with meta (timestamp, action
// buttons), so assertions match by substring rather than whole-row equality.
function hasAgentText(host: HTMLElement, text: string): boolean {
  return agentTexts(host).some((t) => t.includes(text));
}

const loadCount = (sid: string) => events.filter((e) => e === `loadMsg:${sid}`).length;

describe("App busy switch-back skips the re-pull, keeps the streaming tail (#208)", () => {
  test("busy target, first open: no DB pull, the event-built tail renders", async () => {
    resetFixtures();
    const { root, host } = await mountApp();
    await openProject(host);

    // Turn already running in the background: the prompting push and the
    // streaming tail land BEFORE any open — the cache is event-built only.
    emit("chat:status", { sessionId: "s1", status: "prompting" });
    emit("chat:event", chunk("live-tail"));
    await flush();

    await openSession(host, "s1");

    // The busy gate must suppress the re-pull and keep the tail on screen;
    // a pull would replace it with the "db-history" page.
    expect(hasAgentText(host, "live-tail")).toBe(true);

    root.unmount();
    document.body.innerHTML = "";
  });

  test("dropped-while-idle busy tail survives switch-back (no re-pull, no clobber)", async () => {
    resetFixtures();
    const { root, host } = await mountApp();
    await openProject(host);
    await openSession(host, "s1");
    expect(loadCount("s1")).toBe(1);

    // Tail starts streaming while the status push has NOT landed yet — the
    // cache is still droppable (this is the drift that created the bug).
    emit("chat:event", chunk("live-tail"));
    await flush();

    // Switch away: s1 reads as "empty" → memory saver drops the cache...
    await openSession(host, "s2");
    // ...and the prompting push lands late; background chunks keep
    // rebuilding the tail in the (fresh) cache.
    emit("chat:status", { sessionId: "s1", status: "prompting" });
    emit("chat:event", chunk("live-tail-tail2"));
    await flush();

    // Switch back: busy target → no re-pull, the tail stays authoritative.
    await openSession(host, "s1");
    expect(loadCount("s1")).toBe(1);
    expect(hasAgentText(host, "live-tail-tail2")).toBe(true);
    expect(host.textContent).not.toContain("db-history");

    root.unmount();
    document.body.innerHTML = "";
  });

  test("idle switch-back still re-pulls from DB (memory-saver reload intact)", async () => {
    resetFixtures();
    const { root, host } = await mountApp();
    await openProject(host);
    await openSession(host, "s1");

    // s1 is idle → dropped on switch-away → re-pulled on switch-back.
    await openSession(host, "s2");
    await openSession(host, "s1");

    expect(loadCount("s1")).toBe(2);
    expect(hasAgentText(host, "db-history")).toBe(true);

    root.unmount();
    document.body.innerHTML = "";
  });

  test("protected busy switch-back: cache kept, tail grows, one pull total", async () => {
    resetFixtures();
    const { root, host } = await mountApp();
    await openProject(host);
    await openSession(host, "s1");

    // Prompting lands BEFORE the switch: the drop predicate protects s1.
    emit("chat:status", { sessionId: "s1", status: "prompting" });
    emit("chat:event", chunk("live-tail"));
    await flush();
    await openSession(host, "s2");
    emit("chat:event", chunk("live-tail-tail2"));
    await flush();
    await openSession(host, "s1");

    // Cache never dropped (loadedSessionsRef guard) → one pull total, and the
    // DB seed + the live tail coexist.
    expect(loadCount("s1")).toBe(1);
    expect(hasAgentText(host, "db-history")).toBe(true);
    expect(hasAgentText(host, "live-tail-tail2")).toBe(true);

    root.unmount();
    document.body.innerHTML = "";
  });
});
