// Mount-test the FilePanel → chat-area HTML5 drag @mention channel (issue #149).
//
// §5.3 invariants pinned here:
//  - dragstart writes the agreed panel payload (application/x-md-panel-file JSON
//    {sessionId, path}) + effectAllowed=copy — the contract both ends share
//  - dragover claiming is keyed on the MIME in dataTransfer.types ONLY, so OS
//    file drags (types="Files") never trigger the overlay nor preventDefault —
//    the Wails native channel (#24255/#83) keeps owning them, zero regression
//  - drop appends "@<rel> " to the draft end and registers the mention at most
//    once per path (pickMention semantics); the rel is re-derived through
//    dropFiles.relativeToRoot, so anything escaping the session root is ignored
//  - cross-window guard: a payload whose sessionId ≠ the visible session's is
//    ignored (the drop target is whoever is visible, not whoever dragged)

import { describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";

// ---- happy-dom setup (same skeleton as sibling *.mount.test.tsx) ----
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
globalThis.localStorage = window.localStorage;
window.React = React;

class MockResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) { this.cb = cb; }
  observe() {} unobserve() {} disconnect() {}
}
(globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;

mock.module("react-tooltip", () => ({ Tooltip: () => null, default: () => null }));
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: "3rd-party" },
  default: { useTranslation: () => ({ t: (k: string) => k }) },
}));
mock.module("mermaid", () => ({
  default: {
    initialize: () => {},
    render: async () => ({ svg: "<svg/>", diagramType: "flowchart" }),
  },
}));

// Union of the binding calls FilePanel + ChatView (+ Composer) can hit at mount.
const listDir = mock((_sid: string, dir: string) => {
  if (dir === "") {
    return Promise.resolve([{ name: "README.md", path: "README.md", isDir: false }]);
  }
  return Promise.resolve([]);
});
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => ({
  ToggleMaximise: async () => {},
  OpenURL: async () => {},
  SessionReadFile: async () => "",
  SessionListDir: listDir,
  SessionFuzzyFind: async () => [],
  SessionReadImage: async () => ({ dataUrl: "" }),
  SessionCreateFile: async () => {},
  SessionCreateDir: async () => {},
  SessionRenamePath: async () => "",
  SessionDeletePath: async () => {},
  RevealPath: async () => {},
  PickFiles: async () => [],
  GetSessionMcpServers: async () => [],
}));

// Static import would load the components before mock.module() registers the
// fakes (same pattern as the sibling mount tests).
const { default: FilePanel } = await import("./FilePanel.tsx");
const { default: ChatView } = await import("./ChatView.tsx");

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

// ---- dataTransfer fake: happy-dom's drag events are not drivable end-to-end,
// but React only reads nativeEvent.dataTransfer — a plain object with the real
// DataTransfer surface (types/setData/getData/effectAllowed/dropEffect) is
// indistinguishable to the handlers under test.
function fakeDataTransfer(types: string[] = []) {
  const store = new Map<string, string>();
  const dt = {
    types: [...types],
    effectAllowed: "uninitialized",
    dropEffect: "none",
    setData(type: string, data: string) {
      store.set(type, data);
      if (!dt.types.includes(type)) dt.types.push(type);
    },
    getData(type: string) {
      return store.get(type) ?? "";
    },
  };
  return dt;
}

function dragEvent(type: string, dt: ReturnType<typeof fakeDataTransfer>) {
  const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: dt });
  return ev as MouseEvent & { dataTransfer: typeof dt };
}

// ---- ChatView harness: draft + mentions are App-owned state mirrored into a
// rerender() so the controlled Composer sees the updated props between drops.
let draft = "";
let mentions: Array<{ path: string; name: string }> = [];

function chatProps(sessionId: string, session: Record<string, unknown>) {
  return {
    project: { id: "p1", name: "proj", path: "/tmp/proj" },
    session,
    items: [],
    status: "idle",
    statusDetail: "",
    usage: { used: 0, size: 0, cost: 0, cachedReadTokens: 0, cachedWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
    branch: "",
    error: null,
    notice: null,
    permission: null,
    elicitation: null,
    mergeResult: null,
    onSend: () => {},
    onEnqueue: () => {},
    onStop: () => {},
    onContinue: () => {},
    onRespondPermission: () => {},
    onRespondElicitation: () => {},
    onToggleTerminal: () => {},
    onNewSessionOnBranch: () => {},
    onRefreshConfig: () => {},
    onMerge: () => {},
    onSetConfig: () => {},
    queue: [],
    onInterruptQueue: () => {},
    onRevokeQueue: () => {},
    onEditQueue: () => {},
    onScheduleQueue: () => {},
    onReorderQueue: () => {},
    onSetRepeatQueue: () => {},
    composerValue: draft,
    onComposerChange: (v: string) => { draft = v; },
    attachments: [],
    onAttachmentsChange: () => {},
    mentions,
    onMentionsChange: (next: Array<{ path: string; name: string }>) => { mentions = next; },
    images: [],
    onImagesChange: () => {},
    imageSupported: false,
    audios: [],
    onAudiosChange: () => {},
    audioSupported: false,
    history: [],
    sessionId,
    configOptions: [],
    commands: [],
    livePlan: null,
    hasMore: false,
    loadingMore: false,
    onLoadMore: () => {},
  };
}

const WORKTREE = "/tmp/work/s1";

async function mountChat(sessionId = "s1") {
  const chat = mount(React.createElement(ChatView, chatProps(sessionId, { id: sessionId, worktreePath: sessionId === "s1" ? WORKTREE : "" }) as never));
  await flush();
  return chat;
}

function chatRoot(chat: { host: HTMLElement }) {
  return chat.host.querySelector(".chat-view") as HTMLElement;
}

describe("FilePanel → chat panel-drag @mention (#149)", () => {
  test("dragstart writes panel payload + copy; drop appends @token, registers mention, dedups repeats", async () => {
    draft = "";
    mentions = [];
    const panel = mount(React.createElement(FilePanel, { sessionId: "s1", rootName: "proj", rootPath: "/tmp/proj", changes: [], status: "idle", onOpenFile: () => {} }));
    await flush();

    const row = panel.host.querySelector('[data-testid="tree-file-row"][data-path="README.md"]') as HTMLElement;
    expect(row).not.toBeNull();

    // dragstart: payload under the agreed MIME, effectAllowed=copy.
    const dt = fakeDataTransfer();
    const startEv = dragEvent("dragstart", dt);
    row.dispatchEvent(startEv);
    expect(dt.getData("application/x-md-panel-file")).toBe(JSON.stringify({ sessionId: "s1", path: "README.md" }));
    expect(dt.effectAllowed).toBe("copy");

    const chat = await mountChat();
    const root = chatRoot(chat);
    expect(root).not.toBeNull();

    // dragover with our MIME: overlay variant renders, drop gets claimed.
    const overDt = fakeDataTransfer();
    overDt.setData("application/x-md-panel-file", JSON.stringify({ sessionId: "s1", path: "README.md" }));
    const overEv = dragEvent("dragover", overDt);
    root.dispatchEvent(overEv);
    await flush();
    const overlay = chat.host.querySelector('[data-testid="chat-mention-drop-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.textContent).toContain("chat.dropMentionTitle");

    // drop: "@<rel> " appended at the draft end, mention registered once.
    const dropEv = dragEvent("drop", overDt);
    root.dispatchEvent(dropEv);
    await flush();
    expect(draft).toBe("@README.md ");
    expect(mentions).toEqual([{ path: "README.md", name: "README.md" }]);
    expect(chat.host.querySelector('[data-testid="chat-mention-drop-overlay"]')).toBeNull();

    // Second drop of the same file: token appended again, registration deduped.
    chat.root.render(React.createElement(ChatView, chatProps("s1", { id: "s1", worktreePath: WORKTREE }) as never));
    await flush();
    const overDt2 = fakeDataTransfer();
    overDt2.setData("application/x-md-panel-file", JSON.stringify({ sessionId: "s1", path: "README.md" }));
    root.dispatchEvent(dragEvent("dragover", overDt2));
    root.dispatchEvent(dragEvent("drop", overDt2));
    await flush();
    expect(draft).toBe("@README.md @README.md ");
    expect(mentions).toEqual([{ path: "README.md", name: "README.md" }]);
  });

  test("cross-window guard: payload sessionId ≠ visible session → drop ignored", async () => {
    draft = "";
    mentions = [];
    const chat = await mountChat("s2"); // this window shows session s2
    const root = chatRoot(chat);

    const dt = fakeDataTransfer();
    dt.setData("application/x-md-panel-file", JSON.stringify({ sessionId: "s1", path: "README.md" }));
    const dropEv = dragEvent("drop", dt);
    root.dispatchEvent(dropEv);
    await flush();
    expect(draft).toBe("");
    expect(mentions).toEqual([]);
    expect(dropEv.defaultPrevented).toBe(true); // still claimed (our MIME), just ignored
  });

  test("OS file drags + malformed payloads stay off the composer (#83 native channel untouched)", async () => {
    draft = "typed text";
    mentions = [];
    const chat = await mountChat();
    const root = chatRoot(chat);

    // OS drag (types=["Files"]): claimed by the @wailsio/runtime global dragover
    // listener — it preventDefaults ANY Files drag at documentElement level to
    // enable native drops (identical in production), so raw defaultPrevented is
    // not ours to assert. What matters for this channel: the mention overlay
    // never shows and the composer is never touched.
    root.dispatchEvent(dragEvent("dragover", fakeDataTransfer(["Files"])));
    await flush();
    expect(chat.host.querySelector('[data-testid="chat-mention-drop-overlay"]')).toBeNull();

    // OS drop: routed by the Wails native channel (backend chat:files-dropped);
    // the panel channel must not append anything.
    root.dispatchEvent(dragEvent("drop", fakeDataTransfer(["Files"])));
    await flush();
    expect(draft).toBe("typed text");
    expect(mentions).toEqual([]);
    expect(chat.host.querySelector('[data-testid="chat-mention-drop-overlay"]')).toBeNull();

    // Our MIME but malformed JSON: claimed (overlay family), but no append.
    const bad = fakeDataTransfer();
    bad.setData("application/x-md-panel-file", "not-json{");
    const badDrop = dragEvent("drop", bad);
    root.dispatchEvent(badDrop);
    await flush();
    expect(badDrop.defaultPrevented).toBe(true);
    expect(draft).toBe("typed text");

    // Path escaping the session root: claimed, but ignored (relativeToRoot = null).
    const esc = fakeDataTransfer();
    esc.setData("application/x-md-panel-file", JSON.stringify({ sessionId: "s1", path: "../../etc/passwd" }));
    const escDrop = dragEvent("drop", esc);
    root.dispatchEvent(escDrop);
    await flush();
    expect(escDrop.defaultPrevented).toBe(true);
    expect(draft).toBe("typed text");
    expect(mentions).toEqual([]);
  });
});
