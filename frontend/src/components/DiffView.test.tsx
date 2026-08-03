// Tests for the diff-rendering upgrade:
//  1. unifiedToOldNew (lib/unified.ts) — pure function, the critical invariant: a git
//     unified patch must reconstruct correct old/new strings. This is the one place a
//     bug would silently corrupt every git-diff view, so pin it hard.
//  2. DiffView (components/DiffView.tsx) — mount smoke (renders toolbar + toggle, no crash).

import { describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { unifiedToOldNew } from "../lib/unified";
import DiffView from "./DiffView";

// ---- happy-dom setup (only needed for the mount test) ----
const win = new Window();
const doc = win.document;
(globalThis as Record<string, unknown>).window = win;
(globalThis as Record<string, unknown>).document = doc;
(globalThis as Record<string, unknown>).navigator = win.navigator;
(globalThis as Record<string, unknown>).getComputedStyle = win.getComputedStyle.bind(win);
(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(performance.now()), 0);
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);
(globalThis as Record<string, unknown>).MouseEvent = win.MouseEvent;
win.React = React;

// react-i18next: DiffView calls useTranslation(); return keys verbatim.
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function flush() {
  for (let i = 0; i < 10; i++) await delay(2);
}

function render(node: React.ReactNode): { container: HTMLElement; root: Root } {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container);
  root.render(node);
  return { container, root };
}

describe("unifiedToOldNew", () => {
  test("empty / invalid input yields empty old+new", () => {
    expect(unifiedToOldNew("")).toEqual({ oldStr: "", newStr: "" });
    expect(unifiedToOldNew("not a patch at all")).toEqual({ oldStr: "", newStr: "" });
  });

  test("reconstructs a standard git unified diff: context + added + removed", () => {
    // A typical single-hunk patch: one context line, one removed, one added.
    const patch = [
      "--- a/foo.go",
      "+++ b/foo.go",
      "@@ -1,3 +1,3 @@",
      " package foo",
      "-oldLine := 1",
      "+newLine := 2",
      " // trailing context",
    ].join("\n");
    const r = unifiedToOldNew(patch);
    expect(r.oldStr).toBe("package foo\noldLine := 1\n// trailing context");
    expect(r.newStr).toBe("package foo\nnewLine := 2\n// trailing context");
  });

  test("pure-addition hunk (new file region): old has only context, new has the adds", () => {
    const patch = [
      "--- /dev/null",
      "+++ b/new.go",
      "@@ -0,0 +1,2 @@",
      "+package new",
      "+import \"fmt\"",
    ].join("\n");
    const r = unifiedToOldNew(patch);
    expect(r.oldStr).toBe("");
    expect(r.newStr).toBe("package new\nimport \"fmt\"");
  });

  test("pure-deletion hunk: old keeps removed lines, new drops them", () => {
    const patch = [
      "--- a/x.go",
      "+++ b/x.go",
      "@@ -1,2 +0,0 @@",
      "-package x",
      "-import \"os\"",
    ].join("\n");
    const r = unifiedToOldNew(patch);
    expect(r.oldStr).toBe("package x\nimport \"os\"");
    expect(r.newStr).toBe("");
  });

  test("multiple hunks in one file are merged in order", () => {
    const patch = [
      "--- a/m.go",
      "+++ b/m.go",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+A",
      "@@ -5,1 +5,1 @@",
      "-b",
      "+B",
    ].join("\n");
    const r = unifiedToOldNew(patch);
    expect(r.oldStr).toBe("a\nb");
    expect(r.newStr).toBe("A\nB");
  });
  test("\\ No newline at end of file marker is not reconstructed as content", () => {
    // jsdiff's parsePatch keeps the `\ No newline at end of file` marker in hunk.lines.
    // It must NOT leak into the reconstructed old/new — regression: it was pushed to
    // both sides as a fake content line for any file lacking a trailing newline.
    const patch = [
      "--- a/foo.go",
      "+++ b/foo.go",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "\\ No newline at end of file",
    ].join("\n");
    const r = unifiedToOldNew(patch);
    expect(r.oldStr).toBe("old");
    expect(r.newStr).toBe("new");
  });
});

describe("DiffView", () => {
  test("renders the toolbar with a split/unified toggle and does not crash", async () => {
    const { container, root } = render(
      <DiffView oldStr="hello" newStr="world" filename="a.go" />,
    );
    await flush();
    const view = container.querySelector('[data-testid="diff-view"]');
    expect(view).not.toBeNull();
    const toggle = container.querySelector('[data-testid="diff-view-toggle"]');
    expect(toggle).not.toBeNull();
    const copy = container.querySelector('[data-testid="diff-view-copy"]');
    expect(copy).not.toBeNull();
    root.unmount();
  });

  test("toggling switches split → unified label (i18n key surfaced)", async () => {
    const { container, root } = render(
      <DiffView oldStr="x" newStr="y" filename="m.go" />,
    );
    await flush();
    const toggle = container.querySelector('[data-testid="diff-view-toggle"]') as HTMLElement;
    // Default split → label reflects current view = "split".
    expect(toggle.textContent).toContain("diff.split");
    toggle.click();
    await flush();
    // After toggling, label flips to "unified".
    expect(toggle.textContent).toContain("diff.unified");
    root.unmount();
  });
});
