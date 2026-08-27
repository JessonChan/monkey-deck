// Mount-test for LaTeX math rendering (#135): remark-math parses $...$ /
// $$..$$ / ```math fences inside AgentMarkdown, and ChatView routes the
// resulting <code.language-math> nodes to KaTeX-backed renderers.
//
// Structural contract pinned here:
// - inline math -> [data-testid="math-inline"] (never swallowed by CodeRenderer
//   as a plain code block — its className carries "language-" too);
// - $$ blocks AND ```math fences -> [data-testid="math-block"];
// - both chat surfaces wired: agent bubbles AND user markdown bubbles;
// - plain code fences and unclosed "$" text stay OFF the math path.
//
// Same recipe as ChatView.table.mount.test.tsx / MermaidRenderer.mount.test.tsx:
// happy-dom + real React tree + real react-markdown pipeline, with the dynamic
// `import("katex")` stubbed so no ~300KB / font assets load in tests. The lib
// records (source, displayMode) so we can assert both shapes reach katex.

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

// ---- geometry mocks (same shape as the table/virtual-mount tests) ----
const mockRowH = 100;
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get() {
    return mockRowH;
  },
});
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get() {
    return mockRowH * 10;
  },
});
class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
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

// ---- fake katex + stylesheet (stub the lazy chunk, not our wiring) ----
// Our lib resolves `mod.default.renderToString`; markers let assertions tell
// display vs inline renders apart. Call log pins what actually reached katex.
const katexCalls: Array<{ src: string; displayMode: boolean }> = [];
mock.module("katex", () => ({
  default: {
    renderToString: (src: string, opts?: { displayMode?: boolean }) => {
      const displayMode = Boolean(opts?.displayMode);
      katexCalls.push({ src, displayMode });
      return `<i data-fake-katex="${displayMode ? "d" : "i"}">${src}</i>`;
    },
  },
}));
// The stylesheet co-import is Vite-side; under bun test it must not hit disk.
mock.module("katex/dist/katex.min.css", () => ({}));

// Import after mocks (dynamic literal import, same reason as the table test).
const { default: ChatView } = await import("./ChatView.tsx");
import type { ChatItem } from "../types";

const INLINE_MD = "Energy $E=mc^2$ drives it.";
// Content MUST start on its own line after `$$` — fence-adjacent text is meta
// (micromark semantics), not formula body.
const BLOCK_MD = "Header\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\nDone.";
const FENCE_MD = "```math\nE = h\\nu\n```";
// Fence prefix flips the user-bubble classifier into markdown mode (same trick
// as the #136 table test).
const USER_FENCED_MD = "```\nctx\n```\n\nTry $a^2+b^2=c^2$ now.";

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
  // React commit + passive effects + the async katex promise chain.
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 2));
}

describe("AgentMarkdown LaTeX math (#135)", () => {
  test("inline $...$ renders via MathInline, off the code path", async () => {
    const { host, root } = mount([{ type: "agent", id: "a1", text: INLINE_MD }]);
    await flush();

    const inlined = host.querySelectorAll(".bubble-agent [data-testid='math-inline']");
    expect(inlined.length).toBe(1);
    // Fake marker proves the html came from the (stubbed) katex pipeline.
    expect(inlined[0]!.innerHTML).toContain('data-fake-katex="i"');
    expect(inlined[0]!.innerHTML).toContain("E=mc^2");
    // Source fallback cleared once rendered.
    expect(host.querySelector(".md-math-src")).toBeNull();
    // Not swallowed as inline CODE either.
    const codeInline = Array.from(host.querySelectorAll(".code-inline")).map((el) => el.textContent ?? "");
    expect(codeInline.some((s) => s.includes("mc"))).toBe(false);

    root.unmount();
    host.remove();
  });

  test("$$ block with content on its own lines renders as MathBlock", async () => {
    const callsBefore = katexCalls.length;
    const { host, root } = mount([{ type: "agent", id: "a2", text: BLOCK_MD }]);
    await flush();

    const blocks = host.querySelectorAll(".bubble-agent [data-testid='math-block']");
    expect(blocks.length).toBe(1);
    const body = blocks[0]!.querySelector("[data-testid='math-body']");
    expect(body).not.toBeNull();
    expect(body!.innerHTML).toContain('data-fake-katex="d"');
    expect(body!.innerHTML).toContain("\\int_0^1 x^2\\,dx");
    // Reached katex exactly once for this bubble, in display mode.
    expect(katexCalls.slice(callsBefore)).toEqual([
      { src: "\\int_0^1 x^2\\,dx = \\frac{1}{3}", displayMode: true },
    ]);

    root.unmount();
    host.remove();
  });

  test("```math fence converges on the same MathBlock route", async () => {
    const { host, root } = mount([{ type: "agent", id: "a3", text: FENCE_MD }]);
    await flush();

    const blocks = host.querySelectorAll(".bubble-agent [data-testid='math-block']");
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.querySelector("[data-testid='math-body']")!.innerHTML).toContain('data-fake-katex="d"');
    // Must NOT render as a highlight.js code box like ordinary fences do.
    expect(host.querySelector(".bubble-agent .code-box")).toBeNull();

    root.unmount();
    host.remove();
  });

  test("user markdown bubble gets identical math treatment", async () => {
    const { host, root } = mount([{ type: "user", id: "u1", text: USER_FENCED_MD }]);
    await flush();

    const scope = host.querySelector(".bubble-user-markdown");
    expect(scope).not.toBeNull();
    const inlined = scope!.querySelectorAll("[data-testid='math-inline']");
    expect(inlined.length).toBe(1);
    expect(inlined[0]!.innerHTML).toContain('data-fake-katex="i"');

    root.unmount();
    host.remove();
  });

  test("plain code fences stay on the CodeBox path (no overreach)", async () => {
    const callsBefore = katexCalls.length;
    const { host, root } = mount([{ type: "agent", id: "a4", text: "```js\nconsole.log(1)\n```" }]);
    await flush();

    expect(host.querySelector(".bubble-agent .code-box")).not.toBeNull();
    expect(host.querySelectorAll("[data-testid='math-block']").length).toBe(0);
    expect(katexCalls.length).toBe(callsBefore);

    root.unmount();
    host.remove();
  });

  test("unclosed single '$' stays literal text (money-text boundary)", async () => {
    const { host, root } = mount([{ type: "agent", id: "a5", text: "Costs $5 each, buy more." }]);
    await flush();

    expect(host.querySelectorAll("[data-testid='math-inline']").length).toBe(0);
    expect(host.textContent).toContain("$5");

    root.unmount();
    host.remove();
  });
});
