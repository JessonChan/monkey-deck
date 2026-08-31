// Mount-test ChatView fork button (#172 Phase 2).
//
// Pins the declared-bit gate contract end to end:
//  1. canFork=true → agent reply actions row renders 「分叉」 (fork-msg) next to
//     copy; clicking calls onForkSession (the App forkSession chain).
//  2. canFork=false (undeclared harness) → the button is NOT rendered at all
//     (hide, not disable — iron rule ①).
//  3. canFork=true + prompting → button renders but DISABLED, wrapped in the
//     busy tooltip span (「源会话忙」); clicking a disabled button is a no-op.
//  4. User messages never get a fork action, even when canFork=true.
//  5. zh/en locale copy pinned for forkAction / forkTip / forkSourceBusyTip.
//
// Same happy-dom + geometry-mock scaffolding as msgmeta.duration.mount.test.tsx.

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

// ---- geometry mock (few rows, all in window) ----
const VIEWPORT = 600;
const ZONE_H = 22;
const ROW_H = 100;
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    const cls = this.className || "";
    if (cls.includes("cv-head") || cls.includes("cv-tail")) return ZONE_H;
    return ROW_H;
  },
});
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get(this: HTMLElement) {
    const cls = this.className || "";
    if (cls.includes("chat-body") || cls.includes("cv-viewport")) return VIEWPORT;
    return ROW_H;
  },
});

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;

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
// Dynamic import is intentional here (module-loading-boundary exception): the
// component module must be imported only AFTER mock.module() registrations
// above, or ChatView would capture the real bindings/i18n modules. Same
// pattern as msgmeta.duration.mount.test.tsx.
const { default: ChatView } = await import("./ChatView.tsx");
import type { ChatItem } from "../types";
import zh from "../i18n/locales/zh.json";
import en from "../i18n/locales/en.json";

function items(): ChatItem[] {
  return [
    { type: "user", id: "u0", text: "hello" },
    { type: "agent", id: "a1", text: "hi there" },
  ];
}

function baseProps(itemsList: ChatItem[], status: "idle" | "prompting", extra: Record<string, unknown> = {}) {
  return {
    project: null, session: { id: "s1" }, items: itemsList, status, statusDetail: "",
    usage: { used: 0, size: 0, cost: 0, cachedReadTokens: 0, cachedWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
    error: null, permission: null, mergeResult: null,
    onSend: () => {}, onEnqueue: () => {}, onStop: () => {}, onContinue: () => {},
    onRespondPermission: () => {}, onToggleTerminal: () => {}, onRefreshConfig: () => {},
    onMerge: () => {}, queue: [], onInterruptQueue: () => {}, onRevokeQueue: () => {}, onEditQueue: () => {}, onScheduleQueue: () => {}, onReorderQueue: () => {},
    composerValue: "", onComposerChange: () => {}, attachments: [], onAttachmentsChange: () => {},
    mentions: [], onMentionsChange: () => {}, images: [], onImagesChange: () => {}, imageSupported: false,
    audios: [], onAudiosChange: () => {}, audioSupported: false,
    history: [], sessionId: "s1", configOptions: [], branch: "", livePlan: null, onSetConfig: () => {},
    hasMore: false, loadingMore: false, onLoadMore: () => {},
    ...extra,
  };
}

function mount(itemsList: ChatItem[], status: "idle" | "prompting", extra: Record<string, unknown> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<ChatView {...(baseProps(itemsList, status, extra) as never)} />);
  return { host, root };
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
async function settle() { for (let i = 0; i < 10; i++) await delay(2); }

const forkCallsOf = (fn: unknown): unknown[][] => (fn as { mock: { calls: unknown[][] } }).mock.calls;

describe("ChatView fork button(#172 声明位门控)", () => {
  test("declared:agent 行渲染分叉按钮,点击走 onForkSession;user 行无分叉", async () => {
    const onForkSession = mock(() => {});
    const { host } = mount(items(), "idle", { canFork: true, onForkSession });
    await settle();

    const btns = host.querySelectorAll<HTMLElement>('[data-testid="fork-msg"]');
    expect(btns.length).toBe(1); // 仅 agent 行(1 条 user + 1 条 agent)
    expect(btns[0].textContent).toContain("chat.forkAction");
    expect(btns[0].getAttribute("data-tooltip-content")).toBe("chat.forkTip");

    btns[0].click();
    await settle();
    expect(forkCallsOf(onForkSession).length).toBe(1);
  });

  test("undeclared:分叉按钮完全不渲染(隐藏而非禁用)", async () => {
    const onForkSession = mock(() => {});
    const { host } = mount(items(), "idle", { canFork: false, onForkSession });
    await settle();

    expect(host.querySelector('[data-testid="fork-msg"]')).toBeNull();
    // 复制按钮仍在(操作行不消失,只少分叉一项)。
    expect(host.querySelector('[data-testid="copy-msg"]')).not.toBeNull();
    expect(forkCallsOf(onForkSession).length).toBe(0);
  });

  test("prompting:分叉按钮置灰(disabled)包在忙 tooltip span 里,点击无效", async () => {
    const onForkSession = mock(() => {});
    const { host } = mount(items(), "prompting", { canFork: true, onForkSession });
    await settle();

    const btn = host.querySelector<HTMLButtonElement>('[data-testid="fork-msg"]');
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(true);
    const wrap = btn!.closest(".msg-fork-wrap");
    expect(wrap).not.toBeNull();
    expect(wrap!.getAttribute("data-tooltip-content")).toBe("chat.forkSourceBusyTip");

    btn!.click();
    await settle();
    expect(forkCallsOf(onForkSession).length).toBe(0);
  });

  test("zh/en 文案钉死", () => {
    expect((zh as Record<string, any>).chat.forkAction).toBe("分叉");
    expect((zh as Record<string, any>).chat.forkTip).toBe("从当前对话末尾分叉");
    expect((zh as Record<string, any>).chat.forkSourceBusyTip).toBe("源会话忙");
    expect((en as Record<string, any>).chat.forkAction).toBe("Fork");
    expect((en as Record<string, any>).chat.forkTip).toBe("Fork from the end of this conversation");
    expect((en as Record<string, any>).chat.forkSourceBusyTip).toBe("Source session is busy");
  });
});
