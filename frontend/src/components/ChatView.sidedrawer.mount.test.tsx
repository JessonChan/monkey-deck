// Mount-test the ChatView side-panel drawer entry (issue #124): the header
// button (mobile-only via CSS) must render when the prop is wired and fire
// App's open callback on click. Pins the wiring the ≤768px drawer depends on:
// entry button → onOpenSideDrawer → App.openRightDrawer (data-md-side-drawer).
// Same mock scaffolding as ChatView.virtual.mount.test.tsx (bindings / i18n /
// tooltip stubbed;挂载期不触发真后端调用).

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

// ---- ResizeObserver mock: ChatView measures rows via RO on mount ----
class MockResizeObserver {
  cb: ResizeObserverCallback;
  observed = new Set<Element>();
  constructor(cb: ResizeObserverCallback) { this.cb = cb; }
  observe(el: Element) { this.observed.add(el); }
  unobserve(el: Element) { this.observed.delete(el); }
  disconnect() { this.observed.clear(); }
}
(globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;

// ---- binding / i18n / tooltip mock(挂载期不触发真后端调用)----
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

// 在 mock 注册后再导入组件(确保拿到 mocked 依赖)。
const { default: ChatView } = await import("./ChatView.tsx");
import type { ChatItem } from "../types";

const baseProps = {
  project: null,
  session: { id: "s1" },
  items: [{ type: "user", id: "u0", text: "hello", ts: 1000 }] as ChatItem[],
  status: "idle",
  statusDetail: "",
  usage: { used: 0, size: 0, cost: 0, cachedReadTokens: 0, cachedWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
  error: null,
  permission: null,
  mergeResult: null,
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

function mount(props: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<ChatView {...(baseProps as never)} {...(props as never)} />);
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

describe("ChatView side-panel drawer entry (#124)", () => {
  test("renders the header entry when onOpenSideDrawer is wired; click fires it", async () => {
    const onOpenSideDrawer = mock(() => {});
    const { host, root } = mount({ onOpenSideDrawer });
    await flush();

    const btn = host.querySelector('[data-testid="open-side-drawer"]') as HTMLElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute("aria-label")).toBe("app.expandSidePanel");
    // Sits in the header actions row (right edge), after the status badge.
    expect(btn!.closest(".chat-header-actions")).not.toBeNull();

    btn!.dispatchEvent(click());
    await flush();
    expect(onOpenSideDrawer).toHaveBeenCalledTimes(1);

    root.unmount();
  });

  test("no entry button without the prop (desktop default wiring omits it)", async () => {
    const { host, root } = mount({});
    await flush();
    expect(host.querySelector('[data-testid="open-side-drawer"]')).toBeNull();
    root.unmount();
  });
});
