// Mount-test Composer autoGrow viewport budget clamp (issue #151 / Task #27975).
//
// The legacy autoGrow capped the textarea at a fixed 220px. At small window heights
// (600px / popout / phones) a tall textarea + QueuePanel pushed the send button below
// the viewport — unreachable. The fix caps growth by a *viewport budget*:
//   height = min(scrollHeight, max(52, min(220, avail − other footer content)))
// where avail = distance from the .chat-body top edge to the viewport bottom (the
// footer is pinned to the viewport bottom by the flex column, so its own rect is
// useless as a space measure — it may grow up to the body's top edge), and "other
// footer content" = footer scrollHeight minus the textarea's current height, measured
// live so QueuePanel / att-chips / compose-bar are all accounted without hardcoding.
//
// This test pins the clamp contract (hard acceptance):
//   - ample budget    -> 220 (legacy cap, identical to old behavior)
//   - small budget    -> the budget itself
//   - extreme budget  -> the 52px floor (footer fallback scrolls instead)
// plus the window-resize re-clamp wiring, the ResizeObserver target selection
// (queue panel — the footer box freezes once the 60vh cap binds), the idempotent
// RO recompute, and the no-footer fallback.
//
// happy-dom has no layout engine: offsetHeight / scrollHeight /
// getBoundingClientRect all read 0. We stub them at the window's HTMLElement /
// Element prototype with a fake geometry model (footer content linear in the
// textarea's current inline height, chat-body rect.top fixed, textarea
// scrollHeight constant), scoped by class/data-testid so everything else stays 0.

import { describe, test, expect, mock, afterEach } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";

// bun's mock.module must run BEFORE the module under test is imported (a static
// import would hoist the real Composer above the mocks), so the module load is
// intentionally dynamic here — same harness as Composer.mount.test.tsx.
const window = new Window();
const document = window.document;
globalThis.window = window;
globalThis.document = document;
globalThis.navigator = window.navigator;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.MouseEvent = window.MouseEvent;
window.React = React;

// ---- mock heavy deps (same thin pass-throughs as Composer.mount.test.tsx) ----
mock.module("@radix-ui/react-popover", () => {
  const Ctx = React.createContext({ open: false, setOpen: () => {} });
  const Root = ({ children }) => React.createElement(Ctx.Provider, { value: { open: false, setOpen: () => {} } }, children);
  const Trigger = ({ children, ...props }) => React.createElement("button", props, children);
  const Portal = ({ children }) => React.createElement(React.Fragment, null, children);
  const Content = () => null;
  return { default: { Root, Trigger, Portal, Content }, Root, Trigger, Portal, Content };
});
mock.module("cmdk", () => {
  const Command = React.forwardRef(({ children, ...props }, ref) =>
    React.createElement("div", { ref, ...props }, children));
  Command.Input = (props) => React.createElement("input", props);
  Command.List = ({ children, ...props }) => React.createElement("div", props, children);
  Command.Item = ({ children, onSelect, ...props }) =>
    React.createElement("div", { ...props, onClick: onSelect }, children);
  return { Command };
});
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k) => k }),
  initReactI18next: { type: "3rd-party" },
  default: { useTranslation: () => ({ t: (k) => k }) },
}));
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => ({
  PickFiles: mock(async () => []),
  SessionFuzzyFind: mock(async () => []),
  GetSessionMcpServers: mock(async () => []),
}));

const { default: Composer, clampComposerHeight } = await import("./Composer.tsx");

// ---- fake geometry model ----
// footer.scrollHeight = footerBase + current textarea inline height (linear, as in
// real flow — and immune to the max-height cap, which is why the component reads
// scrollHeight); .chat-body rect.top fixed at BODY_TOP (defines the growable space);
// textarea scrollHeight = taScroll.
let footerBase = 100;   // footer content besides the textarea
let taScroll = 1000;    // textarea natural content height
let activeTa: HTMLTextAreaElement | null = null;
const BODY_TOP = 100;
let innerH = 600;

const curTaH = (): number => parseInt(activeTa?.style.height ?? "", 10) || 52;

function installGeometry() {
  const HTMLElementCtor = window.HTMLElement;
  const ElementCtor = window.Element;
  Object.defineProperty(HTMLElementCtor.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains("chat-footer")) return footerBase + curTaH();
      if (this.dataset?.testid === "composer-input") return taScroll;
      return 0;
    },
  });
  Object.defineProperty(HTMLElementCtor.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.dataset?.testid === "composer-input") return curTaH();
      return 0;
    },
  });
  Object.defineProperty(ElementCtor.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      // .chat-body top edge defines the space the footer may grow into; the
      // footer's own rect is irrelevant to the budget.
      const top = this.classList?.contains("chat-body") ? BODY_TOP : 0;
      return { top, left: 0, right: 0, bottom: top, width: 0, height: 0, x: 0, y: 0, toJSON() { return this; } };
    },
  });
}
installGeometry();

// ---- mount helpers ----
const roots: { root: { unmount: () => void } }[] = [];

// Fake ResizeObserver: captures what the component observes so tests can simulate
// delivery (happy-dom has no rendering frames, so a real RO would never fire —
// same starvation as a hidden/headless document).
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

function mountInFooter(jsx) {
  const view = document.createElement("div");
  view.className = "chat-view";
  const header = document.createElement("div");
  header.className = "chat-header";
  const body = document.createElement("div");
  body.className = "chat-body";
  const footer = document.createElement("div");
  footer.className = "chat-footer";
  // QueuePanel sibling (static stand-in): the RO must observe THIS (not the
  // footer) so re-clamping still fires once the 60vh cap pins the footer box.
  const panel = document.createElement("div");
  panel.className = "queue-panel";
  footer.appendChild(panel);
  const host = document.createElement("div");
  footer.appendChild(host);
  view.append(header, body, footer);
  document.body.appendChild(view);
  const root = createRoot(host);
  roots.push({ root });
  root.render(jsx);
  return footer;
}
function mountBare(jsx) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push({ root });
  root.render(jsx);
  return host;
}
async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
}
afterEach(() => {
  while (roots.length) roots.pop()!.root.unmount();
  document.body.innerHTML = "";
  activeTa = null;
  footerBase = 100;
  taScroll = 1000;
  innerH = 600;
  window.innerHeight = innerH;
  FakeResizeObserver.instances = [];
});

const STUB_PROPS = {
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

async function mountedHeight(innerHeight: number): Promise<HTMLTextAreaElement> {
  innerH = innerHeight;
  window.innerHeight = innerHeight;
  const footer = mountInFooter(<Composer value={"hello"} {...STUB_PROPS} />);
  await flush();
  const ta = footer.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
  expect(ta).not.toBeNull();
  activeTa = ta;
  return ta;
}

// ---- pure clamp contract (the three hard-acceptance tiers) ----
describe("clampComposerHeight budget tiers (#151)", () => {
  test("ample budget -> legacy 220 cap", () => {
    expect(clampComposerHeight(1000, 5000)).toBe(220);
    expect(clampComposerHeight(1000, 220)).toBe(220);
  });
  test("small budget -> the budget itself", () => {
    expect(clampComposerHeight(1000, 150)).toBe(150);
    expect(clampComposerHeight(1000, 53)).toBe(53);
  });
  test("extreme budget -> 52px floor", () => {
    expect(clampComposerHeight(1000, 52)).toBe(52);
    expect(clampComposerHeight(1000, 0)).toBe(52);
    expect(clampComposerHeight(1000, -80)).toBe(52);
  });
  test("short content below cap -> natural scrollHeight", () => {
    expect(clampComposerHeight(80, 5000)).toBe(80);
    expect(clampComposerHeight(80, 100)).toBe(80);
  });
});

// ---- mounted autoGrow wiring against the fake geometry ----
describe("Composer autoGrow viewport budget (#151)", () => {
  test("600px window: ample budget -> capped at 220 like before", async () => {
    // avail = 600 - 100 = 500; other = 100 -> budget 400 -> cap 220
    const ta = await mountedHeight(600);
    expect(ta.style.height).toBe("220px");
  });

  test("small window: budget wins over the 220 cap", async () => {
    // avail = 300 - 100 = 200; other = 100 -> budget 100
    const ta = await mountedHeight(300);
    expect(ta.style.height).toBe("100px");
  });

  test("extreme window: budget collapses to the 52px floor", async () => {
    // avail = 150 - 100 = 50; other = 100 -> budget -50 -> floor 52
    const ta = await mountedHeight(150);
    expect(ta.style.height).toBe("52px");
  });

  test("window resize re-clamps without a value change", async () => {
    const ta = await mountedHeight(600);
    expect(ta.style.height).toBe("220px");
    innerH = 300;
    window.innerHeight = 300;
    window.dispatchEvent(new window.Event("resize"));
    await flush();
    expect(ta.style.height).toBe("100px");
  });

  test("short content stays at its natural height under an ample budget", async () => {
    taScroll = 80;
    const ta = await mountedHeight(600);
    expect(ta.style.height).toBe("80px");
  });

  test("RO observes the queue panel (footer box freezes under the 60vh cap)", async () => {
    await mountedHeight(600);
    expect(FakeResizeObserver.instances.length).toBe(1);
    const ro = FakeResizeObserver.instances[0];
    expect(ro.observed?.classList.contains("queue-panel")).toBe(true);
  });

  test("queue growth re-clamps via RO delivery and is idempotent", async () => {
    const ta = await mountedHeight(600);
    expect(ta.style.height).toBe("220px");
    const ro = FakeResizeObserver.instances[0];
    // queue items arrive: base 100 -> 450 -> budget 500 - 450 = 50 -> floor 52
    footerBase = 450;
    ro.trigger();
    expect(ta.style.height).toBe("52px");
    // recompute is idempotent: repeated deliveries (our own write perturbs the
    // footer too) settle instead of looping
    ro.trigger();
    ro.trigger();
    expect(ta.style.height).toBe("52px");
  });

  test("no .chat-footer ancestor falls back to the legacy 220 cap", async () => {
    innerH = 300;
    window.innerHeight = 300;
    const host = mountBare(<Composer value={"hello"} {...STUB_PROPS} />);
    await flush();
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    expect(ta).not.toBeNull();
    activeTa = ta;
    // budget fallback = 220 -> min(1000, 220) regardless of the small window
    expect(ta.style.height).toBe("220px");
    // no footer ancestor -> nothing to observe
    expect(FakeResizeObserver.instances.every((r) => r.observed === null)).toBe(true);
  });
});
