// Mount-test for copy-as-markdown-source (#177): the REAL react-markdown
// pipeline (remark-gfm + remark-math) renders an agent message, ChatView's
// components map stamps data-md-s/e onto core elements, and those offsets must
// be byte-valid against the raw source. End-to-end selection → toolbar Copy →
// clipboard runs through the real SelectionToolbar (lib-level span algebra is
// covered by lib/markdownSource.test.ts).
//
// Same recipe as ChatView.table.mount.test.tsx: stub bindings, mock
// ResizeObserver/geometry, real React tree + real renderer pipeline. Range
// rects are shimmed (happy-dom has no layout) so SelectionToolbar's zero-size
// guard lets the toolbar render.
//
// The `await import()` of ChatView/markdownSource below is deliberate: bun
// mock.module must run before the component graph resolves its module
// specifiers, which a hoisted static import would break (established repo
// test pattern).

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
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.DOMRect = window.DOMRect;
window.React = React;

// ---- geometry mocks (virtualizer measurement; happy-dom has no layout) ----
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

// SelectionToolbar skips the toolbar when every range rect is zero — give
// ranges a small non-zero rect (same shim as EditorPane.quote.mount.test).
const rangeProto = document.createRange().constructor.prototype as unknown as {
  getBoundingClientRect: () => DOMRect;
};
rangeProto.getBoundingClientRect = () => new DOMRect(5, 5, 10, 10);

// ---- binding / i18n / tooltip / clipboard mocks ----
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
// Clipboard capture: the Copy action must hand the markdown source (or the
// plain-text fallback) to copyTextQuiet.
const copied: string[] = [];
mock.module("../lib/clipboard", () => ({
  execCommandCopy: () => true,
  copyText: async (text: string) => {
    copied.push(text);
    return true;
  },
  copyTextQuiet: (text: string) => {
    copied.push(text);
  },
}));

const { default: ChatView } = await import("./ChatView.tsx");
const { markdownSourceFromSelection } = await import("../lib/markdownSource.ts");
import type { ChatItem } from "../types";

const MD = [
  "Intro with **bold** text.",
  "",
  "| A | B |",
  "| --- | --- |",
  "| a1 | b1 |",
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
  "- li one",
  "- li two",
].join("\n");
const TABLE_SRC = ["| A | B |", "| --- | --- |", "| a1 | b1 |"].join("\n");
const FENCE_SRC = "```ts\nconst x = 1;\n```";
const ITEM: ChatItem = { type: "agent", id: "agent-1", text: MD };
const PROSE = "just some plain prose words";
const PROSE_ITEM: ChatItem = { type: "user", id: "user-1", text: PROSE };

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

function mount(items: ChatItem[]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(React.createElement(ChatView, baseProps(items) as never));
  return { host, root };
}

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 2));
}

function click(el: Element) {
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
}

// Install a real DOM selection (whole anchor node → whole focus node) and run
// the toolbar's selectionchange-driven compute via a manual event + flush.
async function selectNodes(anchor: Node, focus: Node) {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.setBaseAndExtent(anchor, 0, focus, focus.nodeType === 3 ? (focus as Text).length : focus.childNodes.length);
  document.dispatchEvent(new window.Event("selectionchange"));
  await flush();
  return sel;
}

function sourceOf(el: Element): string {
  return MD.slice(Number(el.getAttribute("data-md-s")), Number(el.getAttribute("data-md-e")));
}

beforeEach(() => {
  copied.length = 0;
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

describe("copy markdown source (#177)", () => {
  test("core elements carry byte-valid data-md-s/e against the raw source", async () => {
    const { host, root } = mount([ITEM]);
    await flush();

    const bubble = host.querySelector(".bubble-agent")!;
    expect(bubble.getAttribute("data-md-msg")).toBe("agent-1");

    const expectations: [string, string][] = [
      ["p", "Intro with **bold** text."],
      ["strong", "**bold**"],
      [".md-table-wrap", TABLE_SRC],
      // mdast tableCell spans include the surrounding pipes (probe-verified:
      // cell "A" covers "| A ") — byte-valid, just not standalone markdown.
      ["thead th", "| A "],
      ["tbody td", "| a1 "],
      [".code-box", FENCE_SRC],
      ["li", "- li one"],
    ];
    for (const [selector, expected] of expectations) {
      const el = bubble.querySelector(selector)!;
      expect(el.hasAttribute("data-md-s"), selector).toBe(true);
      expect(el.hasAttribute("data-md-e"), selector).toBe(true);
      expect(sourceOf(el), selector).toBe(expected);
    }

    // Nothing rendered by the markdown pipeline slipped through unanchored.
    // CodeBox internals (highlight.js <code>) are not pipeline elements.
    for (const el of Array.from(bubble.querySelectorAll("p,strong,em,del,a,code,ul,ol,li,blockquote,h1,h2,h3,h4,h5,h6"))) {
      if (el.closest(".code-box")) continue;
      expect(el.hasAttribute("data-md-s") && el.hasAttribute("data-md-e"), el.tagName).toBe(true);
    }

    root.unmount();
    host.remove();
  });

  test("selection across table cells resolves to the whole table's source", async () => {
    const { host, root } = mount([ITEM]);
    await flush();

    const th = host.querySelector(".md-table-wrap thead th")!;
    const td = host.querySelectorAll(".md-table-wrap tbody td")[1]!;
    await selectNodes(th, td);
    expect(markdownSourceFromSelection(MD)).toBe(TABLE_SRC);

    root.unmount();
    host.remove();
  });

  test("toolbar Copy puts the markdown source on the clipboard (bold phrase)", async () => {
    const { host, root } = mount([ITEM]);
    await flush();

    const strong = host.querySelector(".bubble-agent strong")!;
    await selectNodes(strong, strong);
    click(host.querySelector('[data-testid="selection-copy"]')!);
    await flush();
    expect(copied).toEqual(["**bold**"]);

    root.unmount();
    host.remove();
  });

  test("toolbar Copy yields the fenced code block for a selection inside the code box", async () => {
    const { host, root } = mount([ITEM]);
    await flush();

    const code = host.querySelector(".code-box .code-box-code")!;
    await selectNodes(code, code);
    click(host.querySelector('[data-testid="selection-copy"]')!);
    await flush();
    expect(copied).toEqual([FENCE_SRC]);

    root.unmount();
    host.remove();
  });

  test("selection with no markdown anchors falls back to plain text", async () => {
    const { host, root } = mount([ITEM, PROSE_ITEM]);
    await flush();

    const prose = host.querySelector(".bubble-user-prose")!;
    expect(prose.closest("[data-md-msg]")?.getAttribute("data-md-msg")).toBe("user-1");
    await selectNodes(prose, prose);
    click(host.querySelector('[data-testid="selection-copy"]')!);
    await flush();
    // No data-md-s/e inside a prose bubble → empty source → plain text copy.
    expect(copied).toEqual([PROSE]);

    root.unmount();
    host.remove();
  });
});
