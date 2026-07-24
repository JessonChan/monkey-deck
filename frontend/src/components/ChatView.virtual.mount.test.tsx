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
let manualRaf = false;
const rafQueue: FrameRequestCallback[] = [];
globalThis.requestAnimationFrame = (cb) => {
  if (manualRaf) { rafQueue.push(cb); return rafQueue.length; }
  return setTimeout(() => cb(performance.now()), 0);
};
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.MouseEvent = window.MouseEvent;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.localStorage = window.localStorage;
window.React = React;

// ---- 几何 mock:offsetHeight / clientHeight 由测试单方面设定 ----
// chat-body 视口 600px;头/尾区各 22px(等价原 .chat-body 上下内边距);每行 100px。
// 可变:测试可修改 mockRowH / mockHeadH / mockTailH 模拟高度收敛/增长。
const VIEWPORT = 600;
let mockRowH = 100;
let mockHeadH = 22;
let mockTailH = 22;
// 逐行高度覆盖:非空时按 data-iid 返回各自高度,模拟「元素类型多样」的真实会话
//(user/agent/thought/tool/plan 高度悬殊,先验偏差大)。空 Map → 退回统一 mockRowH(旧测试不受影响)。
const rowHeights = new Map<string, number>();
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    const iid = this.dataset?.iid;
    if (iid === "__head__") return mockHeadH;
    if (iid === "__tail__") return mockTailH;
    if (this.classList?.contains("cv-item")) return rowHeights.get(iid ?? "") ?? mockRowH;
    return 0;
  },
});
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList?.contains("chat-body") ? VIEWPORT : 0;
  },
});

// ---- 浏览器真实行为 mock:scrollTop clamp + scrollHeight ----
// happy-dom 的 scrollTop 不做 clamp(写多少存多少),但真实浏览器把 scrollTop 钳制在
// [0, scrollHeight - clientHeight]。这个 clamp 是复现「收敛期 stick 误翻」bug 的关键:
// RO re-pin 写入超前 total 对应的 scrollTop → 被 clamp 到旧 scrollHeight → onScroll 判定离底。
const scrollTopStore = new WeakMap<Element, number>();
Object.defineProperty(window.HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get(this: HTMLElement) {
    if (this.classList?.contains("chat-body")) {
      const content = this.querySelector(".chat-content") as HTMLElement | null;
      return content ? parseInt(content.style.height, 10) || 0 : 0;
    }
    return 0;
  },
});
Object.defineProperty(window.HTMLElement.prototype, "scrollTop", {
  configurable: true,
  get(this: HTMLElement) {
    return scrollTopStore.get(this) ?? 0;
  },
  set(this: HTMLElement, v: number) {
    const max = Math.max(0, this.scrollHeight - this.clientHeight);
    const clamped = Math.max(0, Math.min(v, max));
    const old = scrollTopStore.get(this) ?? 0;
    scrollTopStore.set(this, clamped);
    // 浏览器真实行为:scrollTop 变化时同步派发 scroll 事件(WebKit 语义)。
    if (clamped !== old && this.classList?.contains("chat-body")) {
      this.dispatchEvent(new window.Event("scroll"));
    }
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

// 「元素类型多样」的真实会话:user/agent/thought/tool(组)/plan 轮番出现,
// 真实高度与先验(PRIOR_HEIGHT:user45/agent90/thought48/tool56/plan120)偏差悬殊——
// 这正是用户实测「落点与元素种类相关」的维度,统一 mockRowH 的旧测试覆盖不到。
// 返回 items + 每行真实高度(按 data-iid 键,tool 组用首条 id)。
function makeDiverseItems(n: number): { items: ChatItem[]; heights: Record<string, number> } {
  const items: ChatItem[] = [];
  const heights: Record<string, number> = {};
  // 一个「回合」= user → thought → tool×3(折叠成组)→ agent → plan,5 种元素类型全覆盖。
  // 真实高度刻意偏离先验:user120(先验45)、agent300(90)、thought30(48)、tool组40(56)、plan250(120)。
  const turn = (base: number) => {
    items.push({ type: "user", id: `u${base}`, text: `user ${base}`, ts: 1000 + base });
    heights[`u${base}`] = 120;
    items.push({ type: "thought", id: `h${base + 1}`, text: `thought ${base + 1}`, ts: 1000 + base + 1 });
    heights[`h${base + 1}`] = 30;
    for (let k = 0; k < 3; k++) {
      items.push({ type: "tool", id: `t${base + 2 + k}`, kind: "bash", title: `tool ${base + 2 + k}`, status: "completed", ts: 1000 + base + 2 + k } as never);
    }
    heights[`t${base + 2}`] = 40; // 组行键 = 首条 tool 的 id(buildRows 折叠规则)
    items.push({ type: "agent", id: `a${base + 5}`, text: `agent ${base + 5}`, ts: 1000 + base + 5 });
    heights[`a${base + 5}`] = 300;
    items.push({ type: "plan", id: `p${base + 6}`, entries: [{ content: "step", status: "completed" }], ts: 1000 + base + 6 } as never);
    heights[`p${base + 6}`] = 250;
  };
  let i = 0;
  while (i + 7 <= n) { turn(i); i += 7; }
  return { items, heights };
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
    body.scrollTop = mockHeadH + 300 * mockRowH;
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

  test("收敛期 stick 不误翻:RO 推进 layoutRef 超前已提交 DOM 高度,贴底判定读 el.scrollHeight", async () => {
    const { host, root } = mount(makeItems(20));
    await flush();
    await settle();
    await settle();

    const body = host.querySelector(".chat-body") as HTMLElement;
    // 初始贴底:最末行在 DOM,scrollTop 在底部。
    expect(host.querySelector('[data-iid="a19"]')).not.toBeNull();
    expect(body.scrollTop).toBe(body.scrollHeight - VIEWPORT);

    // 复现竞态:pending rAF(来自 scroll 事件)在 RO 推进 layoutRef 之后、React 提交新高度之前执行。
    // 真实浏览器里 WebKit 的 scroll 事件同步派发,rAF 在下一帧渲染前执行——
    // 若 RO 回调在同一帧推进了 layoutRef,rAF 读到的 layoutRef.total 超前于 el.scrollHeight。
    manualRaf = true;
    try {
      // 1) 派发 scroll 事件 → onScroll 把 rAF 入队(手动模式,不自动执行)。
      body.dispatchEvent(new window.Event("scroll"));
      // 2) RO 测量:行高 100 → 200,layoutRef 推进到新 total(远超旧 scrollHeight)。
      //    re-pin 写 scrollTop 被 clamp 到旧 scrollHeight(React 尚未提交新 .chat-content 高度)。
      mockRowH = 200;
      const ro = MockResizeObserver.instances[MockResizeObserver.instances.length - 1];
      ro.trigger();
      // 3) 执行 pending rAF:此刻 el.scrollHeight = 旧已提交高度,layoutRef.total = 新超前值。
      //    旧代码 isAtBottom(layoutRef.total, …) → gap = 新total - 旧scrollHeight ≫ 80 → stick 误翻 false。
      //    新代码 isAtBottom(el.scrollHeight, …) → gap = 0 → stick 保持 true。
      const cbs = [...rafQueue];
      rafQueue.length = 0;
      for (const cb of cbs) cb(performance.now());
    } finally {
      manualRaf = false;
    }

    // React 提交新高度 + useLayoutEffect:stick=true → 贴底重定位;stick=false → 停在偏上位置(bug)。
    await flush();
    await settle();

    // 贴底未被误翻:scrollTop 在真底部,FAB 隐藏,最末行在 DOM。
    expect(body.scrollTop).toBe(body.scrollHeight - VIEWPORT);
    expect(host.querySelector(".scroll-bottom-btn")).toBeNull();
    expect(host.querySelector('[data-iid="a19"]')).not.toBeNull();

    mockRowH = 100;
    root.unmount();
  });

  test("切 session(异步加载 items):定位贴底,FAB 不出现", async () => {
    // A 已贴底 → 切到 B(items 异步到达,模拟 LoadMessagesPage)。
    const { host, root } = mount(makeItems(300));
    await flush();
    await settle();
    await settle();
    await settle();
    const body = host.querySelector(".chat-body") as HTMLElement;
    expect(body.scrollTop).toBe(body.scrollHeight - VIEWPORT);

    // 切到 B:items 尚未到达(空)。
    const bEmpty = { ...baseProps([]), session: { id: "s2" }, sessionId: "s2" };
    root.render(<ChatView {...(bEmpty as never)} />);
    await flush();

    // B 的 items 到达(DB 重载完成)。
    const bItems = { ...baseProps(makeItems(40)), session: { id: "s2" }, sessionId: "s2" };
    root.render(<ChatView {...(bItems as never)} />);
    await flush();
    await settle();
    await settle();
    await settle();

    const body2 = host.querySelector(".chat-body") as HTMLElement;
    // 贴底:scrollTop 在真底部,FAB 隐藏,最末行在 DOM。
    expect(body2.scrollTop).toBe(body2.scrollHeight - VIEWPORT);
    expect(host.querySelector(".scroll-bottom-btn")).toBeNull();
    expect(host.querySelector('[data-iid="a39"]')).not.toBeNull();

    root.unmount();
  });

  test("切 session(items 已缓存,同帧到达):定位贴底,FAB 不出现", async () => {
    const { host, root } = mount(makeItems(300));
    await flush();
    await settle();
    await settle();
    await settle();

    // 切到 B,items 同帧到达(缓存命中)。
    const bItems = { ...baseProps(makeItems(40)), session: { id: "s2" }, sessionId: "s2" };
    root.render(<ChatView {...(bItems as never)} />);
    await flush();
    await settle();
    await settle();
    await settle();

    const body2 = host.querySelector(".chat-body") as HTMLElement;
    expect(body2.scrollTop).toBe(body2.scrollHeight - VIEWPORT);
    expect(host.querySelector(".scroll-bottom-btn")).toBeNull();
    expect(host.querySelector('[data-iid="a39"]')).not.toBeNull();

    root.unmount();
  });

  test("全新会话(内容不足一屏):FAB 不出现,scrollTop 为 0", async () => {
    const { host, root } = mount(makeItems(300));
    await flush();
    await settle();
    await settle();
    await settle();

    // 切到全新会话 D:先空,再到 1 条 user 消息(内容远不足一屏)。
    const dEmpty = { ...baseProps([]), session: { id: "s3" }, sessionId: "s3" };
    root.render(<ChatView {...(dEmpty as never)} />);
    await flush();

    const dOne = {
      ...baseProps([{ type: "user", id: "u0", text: "hello", ts: 1000 }]),
      session: { id: "s3" },
      sessionId: "s3",
    };
    root.render(<ChatView {...(dOne as never)} />);
    await flush();
    await settle();
    await settle();

    const body2 = host.querySelector(".chat-body") as HTMLElement;
    // 内容不足一屏:scrollTop 必为 0,FAB 绝不出现。
    expect(body2.scrollTop).toBe(0);
    expect(host.querySelector(".scroll-bottom-btn")).toBeNull();

    root.unmount();
  });

  test("从「已上翻」的 A 切到全新空会话 D:FAB 不残留,定位贴底", async () => {
    // A 有 300 条,用户上翻到中部 → stick=false,FAB 可见。
    const { host, root } = mount(makeItems(300));
    await flush();
    await settle();
    await settle();
    await settle();
    const body = host.querySelector(".chat-body") as HTMLElement;
    body.scrollTop = mockHeadH + 100 * mockRowH; // 滚到中部(远离底部)
    body.dispatchEvent(new window.Event("scroll"));
    await flush();
    await settle();
    // 前置断言:确实处于「上翻」态——FAB 可见。
    expect(host.querySelector(".scroll-bottom-btn")).not.toBeNull();

    // 切到全新会话 D:items 尚未到达(空)。此时 D 还没任何内容,
    // 绝不能残留 A 的「上翻」态(FAB 应消失,stick 应复位为贴底)。
    const dEmpty = { ...baseProps([]), session: { id: "s4" }, sessionId: "s4" };
    root.render(<ChatView {...(dEmpty as never)} />);
    await flush();

    // 关键断言:空会话 D 上 FAB 不残留(bug:残留 A 的 showScrollBtn=true)。
    expect(host.querySelector(".scroll-bottom-btn")).toBeNull();

    // D 的第一条消息到达:应贴底,FAB 仍不出现。
    const dOne = {
      ...baseProps([{ type: "user", id: "u0", text: "hello", ts: 1000 }]),
      session: { id: "s4" },
      sessionId: "s4",
    };
    root.render(<ChatView {...(dOne as never)} />);
    await flush();
    await settle();
    await settle();
    const body2 = host.querySelector(".chat-body") as HTMLElement;
    expect(body2.scrollTop).toBe(0);
    expect(host.querySelector(".scroll-bottom-btn")).toBeNull();

    root.unmount();
  });

  test("多样元素类型会话:贴底收敛到真底部,FAB 不出现", async () => {
    // 用户实测:落点偏上「与页面元素种类多少相关」。统一 mockRowH 的旧测试覆盖不到——
    // 这里用真实高度严重偏离先验的多样会话(user120/agent300/thought30/tool组40/plan250),
    // 验证 S 不变量在收敛后仍把视图钉在真底部,而非停在先验估算的偏上位置。
    rowHeights.clear();
    const { items, heights } = makeDiverseItems(210); // 30 回合,末行 = plan p209
    for (const [k, v] of Object.entries(heights)) rowHeights.set(k, v);
    const { host, root } = mount(items);
    await flush();
    await settle();
    await settle();
    await settle();
    await settle();

    const body = host.querySelector(".chat-body") as HTMLElement;
    // 收敛后必在真底部:scrollTop = scrollHeight - viewport,FAB 绝不出现,末行在 DOM。
    expect(body.scrollTop).toBe(body.scrollHeight - VIEWPORT);
    expect(host.querySelector(".scroll-bottom-btn")).toBeNull();
    expect(host.querySelector('[data-iid="p209"]')).not.toBeNull();

    rowHeights.clear();
    root.unmount();
  });

  test("多样元素类型会话:上翻后锚点稳定,测量收敛不漂移视觉位置", async () => {
    // A 不变量:上翻到中部后,锚点行(视口顶部命中行)的视觉位置在后续测量收敛中保持不动。
    // 多样高度下先验偏差大(user 先验45/真实120、agent 先验90/真实300),
    // 若 Δh 补偿漏算锚点上方行,视觉位置会随每次测量跳动。
    rowHeights.clear();
    const { items, heights } = makeDiverseItems(210);
    for (const [k, v] of Object.entries(heights)) rowHeights.set(k, v);
    const { host, root } = mount(items);
    await flush(); // 渲染完成,但尚未触发 RO 测量 → 高度仍是先验

    const body = host.querySelector(".chat-body") as HTMLElement;
    // 上翻到靠近先验坐标系底部(8000px 处),设置锚点。
    // 选 8000 而非 4000:锚点上方行从先验→真实高度时 delta 很大,
    // 8000 + delta > 旧 scrollHeight(~10852)→ RO 的 el.scrollTop += delta 被 clamp。
    body.scrollTop = 8000;
    body.dispatchEvent(new window.Event("scroll"));
    await flush();

    // 找到视口顶部命中的行(锚点行):style.top <= scrollTop < 下一行的 style.top。
    // 注意:不是 DOM 中的第一个 .cv-item(那是 overscan 区域的起始行,可能在视口上方)。
    const allItems = [...host.querySelectorAll<HTMLElement>(".cv-item")].sort((a, b) =>
      parseFloat(a.style.top || "0") - parseFloat(b.style.top || "0")
    );
    const anchorEl = allItems.find((el, i) => {
      const top = parseFloat(el.style.top || "0");
      const nextTop = i + 1 < allItems.length ? parseFloat(allItems[i + 1].style.top || "0") : Infinity;
      return top <= body.scrollTop && body.scrollTop < nextTop;
    }) ?? null;
    expect(anchorEl).not.toBeNull();
    const anchorIid = anchorEl!.dataset.iid ?? "";
    const relBefore = parseFloat(anchorEl!.style.top || "0") - body.scrollTop;

    // 触发测量收敛:先验 → 真实高度,锚点上方行变高 → Δh 补偿应下推 scrollTop 保持视觉位置。
    await settle();
    await settle();

    const anchorAfter = host.querySelector(`[data-iid="${anchorIid}"]`) as HTMLElement | null;
    expect(anchorAfter).not.toBeNull();
    const relAfter = parseFloat(anchorAfter!.style.top || "0") - body.scrollTop;
    // 锚点行视觉位置不漂移(允许 1px 舍入)。
    expect(Math.abs(relAfter - relBefore)).toBeLessThanOrEqual(1);

    rowHeights.clear();
    root.unmount();
  });

  test("动态类型先验:content 高度远比固定先验接近真实(虚拟化窗口外行的核心)", async () => {
    // 根因验证:虚拟化下窗口外行永远不在 DOM,无法实测,只能用先验估算 total。
    // 固定先验(P50 定标)对单 session 的真实高度分布严重偏小:
    //   agent 先验 90 vs 真实 300 → 170 行未测量时 total 偏差 ~50% → scrollTop 到不了真底部。
    // 动态类型先验:窗口内同类型实测行提供均值,未测量行用均值估算 → total 偏差 <5%。
    rowHeights.clear();
    const { items, heights } = makeDiverseItems(210); // 30 回合,窗口只渲染底部 ~30 行
    for (const [k, v] of Object.entries(heights)) rowHeights.set(k, v);
    const { host, root } = mount(items);
    await flush();
    await settle(); // 一轮测量:窗口内 ~30 行实测 → typeStats 累积样本
    await settle();

    const content = host.querySelector(".chat-content") as HTMLElement;
    const estimatedTotal = parseInt(content.style.height, 10);

    // 真实 total(所有行用真实高度):1 回合 = 120+30+40+300+250 = 740,×30 + head22 + tail22 ≈ 22244
    let trueTotal = 22 + 22; // head + tail
    for (const v of Object.values(heights)) trueTotal += v;

    const errPct = Math.abs(estimatedTotal - trueTotal) / trueTotal * 100;
    // 动态先验收敛后:误差 <5%(固定先验会 ~50%,根本到不了底部)。
    expect(errPct).toBeLessThan(5);

    rowHeights.clear();
    root.unmount();
  });
});
