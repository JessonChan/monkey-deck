// clipboard.test.ts: channel selection + boolean contract of lib/clipboard
// (issue #129). The invariants pinned here:
//  1. Remote-browser clients never touch the Wails3 Clipboard.SetText channel
//     (it writes the desktop's clipboard, not the phone's — the #129 bug).
//  2. copyText resolves to true/false per channel outcome and never throws.
//  3. execCommandCopy is fully synchronous, reports failure as false and
//     cleans up its scratch textarea even when execCommand throws.

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Window } from "happy-dom";

// ---- happy-dom globals (lib reads window/document/navigator at call time) ----
const win = new Window();
const doc = win.document;
(globalThis as Record<string, unknown>).window = win;
(globalThis as Record<string, unknown>).document = doc;
(globalThis as Record<string, unknown>).navigator = win.navigator;

// happy-dom may lack textarea.setSelectionRange; the iOS recipe calls it.
// Stub the prototype when missing so execCommandCopy reaches execCommand.
const taProto: Record<string, unknown> = Object.getPrototypeOf(doc.createElement("textarea"));
if (typeof taProto.setSelectionRange !== "function") {
  taProto.setSelectionRange = function () {};
}

// ---- mocks ----
const setTextMock = mock((_text: string) => Promise.resolve());
mock.module("@wailsio/runtime", () => ({ Clipboard: { SetText: setTextMock } }));

const navWriteMock = mock((_text: string) => Promise.resolve());

function setNavigatorClipboard(v: { writeText: (text: string) => Promise<void> } | undefined): void {
  Object.defineProperty(win.navigator, "clipboard", { value: v, configurable: true });
}

// Stub document.execCommand (not implemented in happy-dom). `impl` may throw to
// simulate a hostile browser.
function setExecCommand(impl: () => boolean): void {
  (doc as unknown as Record<string, unknown>).execCommand = impl;
}

const clipboard = await import("./clipboard");

beforeEach(() => {
  (win as unknown as Record<string, unknown>).__mdRemote = undefined;
  setTextMock.mockReset();
  navWriteMock.mockReset();
  setNavigatorClipboard(undefined);
});

describe("copyText channel selection", () => {
  test("desktop webview: Wails3 SetText wins and reports success", async () => {
    setTextMock.mockImplementation((_t: string) => Promise.resolve());
    const ok = await clipboard.copyText("hello");
    expect(ok).toBe(true);
    expect(setTextMock).toHaveBeenCalledTimes(1);
    expect(setTextMock).toHaveBeenCalledWith("hello");
    expect(navWriteMock).not.toHaveBeenCalled();
  });

  test("desktop, Wails3 unavailable: falls through to navigator.clipboard", async () => {
    setTextMock.mockImplementation((_t: string) => Promise.reject(new Error("no wails")));
    setNavigatorClipboard({ writeText: navWriteMock });
    const ok = await clipboard.copyText("fallback");
    expect(ok).toBe(true);
    expect(navWriteMock).toHaveBeenCalledWith("fallback");
  });

  test("all channels fail: resolves false (never throws)", async () => {
    setTextMock.mockImplementation((_t: string) => Promise.reject(new Error("no wails")));
    setExecCommand(() => false);
    const ok = await clipboard.copyText("doomed");
    expect(ok).toBe(false);
  });

  test("remote client (#129): never calls Wails3 SetText even when it would succeed", async () => {
    (win as unknown as Record<string, unknown>).__mdRemote = true;
    setTextMock.mockImplementation((_t: string) => Promise.resolve());
    setExecCommand(() => true); // navigator.clipboard absent (plain-HTTP iOS path)
    const ok = await clipboard.copyText("phone");
    expect(ok).toBe(true);
    expect(setTextMock).not.toHaveBeenCalled(); // desktop clipboard must stay untouched
  });

  test("remote client with secure context: uses navigator.clipboard locally", async () => {
    (win as unknown as Record<string, unknown>).__mdRemote = true;
    setNavigatorClipboard({ writeText: navWriteMock });
    const ok = await clipboard.copyText("secure");
    expect(ok).toBe(true);
    expect(navWriteMock).toHaveBeenCalledWith("secure");
    expect(setTextMock).not.toHaveBeenCalled();
  });
});

describe("execCommandCopy", () => {
  test("synchronous boolean return; textarea cleaned up after failure", () => {
    setExecCommand(() => {
      throw new Error("unsupported");
    });
    const before = doc.body.children.length;
    const ok = clipboard.execCommandCopy("boom");
    expect(ok).toBe(false);
    expect(doc.body.children.length).toBe(before); // no scratch textarea leaked
  });

  test("invokes execCommand with the copy command and reports its result", () => {
    const calls: unknown[][] = [];
    setExecCommand((...args: unknown[]) => {
      calls.push(args);
      return true;
    });
    expect(clipboard.execCommandCopy("sync-ok")).toBe(true);
    expect(calls).toEqual([["copy"]]); // the legacy copy command, not cut/paste
    expect(doc.body.children.length).toBe(0);
  });
});

describe("copyTextQuiet", () => {
  test("warns on the console when every channel fails, silently succeeds otherwise", async () => {
    const warns: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args); };
    try {
      setExecCommand(() => true);
      clipboard.copyTextQuiet("fine");
      await new Promise((r) => setTimeout(r, 5));
      expect(warns).toHaveLength(0);

      setTextMock.mockImplementation((_t: string) => Promise.reject(new Error("no wails")));
      setExecCommand(() => false);
      clipboard.copyTextQuiet("bad");
      await new Promise((r) => setTimeout(r, 5));
      expect(warns).toHaveLength(1);
    } finally {
      console.warn = origWarn;
    }
  });
});
