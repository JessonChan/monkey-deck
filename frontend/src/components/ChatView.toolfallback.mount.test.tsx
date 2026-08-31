// Mount-test the #109 fallback tool-card UI: when a tool payload matches no
// known text key, the card shows the human digest line with a "structured
// output" marker, hides the machine payload behind a default-collapsed
// <details> ("View raw JSON") whose expanded <pre> carries the exact pretty
// JSON, and the copy buttons ship that faithful raw JSON — not the digest.
// Same skeleton as ChatView.permission-hint.mount.test.tsx: happy-dom +
// mocked bindings/i18n/tooltip/wails-runtime (i18n returns keys verbatim),
// real React tree otherwise.

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

// ---- geometry mocks (keeps the virtualizer's mount pass happy) ----
class MockResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) { this.cb = cb; }
  observe() {} unobserve() {} disconnect() {}
}
(globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;

// ---- clipboard capture: copyText routes to Wails Clipboard.SetText first ----
const clipboardWrites: string[] = [];
mock.module("@wailsio/runtime", () => ({
  Clipboard: { SetText: async (text: string) => { clipboardWrites.push(text); } },
  Events: { On: () => () => {}, Off: () => {}, Emit: async () => {} },
}));

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
mock.module("mermaid", () => ({
  default: {
    initialize: () => {},
    render: async () => ({ svg: "<svg/>", diagramType: "flowchart" }),
  },
}));

// Static import would load ChatView before mock.module() registers the fakes;
// bun applies mocks to modules loaded after registration (same as the other
// ChatView mount tests).
const { default: ChatView } = await import("./ChatView.tsx");
import type { ChatItem } from "../types";

// Fallback-shaped output: no known text key (output/content/…) matches, so
// extractToolText routes it through summarizeToolPayload → url+title digest.
const FALLBACK_OUTPUT = { url: "https://example.com", title: "Example Domain", fetchedAt: 1756500000 };
const FALLBACK_PRETTY = JSON.stringify(FALLBACK_OUTPUT, null, 2);

function toolItem(overrides: Partial<Extract<ChatItem, { type: "tool" }>> = {}): ChatItem {
  return {
    type: "tool", id: "t1", title: "fetch_page", status: "completed", kind: "",
    rawInput: "https://example.com",
    rawOutput: FALLBACK_OUTPUT,
    ...overrides,
  };
}

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

async function mount(items: ChatItem[]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<ChatView {...(baseProps(items) as never)} />);
  await flush();
  // Tool cards render their body lazily (Collapsible skips children while
  // collapsed) — open the card before asserting on the output section.
  host.querySelector<HTMLElement>(".tool-card .collapse-summary")!.dispatchEvent(click());
  await flush();
  return { host, root };
}

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 2));
}
const click = () => new window.MouseEvent("click", { bubbles: true, button: 0 });

describe("GenericToolCard fallback UI (#109 rework)", () => {
  test("digest line + structured marker; raw JSON disclosure defaults collapsed", async () => {
    const { host, root } = await mount([toolItem()]);

    // Marker badge present (i18n key asserted verbatim: t() is the identity stub).
    expect(host.querySelector('[data-testid="generic-fallback-badge"]')?.textContent).toBe("chat.structuredOutput");

    // The digest is the url+title summary — human text, no JSON braces on screen.
    const outputPre = host.querySelector(".tool-card pre:not(.tool-term)");
    expect(outputPre?.textContent).toContain("Example Domain");
    expect(outputPre?.textContent).toContain("https://example.com");
    expect(outputPre?.textContent).not.toContain("{");

    // Raw disclosure exists and defaults collapsed.
    const summary = host.querySelector('[data-testid="generic-raw-output"]');
    expect(summary).not.toBeNull();
    const details = summary!.closest("details");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);

    root.unmount();
    host.remove();
  });

  test("expanding the disclosure renders the exact pretty JSON", async () => {
    const { host, root } = await mount([toolItem()]);

    const summary = host.querySelector('[data-testid="generic-raw-output"]')!;
    summary.dispatchEvent(click());
    await flush();

    const details = summary.closest("details")!;
    expect(details.open).toBe(true);
    const pre = details.querySelector(".tool-raw-pre");
    expect(pre?.textContent).toBe(FALLBACK_PRETTY);

    root.unmount();
    host.remove();
  });

  test("summary copy button ships the raw JSON, not the digest", async () => {
    const { host, root } = await mount([toolItem()]);

    const before = clipboardWrites.length;
    host.querySelector('[data-testid="generic-summary-copy"]')!.dispatchEvent(click());
    await flush();

    const writes = clipboardWrites.slice(before);
    expect(writes).toEqual([FALLBACK_PRETTY]);

    root.unmount();
    host.remove();
  });

  test("non-fallback (string) output keeps the old contract: no marker, copy = text", async () => {
    const { host, root } = await mount([toolItem({ rawOutput: "plain command output" })]);

    expect(host.querySelector('[data-testid="generic-fallback-badge"]')).toBeNull();
    expect(host.querySelector('[data-testid="generic-raw-output"]')).toBeNull();

    const before = clipboardWrites.length;
    host.querySelector('[data-testid="generic-summary-copy"]')!.dispatchEvent(click());
    await flush();
    expect(clipboardWrites.slice(before)).toEqual(["plain command output"]);

    root.unmount();
    host.remove();
  });
});
