// Mount-test EditorPane edit mode (text file editing).
//
// Pins the observable contract of the edit flow:
//   1. Text file -> Edit button -> textarea seeded with disk content; editing
//      the buffer marks dirty; ⌘S saves via SessionWriteFile and returns to
//      view mode showing the new content.
//   2. Conflict guard: if the on-disk copy changed after load (the agent edits
//      the same worktree), save refuses to write and shows the conflict banner;
//      "overwrite anyway" then writes the draft.
//   3. Exit with unsaved changes asks for confirmation (Esc dismisses the
//      banner, discard exits without writing).
//   4. Binary files get no edit affordance (the old placeholder-string contract
//      is now the structured FileData flags).
//
// Interaction simulation: clicks and synthetic keydowns only. Draft mutation is
// driven through the real Tab-indent keydown handler — simulating typed text
// into a controlled textarea does not work in this harness (React's change
// plugin drops dispatched input events whose value-tracker check fails), while
// synthetic keydowns dispatch faithfully (same path as QueuePanel mount tests).
//
// Mocks mirror Composer.mount.test.tsx (i18n/tooltip pass-throughs) so the real
// EditorPane renders; the chat binding is a controllable in-memory disk.

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
const writes: { path: string; content: string }[] = [];

// bun test runs all files against one shared module registry: this file's
// mock.module REPLACES whatever mock another test file registered for the
// chatservice binding, and live ESM bindings mean components loaded by EARLIER
// files also see the swap. A fixed 3-method mock therefore breaks sibling
// tests calling exports we don't use (observed: McpChip -> GetSessionMcpServers
// "is not a function"). So register the FULL export surface: parse the real
// generated binding file for its exported function names and back every one
// we don't override with a no-op (undefined degrades gracefully — callers use
// `res?.field ?? []` / .catch fallbacks).
const bindingSrc = await Bun.file(
  new URL("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice.ts", import.meta.url),
).text();
const chatServiceMock: Record<string, unknown> = {};
for (const m of bindingSrc.matchAll(/^export (?:async )?function (\w+)/gm)) {
  chatServiceMock[m[1]] = async () => undefined;
}
chatServiceMock.SessionReadFile = async (_sid: string, rel: string) =>
  disk[rel] ?? { content: "", binary: false, tooLarge: false };
chatServiceMock.SessionReadImage = async () => ({ dataUrl: "", ext: "" });
chatServiceMock.SessionWriteFile = async (_sid: string, rel: string, content: string) => {
  disk[rel] = { content, binary: false, tooLarge: false };
  writes.push({ path: rel, content });
};
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => chatServiceMock);
mock.module("react-tooltip", () => ({ Tooltip: () => null, default: () => null }));
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: "3rd-party" },
  default: { useTranslation: () => ({ t: (k: string) => k }) },
}));
// Component imported AFTER mock registration so its module graph resolves to
// the mocks (bun mock.module only affects post-registration resolution) —
// the module-loading-boundary exception to static imports.
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

// Faithful keydown on the edit textarea (bubbles, cancelable so preventDefault
// in the handler behaves like a real key press).
function key(ta: HTMLTextAreaElement, init: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) {
  ta.dispatchEvent(
    new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
  );
}

const PROPS = {
  sessionId: "s1",
  onClose: () => {},
};

beforeEach(() => {
  for (const k of Object.keys(disk)) delete disk[k];
  writes.length = 0;
});

describe("EditorPane edit mode: save happy path", () => {
  test("edit -> Tab-indent marks dirty -> ⌘S writes and returns to view mode", async () => {
    disk["a.txt"] = { content: "hello", binary: false, tooLarge: false };
    const { host } = mount(<EditorPane {...PROPS} file={{ path: "a.txt" }} />);
    await flush();

    // View mode: edit affordance present, no textarea.
    const editBtn = host.querySelector('[data-testid="editor-edit-btn"]') as HTMLElement;
    expect(editBtn).not.toBeNull();
    expect(host.querySelector('[data-testid="editor-edit-textarea"]')).toBeNull();

    click(editBtn);
    await flush();

    const ta = host.querySelector('[data-testid="editor-edit-textarea"]') as HTMLTextAreaElement;
    expect(ta).not.toBeNull();
    expect(ta.value).toBe("hello");
    // Not dirty yet: save disabled, no dirty dot.
    expect(host.querySelector('[data-testid="editor-dirty"]')).toBeNull();
    expect((host.querySelector('[data-testid="editor-save-btn"]') as HTMLButtonElement).disabled).toBe(true);

    // Edit the buffer through the real Tab-indent handler (appends 2 spaces).
    key(ta, { key: "Tab" });
    await flush();
    expect(ta.value).toBe("hello  ");
    expect(host.querySelector('[data-testid="editor-dirty"]')).not.toBeNull();
    expect((host.querySelector('[data-testid="editor-save-btn"]') as HTMLButtonElement).disabled).toBe(false);

    // ⌘S saves.
    key(ta, { key: "s", metaKey: true });
    await flush();

    // Conflict check passed (disk unchanged) -> write happened with the draft.
    expect(writes).toEqual([{ path: "a.txt", content: "hello  " }]);
    // Back to view mode with saved flash; CodeViewer shows the new content.
    expect(host.querySelector('[data-testid="editor-edit-textarea"]')).toBeNull();
    expect(host.querySelector('[data-testid="editor-saved"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="editor-pane-viewer"]')).not.toBeNull();
    expect(host.textContent).toContain("hello  ");
  });
});

describe("EditorPane edit mode: on-disk conflict guard", () => {
  test("disk changed after load -> save blocked, banner, force overwrites", async () => {
    disk["a.txt"] = { content: "v1", binary: false, tooLarge: false };
    const { host } = mount(<EditorPane {...PROPS} file={{ path: "a.txt" }} />);
    await flush();

    click(host.querySelector('[data-testid="editor-edit-btn"]')!);
    await flush();
    const ta = host.querySelector('[data-testid="editor-edit-textarea"]') as HTMLTextAreaElement;
    key(ta, { key: "Tab" });
    await flush();

    // The agent rewrites the file while the human is editing.
    disk["a.txt"] = { content: "v2-agent", binary: false, tooLarge: false };

    click(host.querySelector('[data-testid="editor-save-btn"]')!);
    await flush();

    // Refused: no write, conflict banner shown, still editing.
    expect(writes).toEqual([]);
    expect(host.querySelector('[data-testid="editor-conflict"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="editor-edit-textarea"]')).not.toBeNull();

    // Force overwrite writes the human draft.
    click(host.querySelector('[data-testid="editor-conflict-force"]')!);
    await flush();
    expect(writes).toEqual([{ path: "a.txt", content: "v1  " }]);
    expect(host.querySelector('[data-testid="editor-conflict"]')).toBeNull();
    expect(host.querySelector('[data-testid="editor-edit-textarea"]')).toBeNull();
  });

  test("conflict reload discards the draft and takes the disk version", async () => {
    disk["a.txt"] = { content: "v1", binary: false, tooLarge: false };
    const { host } = mount(<EditorPane {...PROPS} file={{ path: "a.txt" }} />);
    await flush();

    click(host.querySelector('[data-testid="editor-edit-btn"]')!);
    await flush();
    const ta = host.querySelector('[data-testid="editor-edit-textarea"]') as HTMLTextAreaElement;
    key(ta, { key: "Tab" });
    await flush();

    disk["a.txt"] = { content: "v2-agent", binary: false, tooLarge: false };
    click(host.querySelector('[data-testid="editor-save-btn"]')!);
    await flush();
    expect(host.querySelector('[data-testid="editor-conflict"]')).not.toBeNull();

    click(host.querySelector('[data-testid="editor-conflict-reload"]')!);
    await flush();
    expect(writes).toEqual([]);
    expect(host.querySelector('[data-testid="editor-edit-textarea"]')).toBeNull();
    // View mode shows the agent's on-disk version, not the discarded draft.
    expect(host.textContent).toContain("v2-agent");
  });
});

describe("EditorPane edit mode: exit confirmation", () => {
  test("exit with dirty draft asks; Esc keeps editing; discard exits without writing", async () => {
    disk["a.txt"] = { content: "keep", binary: false, tooLarge: false };
    const { host } = mount(<EditorPane {...PROPS} file={{ path: "a.txt" }} />);
    await flush();

    click(host.querySelector('[data-testid="editor-edit-btn"]')!);
    await flush();
    const ta = host.querySelector('[data-testid="editor-edit-textarea"]') as HTMLTextAreaElement;
    key(ta, { key: "Tab" });
    await flush();

    click(host.querySelector('[data-testid="editor-exit-btn"]')!);
    await flush();
    // Confirm banner, still editing.
    expect(host.querySelector('[data-testid="editor-exit-confirm"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="editor-edit-textarea"]')).not.toBeNull();

    // Esc dismisses the banner and keeps editing.
    key(ta, { key: "Escape" });
    await flush();
    expect(host.querySelector('[data-testid="editor-exit-confirm"]')).toBeNull();
    expect(host.querySelector('[data-testid="editor-edit-textarea"]')).not.toBeNull();

    // Exit again, this time discard.
    click(host.querySelector('[data-testid="editor-exit-btn"]')!);
    await flush();
    click(host.querySelector('[data-testid="editor-exit-discard"]')!);
    await flush();
    expect(host.querySelector('[data-testid="editor-edit-textarea"]')).toBeNull();
    expect(writes).toEqual([]);
    // View mode kept the on-disk content, not the discarded draft.
    expect(host.textContent).toContain("keep");
  });
});

describe("EditorPane edit mode: non-editable files", () => {
  test("binary file shows no edit button, renders placeholder message", async () => {
    disk["b.bin"] = { content: "", binary: true, tooLarge: false };
    const { host } = mount(<EditorPane {...PROPS} file={{ path: "b.bin" }} />);
    await flush();

    expect(host.querySelector('[data-testid="editor-edit-btn"]')).toBeNull();
    expect(host.querySelector('[data-testid="editor-nopreview"]')).not.toBeNull();
    expect(host.textContent).toContain("filePreview.binaryFile");
  });
});
