// markdownSource.test.ts: selection → markdown source resolution (#177).
//
// The DOM side here is synthetic (hand-stamped data-md-s/e), so these pin the
// span algebra: nearest stamped anchor, common stamped ancestor, block-level
// union with inline marks skipped, message-root guard, clamping, trimming.
// Byte-validity of the REAL react-markdown offsets end to end (render →
// stamp → select → slice) is covered by ChatView.mdsource.mount.test.tsx.

import { describe, test, expect, beforeEach } from "bun:test";
import { Window } from "happy-dom";
import { markdownSourceFromSelection, mdSourceProps } from "./markdownSource";

const window = new Window();
const document = window.document;
globalThis.window = window;
globalThis.document = document;

// ---- helpers ----

function el(tag: string, attrs: Record<string, string> = {}, ...children: Node[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.appendChild(c);
  return e;
}

// Selection stub: markdownSourceFromSelection only consumes anchorNode /
// focusNode / isCollapsed / rangeCount — no layout, no real ranges needed.
let fakeSel = { anchorNode: null as Node | null, focusNode: null as Node | null, isCollapsed: true, rangeCount: 1 };
Object.defineProperty(window, "getSelection", {
  configurable: true,
  value: () => fakeSel as unknown as Selection,
});

// `collapsed` mirrors a real Selection: selecting a whole text node is NOT
// collapsed even when anchor/focus point at the same node (offsets differ).
function select(anchor: Node, focus: Node, collapsed = false) {
  fakeSel = { anchorNode: anchor, focusNode: focus, isCollapsed: collapsed, rangeCount: 1 };
}

// Same source as the stamped tree below.
const RAW = "Intro **bold** tail.\n\n- item one\n- item two";

function buildTree(): { msg: HTMLElement; p: HTMLElement; strong: HTMLElement; boldText: Text; ul: HTMLElement; li1: HTMLElement; li2: HTMLElement } {
  // Spans hand-computed against RAW:
  //   "Intro **bold** tail." = [0,20); "**bold**" = [6,14)
  //   "\n\n" = [20,22); "- item one" = [22,32); "- item two" = [33,43)
  const p = el("p", { "data-md-s": "0", "data-md-e": "20" }, document.createTextNode("Intro "), el("strong", { "data-md-s": "6", "data-md-e": "14" }, document.createTextNode("bold")), document.createTextNode(" tail."));
  const li1 = el("li", { "data-md-s": "22", "data-md-e": "32" }, document.createTextNode("item one"));
  const li2 = el("li", { "data-md-s": "33", "data-md-e": "43" }, document.createTextNode("item two"));
  const ul = el("ul", { "data-md-s": "22", "data-md-e": "43" }, li1, li2);
  const msg = el("div", { "data-md-msg": "m1" }, p, ul);
  document.body.appendChild(msg);
  return { msg, p, strong: p.children[0] as HTMLElement, boldText: (p.children[0] as HTMLElement).firstChild as Text, ul, li1, li2 };
}

beforeEach(() => {
  document.body.innerHTML = "";
  fakeSel = { anchorNode: null, focusNode: null, isCollapsed: true, rangeCount: 1 };
});

describe("markdownSourceFromSelection (#177)", () => {
  test("selection inside one inline mark resolves to that mark's exact source", () => {
    const t = buildTree();
    select(t.boldText, t.boldText);
    expect(markdownSourceFromSelection(RAW)).toBe("**bold**");
  });

  test("selection inside one block resolves to the block's source", () => {
    const t = buildTree();
    select(t.li1.firstChild as Node, t.li1.firstChild as Node);
    expect(markdownSourceFromSelection(RAW)).toBe("- item one");
  });

  test("selection across sibling blocks under a stamped ancestor uses the ancestor (list, not fragments)", () => {
    const t = buildTree();
    select(t.li1.firstChild as Node, t.li2.firstChild as Node);
    expect(markdownSourceFromSelection(RAW)).toBe("- item one\n- item two");
  });

  test("selection across unrelated blocks unions their block spans (blank line travels along)", () => {
    const t = buildTree();
    select((t.p.firstChild as Text), t.li1.firstChild as Node);
    expect(markdownSourceFromSelection(RAW)).toBe("Intro **bold** tail.\n\n- item one");
  });

  test("union expands inline marks to block level so plain words are not dropped", () => {
    const t = buildTree();
    select(t.boldText, t.li2.firstChild as Node);
    // boldText's inline span would start at 6, but block expansion lifts it to
    // the enclosing paragraph (offset 0) — the "Intro " prefix survives.
    expect(markdownSourceFromSelection(RAW)).toBe(RAW);
  });

  test("backward selections normalize to the same span", () => {
    const t = buildTree();
    select(t.li2.firstChild as Node, t.li1.firstChild as Node);
    expect(markdownSourceFromSelection(RAW)).toBe("- item one\n- item two");
  });

  test("boundaries under different message roots are rejected", () => {
    const t = buildTree();
    const other = el("div", { "data-md-msg": "m2" }, el("p", { "data-md-s": "0", "data-md-e": "3" }, document.createTextNode("abc")));
    document.body.appendChild(other);
    select(t.p.firstChild as Node, other.firstChild!.firstChild as Node);
    expect(markdownSourceFromSelection(RAW)).toBe("");
  });

  test("unstamped boundaries (tool cards, plain text) resolve to nothing", () => {
    const bare = el("div", {}, document.createTextNode("no anchors here"));
    document.body.appendChild(bare);
    select(bare.firstChild as Node, bare.firstChild as Node);
    expect(markdownSourceFromSelection(RAW)).toBe("");
  });

  test("collapsed selection resolves to nothing", () => {
    const t = buildTree();
    select(t.boldText, t.boldText, true);
    expect(markdownSourceFromSelection(RAW)).toBe("");
  });

  test("missing selection API degrades to empty (never throws)", () => {
    const original = Object.getOwnPropertyDescriptor(window, "getSelection");
    Object.defineProperty(window, "getSelection", { configurable: true, value: () => null });
    expect(markdownSourceFromSelection(RAW)).toBe("");
    Object.defineProperty(window, "getSelection", original!);
  });

  test("stale end offsets (streaming caret past raw) clamp instead of throwing", () => {
    const t = buildTree();
    // Simulate an anchor stamped against text+caret (43+2) while raw is 43.
    t.li2.setAttribute("data-md-e", "60");
    select(t.li2.firstChild as Node, t.li2.firstChild as Node);
    expect(markdownSourceFromSelection(RAW)).toBe("- item two");
  });

  test("trailing newlines of a block slice are trimmed", () => {
    const t = buildTree();
    // Paragraph span extended over the blank line separating it from the list.
    t.p.setAttribute("data-md-e", "22");
    select(t.p.firstChild as Node, t.p.firstChild as Node);
    expect(markdownSourceFromSelection(RAW)).toBe("Intro **bold** tail.");
  });

  test("empty raw resolves to nothing", () => {
    const t = buildTree();
    select(t.boldText, t.boldText);
    expect(markdownSourceFromSelection("")).toBe("");
  });
});

describe("mdSourceProps (#177)", () => {
  test("hast node position becomes data-md-s/data-md-e", () => {
    expect(mdSourceProps({ position: { start: { offset: 3 }, end: { offset: 9 } } })).toEqual({
      "data-md-s": "3",
      "data-md-e": "9",
    });
  });

  test("missing or invalid positions yield no attributes", () => {
    expect(mdSourceProps(undefined)).toEqual({});
    expect(mdSourceProps(null)).toEqual({});
    expect(mdSourceProps({})).toEqual({});
    expect(mdSourceProps({ position: { start: { offset: 9 }, end: { offset: 3 } } })).toEqual({});
    expect(mdSourceProps({ position: { start: {} } })).toEqual({});
  });

  test("zero-width spans are valid (degenerate but harmless)", () => {
    expect(mdSourceProps({ position: { start: { offset: 5 }, end: { offset: 5 } } })).toEqual({
      "data-md-s": "5",
      "data-md-e": "5",
    });
  });
});
