// Mount-test ChatView 的虚拟化消息列表(§5.5 真 UI × 真数据的轻量替代:happy-dom + React)。
// 目标:证明 W 不变量成立——DOM 中的 .cv-item 数量被窗口钉住(平台期),不随 items 总数线性增长。
// 这是 issue #33 的核心验收点:长会话的 DOM 节点数 / 渲染层内存不再 O(n)。
//
// 与 MermaidRenderer.mount.test.tsx 同套路:stub 掉 binding(真后端调用走事件处理器,挂载期不触发)
// 与 ResizeObserver(手动驱动测量回环),其余全部走真实 React 树 + 真实虚拟化核心。

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

// ---- 几何 mock:offsetHeight / clientHeight 由测试单方面设定 ----
// chat-body 视口 600px;头/尾区各 22px(等价原 .chat-body 上下内边距);每行 100px。
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
  get(this: HTMLElement) {
    return this.classList?.contains("chat-body") ? VIEWPORT : 0;
  },
});

// ---- ResizeObserver mock:捕获实例,手动 trigger 驱动测量回环 ----
class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  cb: ResizeObserverCallback;
  observed = new Set<Element>();
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    MockResizeObserver.instances.push(this);
  }
  observe(el: Element) { this.observed.add(el); }
  unobserve(el: Element) { this.observed.delete(el); }
  disconnect() { this.observed.clear(); }
  trigger() {
    const entries = [...this.observed].map((target) => ({ target }) as unknown as ResizeObserverEntry);
    this.cb(entries, this as unknown as ResizeObserver);
  }
}
(globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;

// ---- binding / i18n / tooltip mock(挂载期不触发真后端调用)----
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

// 在 mock 注册后再导入组件(确保拿到 mocked 依赖)。
const { default: ChatView } = await import("./ChatView.tsx");
import type { ChatItem } from "../types";

function makeItems(n: number): ChatItem[] {
  const items: ChatItem[] = [];
  for (let i = 0; i < n; i++) {
    items.push(
      i % 2 === 0
        ? { type: "user", id: `u${i}`, text: `user message ${i}`, ts: 1000 + i }
        : { type: "agent", id: `a${i}`, text: `agent reply ${i}`, ts: 1000 + i }
    );
  }
  return items;
}

function baseProps(items: ChatItem[]) {
  return {
    project: null,
    session: { id: "s1" },
    items,
    status: "idle",
    statusDetail: "",
    usage: { used: 0, size: 0, cost: 0, cachedReadTokens: 0, cachedWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
    error: null,
    permission: null,
    mergeResult: null,
    sessionDiff: null,
    onSend: () => {},
    onEnqueue: () => {},
    onStop: () => {},
    onContinue: () => {},
    onAction: () => {},
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
    history: [],
    sessionId: "s1",
    configOptions: [],
    livePlan: null,
    onSetConfig: () => {},
    hasMore: false,
    loadingMore: false,
    onLoadMore: () => {},
  };
}

function mount(items: ChatItem[]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<ChatView {...(baseProps(items) as never)} />);
  return { host, root };
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function flush() {
  // happy-dom + React 19 需要若干 tick 完成 commit + passive effects。
  for (let i = 0; i < 10; i++) await delay(2);
}

// 驱动一次测量回环并等待收敛(RO 回调 → setState → 重渲染 → syncObserved)。
async function settle() {
  const ro = MockResizeObserver.instances[MockResizeObserver.instances.length - 1];
  ro.trigger();
  await flush();
}

function countItems(host: HTMLElement): number {
  return host.querySelectorAll(".cv-item").length;
}

describe("ChatView 虚拟化(W 不变量:DOM 平台期)", () => {
  test("DOM 中 .cv-item 数量被窗口钉住,不随 items 总数增长", async () => {
    const { host, root } = mount(makeItems(300));
    await flush();
    await settle();
    await settle();
    await settle();

    const c300 = countItems(host);
    // 平台期:远小于总行数 300,且落在窗口 + overscan 的合理量级(~1800px / 100px ≈ 18 行)。
    expect(c300).toBeGreaterThan(0);
    expect(c300).toBeLessThan(40);

    // 内容层显式高度 = 布局 total(撑开滚动条),远大于视口。
    const content = host.querySelector(".chat-content") as HTMLElement;
    expect(content).not.toBeNull();
    const contentH = parseInt(content.style.height, 10);
    expect(contentH).toBeGreaterThan(VIEWPORT * 3);

    // 追加到 600 条:DOM 数量保持平台,不翻倍。
    root.render(<ChatView {...(baseProps(makeItems(600)) as never)} />);
    await flush();
    await settle();
    await settle();
    await settle();

    const c600 = countItems(host);
    expect(c600).toBeGreaterThan(0);
    expect(c600).toBeLessThan(40);
    // 平台期稳定性:数量不因 items 翻倍而显著变化。
    expect(Math.abs(c600 - c300)).toBeLessThanOrEqual(4);

    root.unmount();
  });

  test("滚动到中部后,窗口外的行被卸载(真虚拟化,而非 content-visibility 的隐藏)", async () => {
    const { host, root } = mount(makeItems(600));
    await flush();
    await settle();
    await settle();
    await settle();

    // 初始贴底:最末行在 DOM,首行不在(已被窗口裁掉)。
    const body = host.querySelector(".chat-body") as HTMLElement;
    expect(body).not.toBeNull();
    expect(host.querySelector('[data-iid="u0"]')).toBeNull();
    expect(host.querySelector('[data-iid="a599"]')).not.toBeNull();

    // 滚到中部区域。注意:未实测的行用先验高度(< ROW_H),此 scrollTop 实际落在 ~440 行附近——
    // 无妨,目的只是把窗口移离底部。真实浏览器里先验随滚动收敛,落点自洽。
    body.scrollTop = ZONE_H + 300 * ROW_H;
    body.dispatchEvent(new window.Event("scroll"));
    await flush();
    await settle();
    await settle();

    // 窗口已移离底部:最末行 a599 被卸载 —— content-visibility 做不到(它保留全部 DOM 节点,
    // 只跳过渲染)。行真的从 DOM 移除,才是真虚拟化的本质区别。
    expect(host.querySelector('[data-iid="a599"]')).toBeNull();
    // 首行仍不在 DOM(窗口在中部区域,远离顶部)。
    expect(host.querySelector('[data-iid="u0"]')).toBeNull();
    // 窗口确实落在中部:至少渲染了一个索引在 [100, 500] 的行。
    const iids = [...host.querySelectorAll<HTMLElement>(".cv-item")].map((el) => el.dataset.iid ?? "");
    const hasMiddle = iids.some((iid) => {
      const m = iid.match(/^[ua](\d+)$/);
      return m ? Number(m[1]) >= 100 && Number(m[1]) <= 500 : false;
    });
    expect(hasMiddle).toBe(true);
    // DOM 数量仍是平台期。
    expect(countItems(host)).toBeLessThan(40);

    root.unmount();
  });
});
