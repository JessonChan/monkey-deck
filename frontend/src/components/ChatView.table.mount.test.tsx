// Mount-test for the markdown table treatment (#136): AgentMarkdown must wrap
// every GFM <table> in a .md-table-wrap scroll container so wide tables scroll
// horizontally instead of stretching the chat column, and the wrapper-based
// CSS hook must reach BOTH chat surfaces — agent bubbles (.bubble-agent) and
// user markdown (.bubble-user-markdown, which does NOT inherit .bubble-agent
// scoping). Structural contract here; visual grid/header styling lives in
// index.css (.md-table-wrap rules) and needs a real webview to judge.
//
// Same recipe as ChatView.virtual.mount.test.tsx: stub bindings (no backend
// calls during mount), mock ResizeObserver (absent in happy-dom), everything
// else runs through the real React tree + real remark-gfm pipeline.

import { describe, test, expect, mock } from "bun:test";
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

// ---- geometry mocks (same shape as the virtual-mount test; keeps the
//      virtualizer's measurement loop deterministic) ----
const mockRowH = 100;
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    if (this.classList?.contains("cv-item")) return mockRowH;
    return 0;
  },
});
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList?.contains("chat-body") ? 600 : 0;
  },
});

// Width axes mirror the height mocks above: 0 unless a test pins explicit
// numbers in mockWidths (happy-dom performs no layout) — enough to exercise
// containment arithmetic without a real engine.
const mockWidths = new WeakMap<
  Element,
  { clientWidth?: number; scrollWidth?: number; offsetWidth?: number }
>();
for (const prop of ["clientWidth", "scrollWidth", "offsetWidth"] as const) {
  Object.defineProperty(window.HTMLElement.prototype, prop, {
    configurable: true,
    get(this: HTMLElement) {
      return mockWidths.get(this)?.[prop] ?? 0;
    },
  });
}

class MockResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(_el: Element) {}
  unobserve(_el: Element) {}
  disconnect() {}
}
(globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;

// ---- binding / i18n / tooltip mocks (nothing touches the backend at mount) ----
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => ({
  ToggleMaximise: async () => {},
  OpenURL: async () => {},
  SessionReadFile: async () => "",
  SessionListDir: async () => [],
  SessionFuzzyFind: async () => [],
  PickFiles: async () => [],
  GetSessionMcpServers: async () => [],
}));
mock.module("react-tooltip", () => ({ Tooltip: () => null, default: () => null }));
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: "3rd-party" },
  default: { useTranslation: () => ({ t: (k: string) => k }) },
}));

// Import after mocks so the component graph resolves the stubs.
// Dynamic import with a literal path is REQUIRED: mock.module registrations
// above must execute before the component graph resolves its dependencies;
// a static import would hoist ChatView above the stubs (bun test pattern,
// same as ChatView.virtual.mount.test.tsx).
const { default: ChatView } = await import("./ChatView.tsx");
import type { ChatItem } from "../types";

// Bare GFM table (no fences).
const TABLE_MD = ["| Layer | Tech |", "| --- | --- |", "| UI | React 19 |", "| Backend | Go |"].join("\n");

// Fence prefix flips the user-bubble classifier into "markdown" mode (content
// classification lives in ChatRow; a lone table without fences stays mono/prose).
const TABLE_MD_FENCED = "```\nctx\n```\n\n" + TABLE_MD;

function baseProps(items: ChatItem[]) {
  return {
    project: null,
    session: { id: "s1" },
    items,
    status: "idle",
    statusDetail: "",
    usage: { used: 0, size: 0, cost: 0, cachedReadTokens: 0, cachedWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
    error: null,
    permission: null,
    mergeResult: null,
    sessionDiff: null,
    onSend: () => {},
    onEnqueue: () => {},
    onStop: () => {},
    onContinue: () => {},
    onRespondPermission: () => {},
    onToggleTerminal: () => {},
    onRefreshConfig: () => {},
    onMerge: () => {},
    queue: [],
    onInterruptQueue: () => {},
    onRevokeQueue: () => {},
    onEditQueue: () => {},
    onScheduleQueue: () => {},
    onReorderQueue: () => {},
    composerValue: "",
    onComposerChange: () => {},
    attachments: [],
    onAttachmentsChange: () => {},
    mentions: [],
    onMentionsChange: () => {},
    images: [],
    onImagesChange: () => {},
    imageSupported: false,
    audios: [],
    onAudiosChange: () => {},
    audioSupported: false,
    history: [],
    sessionId: "s1",
    configOptions: [],
    branch: "",
    livePlan: null,
    onSetConfig: () => {},
    hasMore: false,
    loadingMore: false,
    onLoadMore: () => {},
  };
}

function mount(items: ChatItem[]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<ChatView {...(baseProps(items) as never)} />);
  return { host, root };
}

async function flush() {
  // happy-dom + React 19 need several ticks to finish commit + passive effects.
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 2));
}

describe("AgentMarkdown table wrapper (#136)", () => {
  test("non-fence user text stays off the markdown path (no accidental wrap)", async () => {
    const { host, root } = mount([{ type: "user", id: "u2", text: TABLE_MD }]);
    await flush();
    // Bare pipe rows don't trip the code/log heuristic -> prose branch. Either
    // non-markdown branch (prose or mono) satisfies the boundary being pinned
    // here: no markdown rendering, hence no .md-table-wrap.
    expect(host.querySelector(".md-table-wrap")).toBeNull();
    expect(
      host.querySelector(".bubble-user-prose") ?? host.querySelector(".bubble-user-mono")
    ).not.toBeNull();

    root.unmount();
    host.remove();
  });
  test("agent-bubble table lands inside .md-table-wrap with full grid skeleton", async () => {
    const { host, root } = mount([{ type: "agent", id: "a1", text: TABLE_MD }]);
    await flush();

    const wraps = host.querySelectorAll(".bubble-agent .md-table-wrap");
    expect(wraps.length).toBe(1);

    // No naked tables: every rendered table must sit inside the scroll wrapper.
    expect(host.querySelectorAll(".bubble-agent table").length).toBe(
      host.querySelectorAll(".bubble-agent .md-table-wrap table").length
    );

    const table = wraps[0].querySelector("table");
    expect(table).not.toBeNull();
    expect(table!.querySelectorAll("thead th").length).toBe(2);
    expect(table!.querySelectorAll("tbody td").length).toBe(4);
    expect(table!.querySelectorAll("thead th")[0]!.textContent).toBe("Layer");

    root.unmount();
    host.remove();
  });

  test("user markdown bubble gets the same wrapper (single rule set)", async () => {
    const { host, root } = mount([{ type: "user", id: "u1", text: TABLE_MD_FENCED }]);
    await flush();

    const wraps = host.querySelectorAll(".bubble-user-markdown .md-table-wrap");
    expect(wraps.length).toBe(1);
    expect(wraps[0].querySelectorAll("thead th").length).toBe(2);
    expect(host.querySelectorAll(".bubble-user-markdown table").length).toBe(
      host.querySelectorAll(".bubble-user-markdown .md-table-wrap table").length
    );

    root.unmount();
    host.remove();
  });

  // #139 P1 regression guard. Real-layout pixels need a webview, so the
  // boundary is pinned here as arithmetic over the mocked width axes: whatever
  // CSS ships on either chat surface, a rendered table must either scroll
  // horizontally ITSELF (excess routed into its own scrollbar) or fit inside
  // its .md-table-wrap — never sit unscrollably wider than it. The user face
  // burst pre-fix by growing WITH the table past .bubble-user-wrap's 76% cap,
  // so this test also pins the DOM chain ".bubble-user-wrap .bubble-user →
  // …md-table-wrap" that the MQ containment rule keys off.
  test("user markdown table stays contained in the bubble (#139)", async () => {
    const { host, root } = mount([{ type: "user", id: "u6", text: TABLE_MD_FENCED }]);
    await flush();

    const wrap = host.querySelector(".bubble-user-wrap .bubble-user .md-table-wrap");
    expect(wrap).not.toBeNull();
    const table = wrap!.querySelector("table");
    expect(table).not.toBeNull();

    // No naked tables in the user surface either (parity with agent surface).
    expect(host.querySelectorAll(".bubble-user-wrap table").length).toBe(
      host.querySelectorAll(".bubble-user-wrap .md-table-wrap table").length
    );

    // Overflow regime (390px chat: ~254px bubble cap vs a wider table) — fine
    // only because the table scrolls itself…
    mockWidths.set(wrap!, { clientWidth: 254 });
    mockWidths.set(table!, { scrollWidth: 397, offsetWidth: 397 });
    expect(
      table!.scrollWidth > wrap!.clientWidth || table!.offsetWidth <= wrap!.clientWidth
    ).toBe(true);

    // …and the fit regime counts as contained too.
    mockWidths.set(table!, { scrollWidth: 200, offsetWidth: 200 });
    expect(
      table!.scrollWidth > wrap!.clientWidth || table!.offsetWidth <= wrap!.clientWidth
    ).toBe(true);

    root.unmount();
    host.remove();
  });

});
