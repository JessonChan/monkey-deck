// Mount-test DirBrowserModal with happy-dom + React (#128).
//
// Locks the web directory picker's navigation invariants:
//   1. Opens in the roots view (BrowseRoots) with confirm disabled — roots
//      are shortcuts, not pickable project directories.
//   2. Tapping a root / a subdir descends (BrowseDir); confirm then targets
//      the DISPLAYED directory (no separate selection state to desync).
//   3. "Up" from a directory goes to BrowseDir(parent); at the filesystem
//      root (parent === "") it returns to the roots view.
//   4. A failed BrowseDir surfaces dirBrowser error UI and keeps confirm
//      disabled (no silent stuck state).
//
// §5.3: pin invariants ("confirm = current dir", "roots are not pickable").

import { beforeEach, describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";

// ---- happy-dom setup (same as NewSessionModal mount test) ----
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

// react-i18next: return the key so the DOM is predictable.
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: "3rd-party" },
}));

// ChatService bindings: BrowseRoots/BrowseDir mocks. Dynamic-imported
// module shape must match how the component imports it (namespace import).
const browseDirMock = mock(async (dir: string) => dirResults[dir] ?? null);
const browseRootsMock = mock(async () => ROOTS);
let dirResults: Record<string, { path: string; parent: string; dirs: { name: string; path: string }[] }> = {};
const ROOTS = [
  { name: "~", path: "/home/me" },
  { name: "/", path: "/" },
];
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => ({
  BrowseRoots: browseRootsMock,
  BrowseDir: browseDirMock,
}));

// Dynamic import AFTER mock.module registration (same pattern as sibling tests).
const { default: DirBrowserModal } = await import("./DirBrowserModal.tsx");

function mount(jsx: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(jsx);
  return { host, root };
}

async function flush() {
  for (let i = 0; i < 8; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
}

const click = () => new window.MouseEvent("click", { bubbles: true, button: 0 });

const confirmBtn = (host: HTMLElement) => host.querySelector('[data-testid="dir-browser-confirm"]') as HTMLButtonElement;
const upBtn = (host: HTMLElement) => host.querySelector('[data-testid="dir-browser-up"]') as HTMLButtonElement;
const entry = (host: HTMLElement, testid: string) => host.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement;

beforeEach(() => {
  browseDirMock.mockClear();
  browseRootsMock.mockClear();
  dirResults = {
    "/home/me": { path: "/home/me", parent: "/home", dirs: [{ name: "projects", path: "/home/me/projects" }] },
    "/home/me/projects": { path: "/home/me/projects", parent: "/home/me", dirs: [] },
    "/home": { path: "/home", parent: "/", dirs: [{ name: "me", path: "/home/me" }] },
    "/": { path: "/", parent: "", dirs: [{ name: "home", path: "/home" }] },
  };
});

describe("DirBrowserModal roots view", () => {
  test("opens on BrowseRoots; confirm disabled (roots are shortcuts, not picks)", async () => {
    const onConfirm = mock();
    const { host } = mount(<DirBrowserModal onConfirm={onConfirm} onCancel={() => {}} />);
    await flush();
    expect(browseRootsMock).toHaveBeenCalledTimes(1);
    expect(entry(host, "dir-browser-root-~")).not.toBeNull();
    expect(confirmBtn(host).disabled).toBe(true);
    // Path bar shows the locations label, not a directory.
    expect(host.querySelector('[data-testid="dir-browser-path"]')!.textContent).toContain("dirBrowser.locations");
  });

  test("descending into a root enables confirm targeting the displayed dir", async () => {
    const onConfirm = mock();
    const { host } = mount(<DirBrowserModal onConfirm={onConfirm} onCancel={() => {}} />);
    await flush();
    entry(host, "dir-browser-root-~").dispatchEvent(click());
    await flush();
    expect(browseDirMock).toHaveBeenCalledWith("/home/me");
    expect(confirmBtn(host).disabled).toBe(false);
    confirmBtn(host).dispatchEvent(click());
    await flush();
    expect(onConfirm).toHaveBeenCalledWith("/home/me");
  });
});

describe("DirBrowserModal navigation", () => {
  test("up navigates to parent, then from filesystem root back to roots view", async () => {
    const { host } = mount(<DirBrowserModal onConfirm={() => {}} onCancel={() => {}} />);
    await flush();
    // ~ → /home/me/projects (empty dir listing still confirm-able).
    entry(host, "dir-browser-root-~").dispatchEvent(click());
    await flush();
    entry(host, "dir-browser-entry-projects").dispatchEvent(click());
    await flush();
    expect(confirmBtn(host).disabled).toBe(false);
    // up: /home/me/projects → /home/me → /home → / (parent chain).
    upBtn(host).dispatchEvent(click());
    await flush();
    expect(browseDirMock).toHaveBeenLastCalledWith("/home/me");
    upBtn(host).dispatchEvent(click());
    await flush();
    expect(browseDirMock).toHaveBeenLastCalledWith("/home");
    upBtn(host).dispatchEvent(click());
    await flush();
    expect(browseDirMock).toHaveBeenLastCalledWith("/");
    // At the filesystem root (parent === "") up returns to the roots view.
    upBtn(host).dispatchEvent(click());
    await flush();
    expect(browseRootsMock).toHaveBeenCalledTimes(2);
    expect(entry(host, "dir-browser-root-~")).not.toBeNull();
    expect(confirmBtn(host).disabled).toBe(true);
  });

  test("Esc cancels; Enter confirms the displayed directory", async () => {
    const onConfirm = mock();
    const onCancel = mock();
    const { host } = mount(<DirBrowserModal onConfirm={onConfirm} onCancel={onCancel} />);
    await flush();
    entry(host, "dir-browser-root-~").dispatchEvent(click());
    await flush();
    // Enter confirms the current dir.
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(onConfirm).toHaveBeenCalledWith("/home/me");
    // Esc cancels.
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("DirBrowserModal failure handling", () => {
  test("BrowseDir error shows the error state and keeps confirm disabled", async () => {
    const onConfirm = mock();
    const { host } = mount(<DirBrowserModal onConfirm={onConfirm} onCancel={() => {}} />);
    await flush();
    browseDirMock.mockImplementationOnce(async () => { throw new Error("boom"); });
    entry(host, "dir-browser-root-~").dispatchEvent(click());
    await flush();
    expect(host.querySelector('[data-testid="dir-browser-error"]')).not.toBeNull();
    expect(confirmBtn(host).disabled).toBe(true);
    // Up still works from the error state (seq-guarded reload).
    upBtn(host).dispatchEvent(click());
    await flush();
    expect(entry(host, "dir-browser-root-~")).not.toBeNull();
  });
});
