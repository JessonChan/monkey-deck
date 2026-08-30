// Mount-test EditorPane selection toolbar source footnote (issue #168).
//
// Pins the observable contract of quoting / copying a text selection out of
// the CodeViewer view:
//   1. Single-line selection → the quote payload ends with "— <path>:N".
//   2. Cross-line selection → "— <path>:N-M" with N≤M ascending, regardless
//      of drag direction (backward selections have anchor after focus).
//   3. The toolbar Copy action's clipboard payload carries the same footnote.
//   4. A selection whose endpoints can't be resolved to a CodeViewer row
//      (e.g. the language chip) degrades to the plain text — no footnote,
//      no crash (exact pre-#168 behavior).
//
// The flow is driven end-to-end against the real SelectionToolbar: install a
// real DOM selection, dispatch selectionchange (the toolbar's compute runs on
// it), then click the real toolbar button. Only the layout engine is shimmed:
// happy-dom returns all-zero rects, which would trip the toolbar's zero-size
// guard before it ever shows (same recipe as QueuePanel.list-budget.mount.test).

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
window.React = React;

// ---- in-memory "disk" the mocked bindings serve ----
type FileDataLike = { content: string; binary: boolean; tooLarge: boolean };
const disk: Record<string, FileDataLike> = {};

// Full export surface (same rationale as EditorPane.edit.mount.test.tsx: bun
// test shares one module registry, so a partial mock would break sibling
// modules calling exports we don't use).
const bindingUrl = (ext: string) =>
  new URL(`../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice.${ext}`, import.meta.url);
let bindingSrc: string;
try {
  bindingSrc = await Bun.file(bindingUrl("ts")).text();
} catch {
  bindingSrc = await Bun.file(bindingUrl("js")).text();
}
const chatServiceMock: Record<string, unknown> = {};
for (const m of bindingSrc.matchAll(/^export (?:async )?function (\w+)/gm)) {
  chatServiceMock[m[1]] = async () => undefined;
}
chatServiceMock.SessionReadFile = async (_sid: string, rel: string) =>
  disk[rel] ?? { content: "", binary: false, tooLarge: false };
chatServiceMock.SessionReadImage = async () => ({ dataUrl: "", ext: "" });
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => chatServiceMock);
mock.module("react-tooltip", () => ({ Tooltip: () => null, default: () => null }));
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: "3rd-party" },
  default: { useTranslation: () => ({ t: (k: string) => k }) },
}));

// Capture the toolbar Copy payload instead of touching a real clipboard.
const copiedViaToolbar: string[] = [];
mock.module("../lib/clipboard", () => ({
  execCommandCopy: () => true,
  copyText: async (text: string) => {
    copiedViaToolbar.push(text);
    return true;
  },
  copyTextQuiet: (text: string) => {
    copiedViaToolbar.push(text);
  },
}));

// happy-dom has no layout engine: Range rects come back all-zero, which would
// trip SelectionToolbar's zero-size guard. Give every range a small non-zero
// rect (unchecked cast, named once — QueuePanel.list-budget.mount.test recipe).
const rangeProto = document.createRange().constructor.prototype as unknown as {
  getBoundingClientRect: () => DOMRect;
};
rangeProto.getBoundingClientRect = () =>
  ({ x: 4, y: 4, width: 24, height: 12, top: 4, left: 4, right: 28, bottom: 16, toJSON() { return this; } } as DOMRect);

// Component imported AFTER mock registration so its module graph resolves to
// the mocks (bun mock.module only affects post-registration resolution).
const EditorPane = (await import("./EditorPane.tsx")).default;

function mount(jsx: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(jsx);
  return { host, root };
}

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
}

function click(el: Element) {
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
}

// Select whole CodeViewer rows [from..to] (1-based). `dir` controls drag
// direction: "forward" anchors at `from`, "backward" anchors at `to` (focus
// ends on `from`) to pin the ascending N-M normalization. Boundaries are set
// on the row's <code> ELEMENT (not its text nodes) so highlight.js span
// wrapping can't shift offsets. Returns the selection's plain text.
async function selectLines(host: HTMLElement, from: number, to: number, dir: "forward" | "backward") {
  const codeOf = (n: number) => {
    const el = host.querySelector(
      `[data-testid="editor-pane-viewer"] [data-line="${n}"] code`,
    ) as Element;
    if (!el) throw new Error(`missing code element for line ${n}`);
    return el;
  };
  const a = codeOf(from);
  const b = codeOf(to);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  if (dir === "forward") sel.setBaseAndExtent(a, 0, b, b.childNodes.length);
  else sel.setBaseAndExtent(b, 0, a, a.childNodes.length);
  // happy-dom doesn't fire selectionchange from Selection mutations; the
  // toolbar's compute is driven manually (it's rAF-coalesced → flush covers).
  document.dispatchEvent(new window.Event("selectionchange"));
  await flush();
  return sel.toString();
}

const PROPS = {
  sessionId: "s1",
  onClose: () => {},
};
const PATH = "src/main.ts";
const CONTENT = "alpha\nbeta\ngamma\n";

beforeEach(() => {
  for (const k of Object.keys(disk)) delete disk[k];
  copiedViaToolbar.length = 0;
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

describe("EditorPane selection toolbar: source footnote (#168)", () => {
  test("single-line quote appends — path:N", async () => {
    disk[PATH] = { content: CONTENT, binary: false, tooLarge: false };
    const quoted: string[] = [];
    const { host } = mount(
      <EditorPane {...PROPS} file={{ path: PATH }} onQuoteToComposer={(t) => quoted.push(t)} />,
    );
    await flush();

    const text = await selectLines(host, 2, 2, "forward");
    const btn = host.querySelector('[data-testid="editor-selection-quote"]');
    expect(btn).not.toBeNull();
    click(btn as Element);
    await flush();

    expect(quoted).toEqual([`${text}\n— ${PATH}:2`]);
  });

  test("cross-line quote normalizes drag direction to ascending path:N-M", async () => {
    disk[PATH] = { content: CONTENT, binary: false, tooLarge: false };
    const quoted: string[] = [];
    const { host } = mount(
      <EditorPane {...PROPS} file={{ path: PATH }} onQuoteToComposer={(t) => quoted.push(t)} />,
    );
    await flush();

    // Backward drag: anchor on line 3, focus on line 2 → must cite 2-3.
    const text = await selectLines(host, 2, 3, "backward");
    const btn = host.querySelector('[data-testid="editor-selection-quote"]');
    expect(btn).not.toBeNull();
    click(btn as Element);
    await flush();

    expect(quoted).toEqual([`${text}\n— ${PATH}:2-3`]);
  });

  test("copy output carries the same source footnote", async () => {
    disk[PATH] = { content: CONTENT, binary: false, tooLarge: false };
    const { host } = mount(<EditorPane {...PROPS} file={{ path: PATH }} />);
    await flush();

    const text = await selectLines(host, 2, 3, "forward");
    const btn = host.querySelector('[data-testid="editor-selection-copy"]');
    expect(btn).not.toBeNull();
    click(btn as Element);
    await flush();

    expect(copiedViaToolbar).toEqual([`${text}\n— ${PATH}:2-3`]);
  });

  test("selection outside code rows degrades to plain text, no footnote", async () => {
    disk[PATH] = { content: CONTENT, binary: false, tooLarge: false };
    const quoted: string[] = [];
    const { host } = mount(
      <EditorPane {...PROPS} file={{ path: PATH }} onQuoteToComposer={(t) => quoted.push(t)} />,
    );
    await flush();

    // Anchor + focus inside the language chip (no data-line ancestor).
    const lang = host.querySelector('[data-testid="editor-pane-viewer-lang"]');
    expect(lang).not.toBeNull();
    const textNode = (lang as Element).firstChild as Text;
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.setBaseAndExtent(textNode, 0, textNode, 4);
    document.dispatchEvent(new window.Event("selectionchange"));
    await flush();

    const btn = host.querySelector('[data-testid="editor-selection-quote"]');
    expect(btn).not.toBeNull();
    // Capture before clicking: the toolbar clears the selection as part of run.
    const text = sel.toString();
    click(btn as Element);
    await flush();

    expect(quoted).toEqual([text]);
    expect(quoted[0]).not.toContain("—");
  });
});
