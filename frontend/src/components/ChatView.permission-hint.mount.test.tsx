// Mount-test the PermissionCard global-allow hint (#143): the dialog must state WHAT a
// "allow globally" decision will remember, branched by action type, with a preview value
// extracted from the decision context (command text / exact path / basename) and a generic
// fallback when the context is empty.
//
// Same skeleton as ChatView.virtual.mount.test.tsx: happy-dom + mocked bindings/i18n
// (i18n returns keys verbatim so assertions are stable), real React tree otherwise.

import { describe, test, expect, mock } from "bun:test";
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
globalThis.localStorage = window.localStorage;
window.React = React;

// ---- geometry mocks (empty item list; keeps the virtualizer's mount pass happy) ----
class MockResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) { this.cb = cb; }
  observe() {} unobserve() {} disconnect() {}
}
(globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;

// ---- binding / i18n / tooltip mocks (nothing touches the backend at mount) ----
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => ({
  ToggleMaximise: async () => {},
  OpenURL: async () => {},
  SessionReadFile: async () => "",
  SessionListDir: async () => [],
  SessionFuzzyFind: async () => [],
  PickFiles: async () => [],
  GetSessionMcpServers: async () => [],
}));
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

// Static import would load ChatView before mock.module() registers the fake bindings/i18n;
// bun applies mocks to modules loaded after registration (same pattern as the other
// ChatView mount tests).
const { default: ChatView } = await import("./ChatView.tsx");

function baseProps(permission: PermissionPrompt | null) {
  return {
    project: null,
    session: { id: "s1" },
    items: [],
    status: "idle",
    statusDetail: "",
    usage: { used: 0, size: 0, cost: 0, cachedReadTokens: 0, cachedWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
    error: null,
    permission,
    mergeResult: null,
    notice: null,
    onSend: () => {},
    onEnqueue: () => {},
    onStop: () => {},
    onContinue: () => {},
    onRespondPermission: () => {},
    onToggleTerminal: () => {},
    onRefreshConfig: () => {},
    onMerge: () => {},
    queue: [],
    onInterruptQueue: () => {},
    onRevokeQueue: () => {},
    onEditQueue: () => {},
    onScheduleQueue: () => {},
    onReorderQueue: () => {},
    composerValue: "",
    onComposerChange: () => {},
    attachments: [],
    onAttachmentsChange: () => {},
    mentions: [],
    onMentionsChange: () => {},
    images: [],
    onImagesChange: () => {},
    imageSupported: false,
    audios: [],
    onAudiosChange: () => {},
    audioSupported: false,
    history: [],
    sessionId: "s1",
    configOptions: [],
    branch: "",
    livePlan: null,
    onSetConfig: () => {},
    hasMore: false,
    loadingMore: false,
    onLoadMore: () => {},
  };
}


async function mountWith(permission: PermissionPrompt | null) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<ChatView {...(baseProps(permission) as never)} />);
  // React commits concurrently; let the tree land before querying.
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 30);
  await promise;
  return { host, root };
}

function promptOf(p: Partial<PermissionPrompt>): PermissionPrompt {
  return {
    id: "p1", sessionId: "s1", toolName: "read", title: "",
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    ...p,
  };
}

describe("PermissionCard global-allow hint (#143)", () => {
  test("exec shows exact-command hint with command preview", async () => {
    const { host, root } = await mountWith(promptOf({
      actionType: "exec",
      command: "git status",
      locations: ["/tmp/x"],
    }));
    const hint = host.querySelector('[data-testid="perm-global-hint"]');
    expect(hint?.textContent ?? "").toContain("chat.permGlobalHintExec");
    expect(host.querySelector('[data-testid="perm-global-preview"]')?.textContent ?? "").toBe("git status");
    root.unmount();
    host.remove();
  });

  test("read shows filename hint with basename preview", async () => {
    const { host, root } = await mountWith(promptOf({
      actionType: "read",
      locations: ["/projA/src/notes.md"],
    }));
    expect(host.querySelector('[data-testid="perm-global-hint"]')?.textContent ?? "").toContain("chat.permGlobalHintRead");
    expect(host.querySelector('[data-testid="perm-global-preview"]')?.textContent ?? "").toBe("notes.md");
    root.unmount();
    host.remove();
  });

  test("write shows exact-path hint with absolute path preview", async () => {
    const { host, root } = await mountWith(promptOf({
      actionType: "write",
      locations: ["/projA/notes.md"],
    }));
    expect(host.querySelector('[data-testid="perm-global-hint"]')?.textContent ?? "").toContain("chat.permGlobalHintWrite");
    expect(host.querySelector('[data-testid="perm-global-preview"]')?.textContent ?? "").toBe("/projA/notes.md");
    root.unmount();
    host.remove();
  });

  test("empty decision context falls back to the generic hint without preview", async () => {
    const { host, root } = await mountWith(promptOf({ actionType: "other" }));
    expect(host.querySelector('[data-testid="perm-global-hint"]')?.textContent ?? "").toContain("chat.permGlobalHintGeneric");
    expect(host.querySelector('[data-testid="perm-global-preview"]')).toBeNull();
    root.unmount();
    host.remove();
  });
});
