// Mount-test FilePanel search history (#167): picking a result records the
// committed query in a PROJECT-level localStorage history
// (md:recent-file-searches:<rootPath>; per-session key only when rootPath is
// empty), move-to-front dedupe with a cap of 12. The dropdown shows when the
// input is focused and the query is empty — clicking an entry backfills the
// query and immediately triggers the search, ✕ deletes a single entry, no
// history renders nothing. A remount restores searchOpen+query from the
// per-session snapshot while the existing debounce effect re-runs the search
// on its own (results are never cached).
//
// happy-dom note: .focus() does not dispatch focus events, and the input is
// uncontrolled + NATIVE-listener driven (see FilePanel.tsx #132) — so focus
// is simulated by dispatching a raw "focus" Event at the input, the same way
// sibling tests drive "input"/"keydown" through native listeners.

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";

// ---- happy-dom setup (same as FilePanel.search.mount.test.tsx) ----
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

// happy-dom never fires real focus events; the component listens natively.
function focusInput(input: HTMLInputElement) {
  input.dispatchEvent(new window.Event("focus"));
}

const KEY = "md:recent-file-searches:/tmp/proj";
const opened: string[] = [];
const baseProps = {
  sessionId: "s1",
  rootName: "proj",
  rootPath: "/tmp/proj",
  changes: [] as never[],
  status: "idle",
  onOpenFile: (p: string) => opened.push(p),
};

const store = () => window.localStorage.getItem(KEY);

describe("FilePanel search history (#167)", () => {
  beforeEach(() => {
    fuzzyFind.mockImplementation(() => Promise.resolve(fuzzyResult));
    fuzzyFind.mockClear();
    listDir.mockClear();
    fuzzyResult = [];
    opened.length = 0;
    window.localStorage.clear();
  });

  test("picking a result records the query under the rootPath key; typing alone does not", async () => {
    fuzzyResult = [{ name: "a.ts", path: "src/a.ts", isDir: false }];
    const { host } = mount(<FilePanel {...baseProps} />);
    await flush();
    const input = await openSearch(host);
    typeInto(input, "alpha");
    await settle();
    expect(store()).toBeNull(); // no write on mere typing
    input.dispatchEvent(key("Enter"));
    await flush();
    expect(store()).toBe(JSON.stringify(["alpha"]));
  });

  test("history is move-to-front dedupe across picks", async () => {
    fuzzyResult = [{ name: "a.ts", path: "src/a.ts", isDir: false }];
    const { host } = mount(<FilePanel {...baseProps} />);
    await flush();

    const pick = async (q: string) => {
      const input = await openSearch(host);
      typeInto(input, q);
      await settle();
      input.dispatchEvent(key("Enter"));
      await flush();
    };
    await pick("alpha");
    await pick("beta");
    expect(JSON.parse(store()!)).toEqual(["beta", "alpha"]);
    await pick("alpha");
    expect(JSON.parse(store()!)).toEqual(["alpha", "beta"]);
  });

  test("cap 12 binds through the component path (oldest evicted)", async () => {
    fuzzyResult = [{ name: "a.ts", path: "src/a.ts", isDir: false }];
    window.localStorage.setItem(KEY, JSON.stringify(Array.from({ length: 12 }, (_, i) => `old${i}`)));
    const { host } = mount(<FilePanel {...baseProps} />);
    await flush();
    const input = await openSearch(host);
    typeInto(input, "fresh");
    await settle();
    input.dispatchEvent(key("Enter"));
    await flush();
    const all = JSON.parse(store()!);
    expect(all.length).toBe(12);
    expect(all[0]).toBe("fresh");
    expect(all).not.toContain("old11"); // evicted
    expect(all[11]).toBe("old10");
  });

  test("empty rootPath degrades to the per-session key", async () => {
    fuzzyResult = [{ name: "a.ts", path: "src/a.ts", isDir: false }];
    const { host } = mount(<FilePanel {...baseProps} rootPath="" sessionId="s9" />);
    await flush();
    const input = await openSearch(host);
    typeInto(input, "alpha");
    await settle();
    input.dispatchEvent(key("Enter"));
    await flush();
    expect(window.localStorage.getItem("md:recent-file-searches:s9")).toBe(JSON.stringify(["alpha"]));
    expect(store()).toBeNull();
  });

  test("directory hits record the query too (reveal behavior unchanged)", async () => {
    fuzzyResult = [{ name: "sub", path: "src/sub", isDir: true }];
    const { host } = mount(<FilePanel {...baseProps} />);
    await flush();
    const input = await openSearch(host);
    typeInto(input, "sub");
    await settle();
    input.dispatchEvent(key("Enter"));
    await flush();
    expect(store()).toBe(JSON.stringify(["sub"]));
    expect(listDir).toHaveBeenCalledWith("s1", "src"); // reveal-in-tree still ran
    expect(opened).toEqual([]);
  });

  test("dropdown: focused + empty query shows history; clicking backfills and fires the search", async () => {
    window.localStorage.setItem(KEY, JSON.stringify(["alpha", "beta"]));
    fuzzyResult = [{ name: "beta.ts", path: "src/beta.ts", isDir: false }];
    const { host } = mount(<FilePanel {...baseProps} />);
    await flush();
    const input = await openSearch(host);
    focusInput(input);
    await flush();

    expect(host.querySelector('[data-testid="file-search-history"]')).not.toBeNull();
    const rows = () => host.querySelectorAll('[data-testid="file-search-history-item"]');
    expect(rows().length).toBe(2);
    expect((rows()[0] as HTMLElement).dataset.query).toBe("alpha"); // newest first

    // Click "beta": backfills the uncontrolled input and triggers the search.
    rows()[1]!.dispatchEvent(click());
    await settle();
    expect(input.value).toBe("beta");
    expect(fuzzyFind).toHaveBeenCalledWith("s1", "", "beta", 50);
    // Dropdown replaced by the live result list (nothing cached).
    expect(host.querySelector('[data-testid="file-search-history"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="file-search-item"]').length).toBe(1);
  });

  test("✕ deletes a single entry without exiting the search or backfilling", async () => {
    window.localStorage.setItem(KEY, JSON.stringify(["alpha", "beta"]));
    const { host } = mount(<FilePanel {...baseProps} />);
    await flush();
    const input = await openSearch(host);
    focusInput(input);
    await flush();

    const firstDelete = host.querySelectorAll('[data-testid="file-search-history-delete"]')[0] as HTMLElement;
    firstDelete.dispatchEvent(click());
    await flush();
    expect(JSON.parse(store()!)).toEqual(["beta"]);
    // Still open, still focused-empty, nothing backfilled.
    expect(host.querySelector('[data-testid="file-search-input"]')).not.toBeNull();
    expect(input.value).toBe("");
    let rows = host.querySelectorAll('[data-testid="file-search-history-item"]');
    expect(rows.length).toBe(1);
    expect((rows[0] as HTMLElement).dataset.query).toBe("beta");

    // Deleting the last entry closes the dropdown entirely (no history → no render).
    (host.querySelectorAll('[data-testid="file-search-history-delete"]')[0] as HTMLElement).dispatchEvent(click());
    await flush();
    expect(store()).toBe(JSON.stringify([]));
    expect(host.querySelector('[data-testid="file-search-history"]')).toBeNull();
    expect(host.querySelectorAll(".tree-row").length).toBeGreaterThan(0); // tree is back
  });

  test("no history renders no dropdown (tree stays)", async () => {
    const { host } = mount(<FilePanel {...baseProps} />);
    await flush();
    const input = await openSearch(host);
    focusInput(input);
    await flush();
    expect(host.querySelector('[data-testid="file-search-history"]')).toBeNull();
    expect(host.querySelectorAll(".tree-row").length).toBeGreaterThan(0);
  });

  test("remount restores searchOpen+query; the debounce effect re-runs the search (no result caching)", async () => {
    fuzzyResult = [{ name: "a.ts", path: "src/a.ts", isDir: false }];
    const first = mount(<FilePanel {...baseProps} sessionId="s-remount" />);
    await flush();
    const input = await openSearch(first.host);
    typeInto(input, "alpha");
    await settle();
    expect(fuzzyFind).toHaveBeenCalledTimes(1);
    first.root.unmount();

    fuzzyFind.mockClear();
    const second = mount(<FilePanel {...baseProps} sessionId="s-remount" />);
    await flush();
    const input2 = second.host.querySelector('[data-testid="file-search-input"]') as HTMLInputElement;
    expect(input2).not.toBeNull(); // search row reopened from the snapshot
    expect(input2.value).toBe("alpha"); // uncontrolled input hydrated from query
    await settle();
    expect(fuzzyFind).toHaveBeenCalledTimes(1); // refetched — nothing was cached
    expect(fuzzyFind).toHaveBeenCalledWith("s-remount", "", "alpha", 50);
    second.root.unmount();
  });
});
