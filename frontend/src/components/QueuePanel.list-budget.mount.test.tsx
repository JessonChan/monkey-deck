// Mount tests for the QueuePanel list scroll cap (#146, parent #27979).
//
// The list reuses the #151 composer budget mechanism (measure the viewport,
// never hardcode): budget = (viewport below .chat-body's top) − (footer content
// minus the list's own box); the list gets ≤40% of it, and the composer's 52px
// floor keeps priority (clampComposerHeight floors the textarea independently —
// extreme tiers fall back to the .chat-footer backstop scroll instead of the
// list fighting the composer).
//
// Real QueuePanel + real Composer mount inside a fake .chat-footer, against a
// fake linear geometry model (same recipe as Composer.autogrow.mount.test.tsx —
// happy-dom has no layout engine):
//   footer.scrollHeight = fixedBase + listOcc + taH   (flow, immune to caps)
//   queue-list.offsetHeight = min(listNatural, its maxHeight cap)  (internal scroll)
//   composer-input.scrollHeight = taScroll / offsetHeight = taH
// The two RO loops (list cap ↔ composer clamp) converge to a fixed point; the
// tests drive FakeResizeObserver deliveries and assert that fixed point:
//   healthy: innerH=800, fixedBase=100, listNatural=400, taScroll=1000
//     → list cap = 0.4 × (700 − 100 − 220) = 152px, composer stays 220px
//   extreme: innerH=140 → list cap 0px, composer holds the 52px floor
//
// Dynamic import of the components happens only after the mocks below are
// installed (module-evaluation boundary, same pattern as the other mount tests).

import { describe, test, expect, mock, afterEach } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";

const window = new Window();
const document = window.document;
globalThis.window = window;
globalThis.document = document;
globalThis.navigator = window.navigator;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.MouseEvent = window.MouseEvent;
globalThis.HTMLInputElement = window.HTMLInputElement;
globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
window.React = React;

// ---- fake geometry model (see file header) ----
let fixedBase = 100;   // footer content besides the queue list + textarea
let listNatural = 400; // list natural height (many items, uncapped)
let taScroll = 1000;   // textarea natural content height
let innerH = 800;
const BODY_TOP = 100;

const listEl = (): HTMLElement | null => document.querySelector('[data-testid="queue-list"]');
const taEl = (): HTMLElement | null => document.querySelector('[data-testid="composer-input"]');

function listOcc(): number {
  const el = listEl();
  if (!el) return 0;
  const cap = Number.parseInt(el.style.maxHeight, 10);
  return Number.isFinite(cap) ? Math.min(listNatural, cap) : listNatural;
}

function curTaH(): number {
  const el = taEl();
  const h = el ? Number.parseInt(el.style.height, 10) : Number.NaN;
  return Number.isFinite(h) ? h : 52;
}

const htmlProto = window.HTMLElement.prototype as unknown as {
  scrollHeight: number; offsetHeight: number;
};
Object.defineProperty(htmlProto, "scrollHeight", {
  configurable: true,
  get(this: HTMLElement) {
    if (this.classList.contains("chat-footer")) return fixedBase + listOcc() + curTaH();
    if (this.dataset?.testid === "queue-list") return listNatural;
    if (this.dataset?.testid === "composer-input") return taScroll;
    return 0;
  },
});
Object.defineProperty(htmlProto, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    if (this.dataset?.testid === "queue-list") return listOcc();
    if (this.dataset?.testid === "composer-input") return curTaH();
    return 0;
  },
});

// The DOM prototype's TS type offers no setter slot for getBoundingClientRect —
// unchecked cast, named once (same as Composer.autogrow.mount.test.tsx).
const elementProto = window.Element.prototype as unknown as {
  getBoundingClientRect: () => DOMRect;
};
elementProto.getBoundingClientRect = function (this: HTMLElement) {
  // .chat-body's top edge defines the growable space; every other rect is zero.
  const top = this.classList?.contains("chat-body") ? BODY_TOP : 0;
  return { top, left: 0, right: 0, bottom: top, width: 0, height: 0, x: 0, y: 0, toJSON() { return this; } } as DOMRect;
};

// ---- binding / i18n / tooltip mocks (nothing touches the backend at mount) ----
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: "3rd-party" },
  default: { useTranslation: () => ({ t: (k: string) => k }) },
}));
mock.module("cmdk", () => {
  const React = globalThis.window.React as typeof import("react");
  const Command = ({ children, ...props }: Record<string, unknown>) => React.createElement("div", props, children);
  Command.List = ({ children, ...props }: Record<string, unknown>) => React.createElement("div", props, children);
  Command.Item = ({ children, onSelect, ...props }: Record<string, unknown> & { onSelect?: (v: string) => void }) =>
    React.createElement("div", { ...props, onClick: () => onSelect?.("") }, children);
  return { Command };
});
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => ({
  PickFiles: mock(async () => []),
  SessionFuzzyFind: mock(async () => []),
  GetSessionMcpServers: mock(async () => []),
}));

// Fake ResizeObserver: captures what the components observe; tests simulate
// delivery by triggering every instance (happy-dom has no rendering frames).
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  cb: () => void;
  observed: Element | null = null;
  constructor(cb: () => void) {
    this.cb = cb;
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) { this.observed = el; }
  disconnect() { this.observed = null; }
  unobserve() {}
  trigger() { this.cb(); }
}
globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

const { default: QueuePanel } = await import("./QueuePanel.tsx");
const { default: Composer } = await import("./Composer.tsx");
import type { QueueItem } from "../types";

const roots: { root: { unmount: () => void } }[] = [];

function mountInFooter(jsx: React.ReactElement): HTMLElement {
  const view = document.createElement("div");
  view.className = "chat-view";
  const header = document.createElement("div");
  header.className = "chat-header";
  const body = document.createElement("div");
  body.className = "chat-body";
  const footer = document.createElement("div");
  footer.className = "chat-footer";
  const host = document.createElement("div");
  footer.appendChild(host);
  view.append(header, body, footer);
  document.body.appendChild(view);
  const root = createRoot(host);
  roots.push({ root });
  root.render(jsx);
  return footer;
}

function mountBare(jsx: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push({ root });
  root.render(jsx);
  return host;
}

async function flush() {
  for (let i = 0; i < 10; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
}

// Drive every RO until the list-cap ↔ composer-clamp loops settle.
async function settle() {
  for (let i = 0; i < 6; i++) {
    for (const ro of FakeResizeObserver.instances) ro.trigger();
    await flush();
  }
}

function items(n: number): QueueItem[] {
  return Array.from({ length: n }, (_, i) => ({ id: `q${i}`, text: `msg ${i}`, scheduledAt: Date.now() }));
}

const COMPOSER_PROPS = {
  value: "hello",
  onChange: () => {},
  disabled: false,
  prompting: false,
  configOptions: [],
  onSetConfig: () => {},
  onRefreshConfig: () => {},
  history: [],
  sessionId: "",
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
  usage: { used: 0, size: 0, cost: 0, cachedReadTokens: 0, cachedWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
  branch: "",
  onSend: () => {},
  onEnqueue: () => {},
  onStop: () => {},
};

afterEach(() => {
  while (roots.length) roots.pop()!.root.unmount();
  document.body.innerHTML = "";
  fixedBase = 100;
  listNatural = 400;
  taScroll = 1000;
  innerH = 800;
  window.innerHeight = innerH;
  FakeResizeObserver.instances = [];
});

describe("QueuePanel list scroll cap (#146)", () => {
  test("healthy viewport: list capped at 40% of budget, composer keeps its 220px cap", async () => {
    window.innerHeight = innerH;
    mountInFooter(
      <>
        <QueuePanel queue={items(30)} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}} />
        <Composer {...COMPOSER_PROPS} />
      </>
    );
    await flush();
    await settle();

    const list = listEl()!;
    expect(list).not.toBeNull();
    // Fixed point: composer saturates at 220 → list = 0.4 × (700 − 100 − 220).
    expect(list.style.maxHeight).toBe("152px");
    // Multiple items: the cap sits below the natural height → internal scroll,
    // header/rows untouched (only the container scrolls).
    expect(listNatural).toBeGreaterThan(152);
    // The composer is NOT squeezed: still at its legacy 220px growth cap.
    expect(taEl()!.style.height).toBe("220px");
  });

  test("extreme viewport: composer 52px floor wins, the list yields to 0", async () => {
    innerH = 140;
    window.innerHeight = innerH;
    mountInFooter(
      <>
        <QueuePanel queue={items(30)} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}} />
        <Composer {...COMPOSER_PROPS} />
      </>
    );
    await flush();
    await settle();

    // Budget collapses below the composer floor: the list cap bottoms out at 0
    // (the .chat-footer backstop keeps everything reachable) while the
    // composer holds its 52px floor — floor priority, per #151.
    expect(listEl()!.style.maxHeight).toBe("0px");
    expect(taEl()!.style.height).toBe("52px");
  });

  test("both loops observe the queue panel and recompute is idempotent", async () => {
    mountInFooter(
      <>
        <QueuePanel queue={items(3)} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}} />
        <Composer {...COMPOSER_PROPS} />
      </>
    );
    await flush();
    // QueuePanel's RO and Composer's RO both target the queue panel (its box
    // always moves, even once the footer's 60vh cap freezes the footer box).
    expect(FakeResizeObserver.instances.length).toBe(2);
    expect(FakeResizeObserver.instances.every((ro) => ro.observed?.classList.contains("queue-panel"))).toBe(true);
    // Idempotent: repeated deliveries settle on the same values.
    await settle();
    const cap = listEl()!.style.maxHeight;
    const ta = taEl()!.style.height;
    for (const ro of FakeResizeObserver.instances) ro.trigger();
    await flush();
    expect(listEl()!.style.maxHeight).toBe(cap);
    expect(taEl()!.style.height).toBe(ta);
  });

  test("no .chat-footer ancestor (bare test mounts) leaves the list uncapped", async () => {
    innerH = 300;
    window.innerHeight = innerH;
    const host = mountBare(
      <QueuePanel queue={items(5)} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}} />
    );
    await flush();
    const list = host.querySelector('[data-testid="queue-list"]') as HTMLElement;
    expect(list).not.toBeNull();
    expect(list.style.maxHeight).toBe("");
    // No footer ancestor → nothing to observe.
    expect(FakeResizeObserver.instances.every((ro) => ro.observed === null)).toBe(true);
  });
});
