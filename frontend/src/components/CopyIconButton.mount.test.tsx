// CopyIconButton mount test (issue #129): the transient feedback contract —
// success shows the "copied" tooltip, total clipboard failure shows "copyFailed"
// (+ data-copy-failed) instead of a false Check. i18n keys are returned
// verbatim by the mock, so assertions compare against key strings.

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import CopyIconButton from "./CopyIconButton";

// ---- happy-dom setup ----
const win = new Window();
const doc = win.document;
(globalThis as Record<string, unknown>).window = win;
(globalThis as Record<string, unknown>).document = doc;
(globalThis as Record<string, unknown>).navigator = win.navigator;
(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(performance.now()), 0);
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);
win.React = React;

// react-i18next: return keys verbatim.
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

// happy-dom has no document.execCommand; it DOES ship navigator.clipboard
// (writeText resolves) — neuter it so a rejecting SetText means every channel
// fails, which is exactly the failure scenario under test.
const setTextMock = mock((_t: string) => Promise.resolve());
mock.module("@wailsio/runtime", () => ({ Clipboard: { SetText: setTextMock } }));
Object.defineProperty(win.navigator, "clipboard", { value: undefined, configurable: true });

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 2));
}

function render(node: React.ReactNode): { container: HTMLElement; root: Root } {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container);
  root.render(node);
  return { container, root };
}

beforeEach(() => {
  setTextMock.mockReset();
});

describe("CopyIconButton failure feedback", () => {
  test("Wails3 channel success → copied tooltip, no failure flag", async () => {
    setTextMock.mockImplementation((_t: string) => Promise.resolve());
    const { container } = render(<CopyIconButton text="ok" />);
    await flush();
    const btn = container.querySelector("button") as HTMLButtonElement;
    btn.click();
    await flush();
    expect(btn.getAttribute("data-tooltip-content")).toBe("common.copied");
    expect(btn.hasAttribute("data-copy-failed")).toBe(false);
  });

  test("every channel fails → copyFailed tooltip + data-copy-failed, never a false copied", async () => {
    setTextMock.mockImplementation((_t: string) => Promise.reject(new Error("no wails")));
    const { container } = render(<CopyIconButton text="bad" />);
    await flush();
    const btn = container.querySelector("button") as HTMLButtonElement;
    btn.click();
    await flush();
    expect(btn.getAttribute("data-tooltip-content")).toBe("common.copyFailed");
    expect(btn.getAttribute("data-copy-failed")).toBe("true");
  });
});
