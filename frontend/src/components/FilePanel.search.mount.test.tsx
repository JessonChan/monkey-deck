// Mount-test FilePanel search (#132): toolbar search icon toggles a debounced
// fuzzy-find over the whole session tree (SessionFuzzyFind scope="", limit 50),
// results render as a FLAT list (name + dim full path), keyboard is
// ↑/↓ move / Enter pick / Esc back-to-tree, and the per-session tree cache is
// untouched (search state is transient; Esc restores the tree exactly).
//
// §5.3 invariants pinned here:
//  - debounce 200ms coalesces rapid keystrokes into ONE backend call
//  - seq guard: an in-flight response for an older query never overwrites a newer one

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";

// ---- happy-dom setup (same as sibling *.mount.test.tsx) ----
const window = new Window();
const document = window.document;
globalThis.window = window;
globalThis.document = document;
globalThis.navigator = window.navigator;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.MouseEvent = window.MouseEvent;
window.React = React;

mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: "3rd-party" },
}));

// Tree fixture: root has src/ (dir) + README.md; src has sub/ (dir) + a.ts.
const listDir = mock((_sid: string, dir: string) => {
  if (dir === "") {
    return Promise.resolve([
      { name: "src", path: "src", isDir: true },
      { name: "README.md", path: "README.md", isDir: false },
    ]);
  }
  if (dir === "src") {
    return Promise.resolve([
      { name: "sub", path: "src/sub", isDir: true },
      { name: "a.ts", path: "src/a.ts", isDir: false },
    ]);
  }
  return Promise.resolve([]);
});

let fuzzyResult: Array<{ name: string; path: string; isDir: boolean }> = [];
const fuzzyFind = mock(() => Promise.resolve(fuzzyResult));

mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => ({
  SessionListDir: listDir,
  SessionFuzzyFind: fuzzyFind,
  SessionReadFile: mock(() => Promise.resolve("")),
  SessionReadImage: mock(() => Promise.resolve({ dataUrl: "" })),
  SessionCreateFile: mock(() => Promise.resolve()),
  SessionCreateDir: mock(() => Promise.resolve()),
  SessionRenamePath: mock(() => Promise.resolve("")),
  SessionDeletePath: mock(() => Promise.resolve()),
  RevealPath: mock(() => Promise.resolve()),
}));

const { default: FilePanel } = await import("./FilePanel.tsx");

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

// Wait out the 200ms debounce plus resolution.
async function settle() {
  await new Promise((r) => setTimeout(r, 260));
  await flush();
}

const click = () => new window.MouseEvent("click", { bubbles: true, button: 0 });
const key = (k: string) => new window.KeyboardEvent("keydown", { key: k, bubbles: true });

// Drive the search input: it is uncontrolled + driven by a NATIVE "input"
// listener (see the comment in FilePanel.tsx), so a plain value assignment +
// dispatched input event reaches setQuery in both happy-dom and real webviews.
function typeInto(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function openSearch(host: HTMLElement): Promise<HTMLInputElement> {
  (host.querySelector('[data-testid="file-search-toggle"]') as HTMLElement).dispatchEvent(click());
  await flush();
  const input = host.querySelector('[data-testid="file-search-input"]') as HTMLInputElement;
  expect(input).not.toBeNull();
  return input;
}

const opened: string[] = [];
const baseProps = {
  sessionId: "s1",
  rootName: "proj",
  rootPath: "/tmp/proj",
  changes: [] as never[],
  status: "idle",
  onOpenFile: (p: string) => opened.push(p),
};

describe("FilePanel search (#132)", () => {
  beforeEach(() => {
    // mockClear keeps per-test implementations; restore the default impl so the
    // seq-guard test's deferred mock does not leak (it runs last, but be safe).
    fuzzyFind.mockImplementation(() => Promise.resolve(fuzzyResult));
    fuzzyFind.mockClear();
    listDir.mockClear();
    fuzzyResult = [];
    opened.length = 0;
  });

  test("rapid keystrokes debounce to ONE SessionFuzzyFind(sid, '', query, 50); flat list shows full paths", async () => {
    fuzzyResult = [
      { name: "a.ts", path: "src/a.ts", isDir: false },
      { name: "a.ts", path: "lib/a.ts", isDir: false },
    ];
    const { host } = mount(<FilePanel {...baseProps} />);
    await flush();

    const input = await openSearch(host);
    typeInto(input, "a");
    await new Promise((r) => setTimeout(r, 60));
    typeInto(input, "ab");
    await settle();

    // One coalesced call for the final query, whole-tree scope, limit 50.
    expect(fuzzyFind).toHaveBeenCalledTimes(1);
    expect(fuzzyFind).toHaveBeenCalledWith("s1", "", "ab", 50);

    // Flat result list: rows + dim full-path spans distinguish same-name hits.
    const rows = host.querySelectorAll('[data-testid="file-search-item"]');
    expect(rows.length).toBe(2);
    expect((rows[0] as HTMLElement).dataset.path).toBe("src/a.ts");
    expect(rows[0]!.querySelector(".file-search-path")!.textContent).toBe("src/a.ts");
    expect(rows[1]!.querySelector(".file-search-path")!.textContent).toBe("lib/a.ts");
  });

  test("↑/↓ move the active row; Enter opens the file in the editor and returns to the tree", async () => {
    fuzzyResult = [
      { name: "a.ts", path: "src/a.ts", isDir: false },
      { name: "b.ts", path: "lib/b.ts", isDir: false },
    ];
    const { host } = mount(<FilePanel {...baseProps} />);
    await flush();

    const input = await openSearch(host);
    typeInto(input, "ts");
    await settle();

    const rows = () => host.querySelectorAll('[data-testid="file-search-item"]');
    expect(rows()[0]!.classList.contains("sel")).toBe(true);

    input.dispatchEvent(key("ArrowDown"));
    await flush();
    expect(rows()[1]!.classList.contains("sel")).toBe(true);
    input.dispatchEvent(key("ArrowUp"));
    await flush();
    expect(rows()[0]!.classList.contains("sel")).toBe(true);
    input.dispatchEvent(key("ArrowDown"));
    await flush();

    input.dispatchEvent(key("Enter"));
    await flush();
    expect(opened).toEqual(["lib/b.ts"]);
    // Back to tree: search input gone, tree rows render again.
    expect(host.querySelector('[data-testid="file-search-input"]')).toBeNull();
    expect(host.querySelector('[data-testid="file-search-item"]')).toBeNull();
    expect(host.querySelectorAll(".tree-row").length).toBeGreaterThan(0);
  });

  test("Esc returns to the tree WITHOUT disturbing tree state (expanded dirs survive; zero cache changes)", async () => {
    fuzzyResult = [{ name: "a.ts", path: "src/a.ts", isDir: false }];
    const { host } = mount(<FilePanel {...baseProps} />);
    await flush();

    // Expand src first so the tree has state to preserve.
    const srcRow = [...host.querySelectorAll(".tree-row")].find((r) => r.textContent?.includes("src"));
    srcRow!.dispatchEvent(click());
    await flush();
    expect(host.textContent).toContain("a.ts");

    const input = await openSearch(host);
    typeInto(input, "a.ts");
    await settle();
    expect(host.querySelectorAll('[data-testid="file-search-item"]').length).toBe(1);

    input.dispatchEvent(key("Escape"));
    await flush();
    expect(host.querySelector('[data-testid="file-search-input"]')).toBeNull();
    // Tree is back exactly as left: src still expanded with a.ts inside.
    expect(host.textContent).toContain("a.ts");
    expect(host.querySelector('[data-testid="file-search-item"]')).toBeNull();
  });

  test("Enter on a DIRECTORY hit reveals it in the tree (ancestors expanded + row selected)", async () => {
    fuzzyResult = [{ name: "sub", path: "src/sub", isDir: true }];
    const { host } = mount(<FilePanel {...baseProps} />);
    await flush();

    const input = await openSearch(host);
    typeInto(input, "sub");
    await settle();

    input.dispatchEvent(key("Enter"));
    await flush();

    // Search closed; src got expanded (its children loaded via SessionListDir).
    expect(host.querySelector('[data-testid="file-search-input"]')).toBeNull();
    expect(listDir).toHaveBeenCalledWith("s1", "src");
    const subRow = [...host.querySelectorAll(".tree-row")].find((r) =>
      r.textContent?.includes("sub"),
    );
    expect(subRow).not.toBeUndefined();
    expect(subRow!.classList.contains("sel")).toBe(true);
    expect(opened).toEqual([]);
  });

  test("no hits shows the empty hint; empty query keeps the tree visible and fires no search", async () => {
    fuzzyResult = [];
    const { host } = mount(<FilePanel {...baseProps} />);
    await flush();

    const input = await openSearch(host);
    // Empty query: tree stays visible, no backend call.
    await settle();
    expect(fuzzyFind).not.toHaveBeenCalled();
    expect(host.querySelectorAll(".tree-row").length).toBeGreaterThan(0);

    typeInto(input, "zzz");
    await settle();
    expect(fuzzyFind).toHaveBeenCalledWith("s1", "", "zzz", 50);
    expect(host.querySelector('[data-testid="file-search-empty"]')).not.toBeNull();
  });

  test("stale in-flight response never overwrites a newer query's results (seq guard)", async () => {
    // First query resolves LATE (after the second one already landed).
    let releaseFirst: ((v: Array<{ name: string; path: string; isDir: boolean }>) => void) | null = null;
    fuzzyFind.mockImplementation((_sid: string, _scope: string, q: string) => {
      if (q === "slow") {
        return new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve([{ name: "new.ts", path: "new.ts", isDir: false }]);
    });

    const { host } = mount(<FilePanel {...baseProps} />);
    await flush();

    const input = await openSearch(host);
    typeInto(input, "slow");
    await settle(); // call for "slow" is now in flight, unresolved
    expect(fuzzyFind).toHaveBeenCalledTimes(1);

    typeInto(input, "new");
    await settle(); // "new" resolves and renders
    expect(fuzzyFind).toHaveBeenCalledTimes(2);
    const rows = () => host.querySelectorAll('[data-testid="file-search-item"]');
    expect(rows().length).toBe(1);
    expect((rows()[0] as HTMLElement).dataset.path).toBe("new.ts");

    // The late "slow" response arrives now — it must be dropped.
    releaseFirst!([{ name: "slow.ts", path: "slow.ts", isDir: false }]);
    await flush();
    expect(rows().length).toBe(1);
    expect((rows()[0] as HTMLElement).dataset.path).toBe("new.ts");
  });
});
