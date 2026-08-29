// Mount-test the coarse-pointer gate of the FilePanel drag-out (issue #149):
// HTML5 drag-and-drop does not exist on touch, so under (pointer: coarse) the
// tree file rows must NOT carry the draggable attribute. Desktop (fine pointer)
// keeps draggable — asserted in PanelDrag.mount.test.tsx.
//
// FilePanel reads matchMedia("(pointer: coarse)") into a MODULE-LEVEL constant
// (same gate as Composer/App — a desktop window never becomes touch mid-session),
// so the coarse simulation must be in place before the module is imported: this
// file overrides matchMedia first and then imports FilePanel. Static import
// cannot work here — it would evaluate the constant before the override lands.
// (Same reason the sibling mount tests dynamic-import after mock.module().)

import { describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";

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

// Coarse pointer BEFORE importing FilePanel: its module-level coarsePointer
// const is evaluated exactly once, at import time.
window.matchMedia = (query: string) => ({
  matches: query === "(pointer: coarse)",
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
});

mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: "3rd-party" },
}));

const listDir = mock((_sid: string, _dir: string) =>
  Promise.resolve([{ name: "README.md", path: "README.md", isDir: false }])
);
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => ({
  SessionListDir: listDir,
  SessionFuzzyFind: async () => [],
  SessionReadFile: async () => "",
  SessionReadImage: async () => ({ dataUrl: "" }),
  SessionCreateFile: async () => {},
  SessionCreateDir: async () => {},
  SessionRenamePath: async () => "",
  SessionDeletePath: async () => {},
  RevealPath: async () => {},
}));

const { default: FilePanel } = await import("./FilePanel.tsx");

describe("FilePanel drag-out coarse-pointer gate (#149)", () => {
  test("coarse pointer: file rows are not draggable; dir rows never were", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    root.render(React.createElement(FilePanel, {
      sessionId: "s1",
      rootName: "proj",
      rootPath: "/tmp/proj",
      changes: [],
      status: "idle",
      onOpenFile: () => {},
    }));
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));

    const fileRow = host.querySelector('[data-testid="tree-file-row"]') as HTMLElement | null;
    expect(fileRow).not.toBeNull();
    expect(fileRow?.getAttribute("draggable")).toBe("false");

    // Directory rows are click-to-expand only — no draggable in either mode.
    for (const row of Array.from(host.querySelectorAll(".tree-row"))) {
      if (row !== fileRow) expect(row.getAttribute("draggable")).toBeNull();
    }
    root.unmount();
  });
});
