// 端到端验收(Task #23433):agent 回复 msg-meta 显示本轮持续时间(格式化历时)。
// 真实 React 树挂载 ChatView,断言 agent 消息底部 `.msg-dur` 渲染出本轮耗时,且进行中(prompting)
// 的回合不显示时长(零回归)。复用 virtual.mount.test 的 happy-dom 套路。
//
// 语义(需求钉死 #68):duration 只挂 agent 回复,不许放 user 消息。每条 user 开启的这轮的
// 耗时挂到该回合「最后一条 agent 回复」。故 agent1 的 msg-meta 显示 turn1(user0→agent1)的耗时;
// agent3 的 msg-meta 显示 turn2(user2→agent3)的耗时;user 消息底部无 dur 段。

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
  SessionFuzzyFind: async () => [],
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
    audios: [], onAudiosChange: () => {}, audioSupported: false,
    history: [], sessionId: "s1", configOptions: [], branch: "", livePlan: null, onSetConfig: () => {},
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

describe("agent msg-meta 显示本轮持续时间(端到端验收)", () => {
  test("多轮(idle):每条 agent 回复 msg-meta 显示对应回合耗时(turn1 90s→1m 30s,turn2 83s→1m 23s)", async () => {
    const { host, root } = mount(twoTurnItems(), "idle");
    await flush();
    await settle();

    const durs = host.querySelectorAll("[data-testid='msg-agent'] .msg-dur");
    // 两条 agent 都有 msg-meta:durs[0] = agent1 = turn1(90s = "1m 30s");
    // durs[1] = agent3 = turn2(83s = "1m 23s")。
    expect(durs.length).toBe(2);
    expect(durs[0].textContent).toContain("1m 30s");
    expect(durs[1].textContent).toContain("1m 23s");
    const times = host.querySelectorAll("[data-testid='msg-agent'] .msg-time");
    expect(times.length).toBe(2);
    expect(times[1].textContent).toContain(" · 1m 23s");
    // user 消息底部不挂 dur(需求钉死 #68)。
    expect(host.querySelectorAll("[data-testid='msg-user'] .msg-dur").length).toBe(0);

    root.unmount();
  });

  test("进行中(prompting)的最后一回合不显示时长(零回归)", async () => {
    // 两轮,turn2 仍在 prompting → agent3 的 msg-meta 不显示时长;turn1 已结束(agent1 有时长)。
    const { host, root } = mount(twoTurnItems(), "prompting");
    await flush();
    await settle();
    const durs = host.querySelectorAll("[data-testid='msg-agent'] .msg-dur");
    // 仅 turn1 有时长(90s = "1m 30s");turn2 进行中无 dur 段。
    expect(durs.length).toBe(1);
    expect(durs[0].textContent).toContain("1m 30s");
    // 两条 agent 消息本身都在(时间戳还在),只是 turn2 的没有 dur 段。
    expect(host.querySelectorAll("[data-testid='msg-agent'] .msg-time").length).toBe(2);
    root.unmount();
  });

  test("prompting → idle:turn2 结束后,agent3 的 msg-meta 出现时长", async () => {
    const { host, root } = mount(twoTurnItems(), "prompting");
    await flush();
    await settle();
    // prompting:turn1 有时长,turn2 无 → 仅 1 条 dur。
    expect(host.querySelectorAll("[data-testid='msg-agent'] .msg-dur").length).toBe(1);

    root.render(<ChatView {...(baseProps(twoTurnItems(), "idle") as never)} />);
    await flush();
    await settle();
    const durs = host.querySelectorAll("[data-testid='msg-agent'] .msg-dur");
    // idle:两回合均结束 → 2 条 dur;turn1 = "1m 30s",turn2 = "1m 23s"。
    expect(durs.length).toBe(2);
    expect(durs[0].textContent).toContain("1m 30s");
    expect(durs[1].textContent).toContain("1m 23s");

    root.unmount();
  });

  test("时长格式化边界:<1s 不显示;90s→1m 30s;3661s→1h 01m", async () => {
    // <1s:两回合时长均 500ms → 均不渲染 dur(两条 agent msg-meta 在,但无 dur 段)。
    const tiny: ChatItem[] = [
      { type: "user", id: "u0", text: "a", ts: T0 },
      { type: "agent", id: "a1", text: "b", ts: T0 + 500 },
      { type: "user", id: "u2", text: "c", ts: T0 + 1000 },
      { type: "agent", id: "a3", text: "d", ts: T0 + 1000 + 500 },
    ];
    const { host: h1, root: r1 } = mount(tiny, "idle");
    await flush(); await settle();
    expect(h1.querySelectorAll("[data-testid='msg-agent'] .msg-dur").length).toBe(0);
    r1.unmount();

    // 90s → "1m 30s"(turn2;turn1 时长 1s → "1s")
    const m90: ChatItem[] = [
      { type: "user", id: "u0", text: "a", ts: T0 },
      { type: "agent", id: "a1", text: "b", ts: T0 + 1000 },
      { type: "user", id: "u2", text: "c", ts: T0 + 2000 },
      { type: "agent", id: "a3", text: "d", ts: T0 + 2000 + 90_000 },
    ];
    const { host: h2, root: r2 } = mount(m90, "idle");
    await flush(); await settle();
    const durs2 = h2.querySelectorAll("[data-testid='msg-agent'] .msg-dur");
    expect(durs2[1].textContent).toContain("1m 30s");
    r2.unmount();

    // 3661s → "1h 01m"(turn2)
    const h3661: ChatItem[] = [
      { type: "user", id: "u0", text: "a", ts: T0 },
      { type: "agent", id: "a1", text: "b", ts: T0 + 1000 },
      { type: "user", id: "u2", text: "c", ts: T0 + 2000 },
      { type: "agent", id: "a3", text: "d", ts: T0 + 2000 + 3_661_000 },
    ];
    const { host: h3, root: r3 } = mount(h3661, "idle");
    await flush(); await settle();
    const durs3 = h3.querySelectorAll("[data-testid='msg-agent'] .msg-dur");
    expect(durs3[1].textContent).toContain("1h 01m");
    r3.unmount();
  });

  test("多 agent 段:duration 只挂该回合最后一条 agent 回复", async () => {
    // turn1:user0 → agent1(thought/tool 中间段)→ agent2(最终回复)。duration 应挂 agent2,不挂 agent1。
    const multi: ChatItem[] = [
      { type: "user", id: "u0", text: "hi", ts: T0 },
      { type: "agent", id: "a1", text: "thinking…", ts: T0 + 5_000 },
      { type: "agent", id: "a2", text: "final answer", ts: T0 + 42_000 },
    ];
    const { host, root } = mount(multi, "idle");
    await flush(); await settle();
    const durs = host.querySelectorAll("[data-testid='msg-agent'] .msg-dur");
    // 仅 agent2(最后一条)有 dur(42s = "42s");agent1 无 dur 段。
    expect(durs.length).toBe(1);
    expect(durs[0].textContent).toContain("42s");
    root.unmount();
  });
});
