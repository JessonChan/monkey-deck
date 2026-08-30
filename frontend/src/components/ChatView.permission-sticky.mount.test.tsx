// ChatView.permission-sticky.mount.test.tsx:#73 权限卡 sticky 常驻 mount 测试。
//
// 锁定三件事:
//   1. 权限卡移出时间线滚动流,钉在 chat-body 之外的 sticky dock(composer 上方)——
//      时间线滚动后卡仍在 DOM、节点不变(「响应前永在视野」的布局不变量)。
//   2. 时间线尾部留占位行(「权限待确认」),点击聚焦 sticky 卡。
//   3. 无权限时不渲染 dock / 占位行。
//
// Same skeleton as ChatView.permission-hint.mount.test.tsx: happy-dom + mocked
// bindings/i18n/tooltip/wails-runtime (i18n returns keys verbatim), real React tree.

import { describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";
import type { PermissionPrompt } from "../types";

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
    sessionDiff: null,
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

const tick = () => new Promise<void>((r) => setTimeout(r, 20));

describe("PermissionCard sticky dock (#73)", () => {
  test("card lives outside the scrollable timeline and survives scrolling", async () => {
    const { host, root } = await mountWith(promptOf({}));
    const body = host.querySelector('[data-testid="chat-body"]');
    const dock = host.querySelector('[data-testid="permission-dock"]');
    expect(body).toBeTruthy();
    expect(dock).toBeTruthy();
    // 布局不变量:卡不在滚动容器内(flex 兄弟区,时间线滚多远都在视野)。
    expect(body.contains(dock)).toBe(false);
    const card = dock.querySelector('[data-testid="permission-card"]');
    expect(card).toBeTruthy();
    // 硬滚动时间线 → 卡节点原样保留(不卸载、不消失)。
    (body as HTMLElement).scrollTop = 5000;
    body.dispatchEvent(new window.Event("scroll"));
    await tick();
    expect(host.querySelector('[data-testid="permission-card"]')).toBe(card);
    root.unmount();
    host.remove();
  });

  test("timeline keeps a clickable placeholder row where the card used to be", async () => {
    const { host, root } = await mountWith(promptOf({}));
    const body = host.querySelector('[data-testid="chat-body"]');
    const tail = body.querySelector('[data-iid="__tail__"]');
    const ph = body.querySelector('[data-testid="permission-placeholder"]');
    expect(tail).toBeTruthy();
    expect(ph).toBeTruthy();
    // cv-tail 不再直接渲染卡(卡已上浮);占位行文案走 i18n key。
    expect(tail.querySelector('[data-testid="permission-card"]')).toBeNull();
    expect(ph.textContent).toContain("chat.permPendingPlaceholder");
    root.unmount();
    host.remove();
  });

  test("clicking the placeholder focuses the sticky card", async () => {
    const { host, root } = await mountWith(promptOf({}));
    const ph = host.querySelector('[data-testid="permission-placeholder"]');
    const card = host.querySelector('[data-testid="permission-card"]');
    expect(document.activeElement).not.toBe(card);
    ph.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await tick();
    expect(document.activeElement).toBe(card);
    root.unmount();
    host.remove();
  });

  test("no permission → neither dock nor placeholder renders", async () => {
    const { host, root } = await mountWith(null);
    expect(host.querySelector('[data-testid="permission-dock"]')).toBeNull();
    expect(host.querySelector('[data-testid="permission-placeholder"]')).toBeNull();
    root.unmount();
    host.remove();
  });
});
