// 端到端验收(Task #22113 Review #45):TurnDivider 显示本轮持续时间。
// 真实 React 树挂载 ChatView,断言 `.turn-divider-dur` 渲染出本轮耗时,且进行中(prompting)
// 的回合不显示时长(零回归)。复用 virtual.mount.test 的 happy-dom 套路。
//
// 语义(实现 / 设计一致):每条 user 消息(首条除外)前的 TurnDivider 标注「该 user 开启的这轮」
// 的开始时刻 + 持续时间(Option A:divider 标注它所衔接的那一轮)。故 user2 前的分隔线显示 turn2
// (user2→agent3)的耗时;turn1(user0→agent1)无分隔线(首条无 divider,与改动前一致)。

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

// ---- 几何 mock(行少,全部进窗口)----
const VIEWPORT = 600;
const ZONE_H = 22;
const ROW_H = 100;
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    const iid = this.dataset?.iid;
    if (iid === "__head__" || iid === "__tail__") return ZONE_H;
    if (this.classList?.contains("cv-item")) return ROW_H;
    return 0;
  },
});
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get(this: HTMLElement) { return this.classList?.contains("chat-body") ? VIEWPORT : 0; },
});

class MockResizeObserver {
  cb: ResizeObserverCallback;
  observed = new Set<Element>();
  constructor(cb: ResizeObserverCallback) { this.cb = cb; }
  observe(el: Element) { this.observed.add(el); }
  unobserve(el: Element) { this.observed.delete(el); }
  disconnect() { this.observed.clear(); }
  trigger() {
    const entries = [...this.observed].map((target) => ({ target }) as unknown as ResizeObserverEntry);
    this.cb(entries, this as unknown as ResizeObserver);
  }
}
(globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;

mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => ({
  ToggleMaximise: async () => {},
  OpenURL: async () => {},
  SessionReadFile: async () => "",
  SessionListDir: async () => [],
  PickFiles: async () => [],
}));
mock.module("react-tooltip", () => ({ Tooltip: () => null, default: () => null }));
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: "3rd-party" },
  default: { useTranslation: () => ({ t: (k: string) => k }) },
}));

const { default: ChatView } = await import("./ChatView.tsx");
import type { ChatItem } from "../types";

const T0 = 1_000_000;
// turn1:user0(t=T0) → agent1(t=T0+90s);turn2:user2(t=T0+200s) → agent3(t=T0+200s+83s)。
function twoTurnItems(): ChatItem[] {
  return [
    { type: "user", id: "u0", text: "hello", ts: T0 },
    { type: "agent", id: "a1", text: "hi", ts: T0 + 90_000 },
    { type: "user", id: "u2", text: "again", ts: T0 + 200_000 },
    { type: "agent", id: "a3", text: "yo", ts: T0 + 200_000 + 83_000 },
  ];
}

function baseProps(items: ChatItem[], status: "idle" | "prompting") {
  return {
    project: null, session: { id: "s1" }, items, status, statusDetail: "",
    usage: { used: 0, size: 0, cost: 0, cachedReadTokens: 0, cachedWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
    error: null, permission: null, mergeResult: null, sessionDiff: null,
    onSend: () => {}, onEnqueue: () => {}, onStop: () => {}, onContinue: () => {}, onAction: () => {},
    onRespondPermission: () => {}, onToggleTerminal: () => {}, onRefreshConfig: () => {},
    onMerge: () => {}, queue: [], onInterruptQueue: () => {}, onRevokeQueue: () => {}, onEditQueue: () => {}, onScheduleQueue: () => {}, onReorderQueue: () => {},
    composerValue: "", onComposerChange: () => {}, attachments: [], onAttachmentsChange: () => {},
    mentions: [], onMentionsChange: () => {}, images: [], onImagesChange: () => {}, imageSupported: false,
    history: [], sessionId: "s1", configOptions: [], livePlan: null, onSetConfig: () => {},
    hasMore: false, loadingMore: false, onLoadMore: () => {},
  };
}

function mount(items: ChatItem[], status: "idle" | "prompting") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<ChatView {...(baseProps(items, status) as never)} />);
  return { host, root };
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
async function flush() { for (let i = 0; i < 10; i++) await delay(2); }
async function settle() { await flush(); }

describe("TurnDivider 显示本轮持续时间(端到端验收)", () => {
  test("多轮(idle):user2 前的分隔线显示 turn2 耗时(83s → 1m 23s)", async () => {
    const { host, root } = mount(twoTurnItems(), "idle");
    await flush();
    await settle();

    const durs = host.querySelectorAll(".turn-divider-dur");
    // 仅 user2 前有分隔线(首条 user0 无 divider);它标注 turn2(user2→agent3)= 83s = "1m 23s"。
    expect(durs.length).toBe(1);
    expect(durs[0].textContent).toContain("1m 23s");
    const time = host.querySelector(".turn-divider-time");
    expect(time).not.toBeNull();
    expect(time!.textContent).toContain(" · 1m 23s");

    root.unmount();
  });

  test("进行中(prompting)的最后一回合不显示时长(零回归)", async () => {
    // 两轮,turn2 仍在 prompting → user2 前的分隔线不显示时长;turn1 无 divider。
    const { host, root } = mount(twoTurnItems(), "prompting");
    await flush();
    await settle();
    expect(host.querySelectorAll(".turn-divider-dur").length).toBe(0);
    // 分隔线本身仍在(时间戳还在),只是没有 dur 段。
    expect(host.querySelectorAll(".turn-divider").length).toBe(1);
    root.unmount();
  });

  test("prompting → idle:turn2 结束后,user2 前分隔线出现时长", async () => {
    const { host, root } = mount(twoTurnItems(), "prompting");
    await flush();
    await settle();
    expect(host.querySelectorAll(".turn-divider-dur").length).toBe(0);

    root.render(<ChatView {...(baseProps(twoTurnItems(), "idle") as never)} />);
    await flush();
    await settle();
    const durs = host.querySelectorAll(".turn-divider-dur");
    expect(durs.length).toBe(1);
    expect(durs[0].textContent).toContain("1m 23s");

    root.unmount();
  });

  test("时长格式化边界:<1s 不显示;90s→1m 30s;3661s→1h 01m", async () => {
    // <1s:turn 时长 500ms → 不渲染 dur。
    const tiny: ChatItem[] = [
      { type: "user", id: "u0", text: "a", ts: T0 },
      { type: "agent", id: "a1", text: "b", ts: T0 + 500 },
      { type: "user", id: "u2", text: "c", ts: T0 + 1000 },
      { type: "agent", id: "a3", text: "d", ts: T0 + 1000 + 500 },
    ];
    const { host: h1, root: r1 } = mount(tiny, "idle");
    await flush(); await settle();
    expect(h1.querySelectorAll(".turn-divider-dur").length).toBe(0);
    r1.unmount();

    // 90s → "1m 30s"
    const m90: ChatItem[] = [
      { type: "user", id: "u0", text: "a", ts: T0 },
      { type: "agent", id: "a1", text: "b", ts: T0 + 1000 },
      { type: "user", id: "u2", text: "c", ts: T0 + 2000 },
      { type: "agent", id: "a3", text: "d", ts: T0 + 2000 + 90_000 },
    ];
    const { host: h2, root: r2 } = mount(m90, "idle");
    await flush(); await settle();
    expect(h2.querySelector(".turn-divider-dur")!.textContent).toContain("1m 30s");
    r2.unmount();

    // 3661s → "1h 01m"
    const h3661: ChatItem[] = [
      { type: "user", id: "u0", text: "a", ts: T0 },
      { type: "agent", id: "a1", text: "b", ts: T0 + 1000 },
      { type: "user", id: "u2", text: "c", ts: T0 + 2000 },
      { type: "agent", id: "a3", text: "d", ts: T0 + 2000 + 3_661_000 },
    ];
    const { host: h3, root: r3 } = mount(h3661, "idle");
    await flush(); await settle();
    expect(h3.querySelector(".turn-divider-dur")!.textContent).toContain("1h 01m");
    r3.unmount();
  });
});
