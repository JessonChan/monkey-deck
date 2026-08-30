// Mount-test the ModelSelect narrow-state dot collapse (#151 phase 2, task #28428).
//
// The compose-bar ResizeObserver toggles data-cfg-collapsed on the bar when the
// model/mode/effort chips no longer fit; CSS swaps the text chips for fixed 14px
// letter dots (M/E/T). This file pins the behavioral contract:
//   1. narrow delivery  -> attribute set, M/E/T micro-badges rendered
//   2. the post-collapse re-delivery (children resized at the same bar width) must
//      CONFIRM the collapsed state — a naive current-width exit check would read
//      "dots fit" and flip straight back (the feedback loop this test kills)
//   3. widen -> attribute exits; identical repeated deliveries never flip (no jitter)
//   4. stale remembered width self-heals (model renamed longer while collapsed)
//   5. dot click still opens the popover and selects through the real callback chain
//   6. hidden bar (avail 0) decides nothing; threshold boundaries are exact
// Threshold math lives in the exported pure functions (cfgShouldCollapse /
// cfgShouldExpand) — asserted directly for the boundary cases.
//
// happy-dom has no layout: ResizeObserver is replaced with a controllable fake whose
// deliver() supplies the contentRect widths a real engine would report, and the
// composeBarGap computed-style read falls back to the CSS constant (columnGap "" in
// happy-dom), so the whole pipeline is deterministic without stylesheets.

import { describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";
import type { ConfigOption, Usage } from "../types";

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
window.React = React;

// ---- controllable ResizeObserver fake: tests deliver contentRect widths ----
type ROEntry = { target: Element; contentRect: { width: number; height: number } };
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  cb: (entries: ROEntry[]) => void;
  observed = new Set<Element>();
  constructor(cb: (entries: ROEntry[]) => void) {
    this.cb = cb;
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) { this.observed.add(el); }
  unobserve(el: Element) { this.observed.delete(el); }
  disconnect() { this.observed.clear(); }
  deliver(widths: Map<Element, number>) {
    const entries = [...this.observed].map((el) => ({
      target: el,
      contentRect: { width: widths.get(el) ?? 0, height: 100 },
    }));
    this.cb(entries);
  }
}
globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

// ---- mock @radix-ui/react-popover / cmdk / react-i18next (see ModelSelect.mount.test) ----
mock.module("@radix-ui/react-popover", () => {
  const Ctx = React.createContext({ open: false, setOpen: () => {} });
  const Root = ({ children, open: controlled, defaultOpen, onOpenChange }) => {
    const [internal, setInternal] = React.useState(defaultOpen ?? false);
    const open = controlled !== undefined ? controlled : internal;
    const setOpen = (v) => {
      if (controlled === undefined) setInternal(v);
      if (onOpenChange) onOpenChange(v);
    };
    return React.createElement(Ctx.Provider, { value: { open, setOpen } }, children);
  };
  const Trigger = ({ children, asChild, ...props }) => {
    const { setOpen } = React.useContext(Ctx);
    const handler = (e) => { if (e && e.preventDefault) e.preventDefault(); setOpen(true); };
    if (asChild && React.isValidElement(children)) {
      return React.cloneElement(children, { onClick: handler });
    }
    return React.createElement("button", { onClick: handler, ...props }, children);
  };
  const Portal = ({ children }) => React.createElement(React.Fragment, null, children);
  const Content = ({ children, ...props }) => {
    const { open } = React.useContext(Ctx);
    if (!open) return null;
    return React.createElement("div", { ...props }, children);
  };
  const Anchor = ({ children }) => children ?? null;
  const Arrow = () => null;
  const Close = ({ children }) => children ?? null;
  return {
    default: { Root, Trigger, Portal, Content, Anchor, Arrow, Close },
    Root, Trigger, Portal, Content, Anchor, Arrow, Close,
  };
});
mock.module("cmdk", () => {
  const Command = React.forwardRef(({ children, ...props }, ref) =>
    React.createElement("div", { ref, ...props }, children));
  Command.Input = (props) => React.createElement("input", props);
  Command.List = ({ children, ...props }) => React.createElement("div", props, children);
  Command.Empty = () => null;
  Command.Group = ({ children, ...props }) => React.createElement("div", props, children);
  Command.Item = ({ children, onSelect, ...props }) =>
    React.createElement("div", { ...props, onClick: onSelect }, children);
  Command.Loading = () => null;
  Command.Separator = () => null;
  return { Command };
});
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k) => k }),
  initReactI18next: { type: "3rd-party" },
  default: { useTranslation: () => ({ t: (k) => k }) },
}));
const chatServiceMock = {
  PickFiles: mock(async () => []),
  SessionFuzzyFind: mock(async () => []),
  GetSessionMcpServers: mock(async () => []),
};
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => chatServiceMock);

// Dynamic import (not static): bun's mock.module must be registered BEFORE the module
// under test loads, and static imports hoist above the mock calls — same pattern as
// ModelSelect.mount.test.tsx / Composer.mount.test.tsx.
const ComposerModule = await import("./Composer.tsx");
const Composer = ComposerModule.default;
const { cfgShouldCollapse, cfgShouldExpand } = ComposerModule;

function mount(jsx) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(jsx);
  return { host, root };
}

const delay = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

async function flush() {
  for (let i = 0; i < 10; i++) await delay(5);
}

// Same shape as ModelSelect.mount.test: ids intentionally ≠ the legacy hardcoded strings.
const CFG_OPTS: ConfigOption[] = [
  {
    id: "model_id_custom",
    name: "Model",
    category: "model",
    currentValue: "zai/glm-4.6",
    options: [
      { value: "zai/glm-4.6", name: "GLM-4.6" },
      { value: "ant/claude", name: "Claude" },
    ],
  },
  {
    id: "build_mode",
    name: "Mode",
    category: "mode",
    currentValue: "build",
    options: [
      { value: "build", name: "Build" },
      { value: "plan", name: "Plan" },
    ],
  },
  {
    id: "thinking_budget",
    name: "Thought",
    category: "thought_level",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
];

const ZERO_USAGE: Usage = {
  used: 0, size: 0, cost: 0,
  cachedReadTokens: 0, cachedWriteTokens: 0,
  inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0,
};

const BASE_PROPS = {
  onChange: () => {},
  disabled: false,
  prompting: false,
  configOptions: CFG_OPTS,
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
  usage: ZERO_USAGE,
  branch: "",
  onSend: () => {},
  onEnqueue: () => {},
  onStop: () => {},
};

// Fixture widths (gap falls back to the 8px CSS constant in happy-dom):
//   tools=100, cfg natural=120, rest=80 -> right expanded=200
//   expanded need = 100 + 8 + 200 = 308 -> avail 308 fits exactly, 307 collapses
//   dot row = 3×14 + 2×5 = 52          -> right collapsed=132
//   collapsed need = 100 + 8 + 80 + 120 = 308 (same canonical threshold)
const W = {
  tools: 100, cfgFull: 120, rest: 80, rightFull: 200,
  cfgDot: 52, rightDot: 132,
  fit: 308, tight: 307, narrow: 240, wide: 400,
};
const barOf = (host: HTMLElement) => host.querySelector(".compose-bar") as HTMLElement;

/** Deliver widths for every observed element; 2nd pass picks up lazily-observed cfg-group. */
function deliverAll(roFake: FakeResizeObserver, widthOf: (el: Element) => number) {
  for (let pass = 0; pass < 2; pass++) {
    const map = new Map<Element, number>();
    for (const el of roFake.observed) map.set(el, widthOf(el));
    roFake.deliver(map);
  }
}

/** Width supplier for a given form + viewport width (+ optional current cfg width). */
function widthsFor(form: "full" | "dot", avail: number, cfgW: number) {
  return (el: Element): number => {
    const cls = el.className ?? "";
    if (cls.includes("compose-tools")) return W.tools;
    if (cls.includes("compose-right")) return form === "full" ? W.rest + cfgW : W.rightDot;
    if (cls.includes("cfg-group")) return cfgW;
    return avail; // the compose-bar itself
  };
}
const full = (avail: number, cfgW = W.cfgFull) => widthsFor("full", avail, cfgW);
const dot = (avail: number) => widthsFor("dot", avail, W.cfgDot);

async function mountWide() {
  const { host } = mount(<Composer value="" {...BASE_PROPS} />);
  await flush();
  const roFake = FakeResizeObserver.instances[FakeResizeObserver.instances.length - 1];
  deliverAll(roFake, full(W.wide)); // prime: wide -> expanded form
  return { host, roFake };
}

describe("cfg dot collapse thresholds (pure, #151 phase 2)", () => {
  test("entry fires strictly past the fit boundary; exact fit stays expanded", () => {
    expect(cfgShouldCollapse(W.tools, W.rightFull, W.fit, 8)).toBe(false);
    expect(cfgShouldCollapse(W.tools, W.rightFull, W.tight, 8)).toBe(true);
  });
  test("exit compares the REMEMBERED full width, not the current dot-row width", () => {
    // A naive current-width check at avail 240 would read 100+8+132=240 "fits" and exit —
    // that is the flip-flop bug. The remembered-width check correctly refuses.
    expect(cfgShouldExpand(W.tools, W.rest, W.cfgFull, W.fit, 8)).toBe(true);
    expect(cfgShouldExpand(W.tools, W.rest, W.cfgFull, W.tight, 8)).toBe(false);
    expect(cfgShouldExpand(W.tools, W.rightDot - W.cfgDot, W.cfgFull, W.narrow, 8)).toBe(false);
  });
});

describe("compose-bar RO dot collapse (#151 phase 2)", () => {
  test("narrow delivery sets data-cfg-collapsed and renders M/E/T micro-badges", async () => {
    const { host, roFake } = await mountWide();
    deliverAll(roFake, full(W.tight));
    expect(barOf(host).hasAttribute("data-cfg-collapsed")).toBe(true);
    const letters = [...host.querySelectorAll<HTMLElement>(".cfg-dot-letter")].map((el) => el.textContent);
    expect(letters).toEqual(["M", "E", "T"]);
    // Native title tooltip survives (spec: label: value); testids unchanged.
    const thought = host.querySelector('[data-testid="cfg-trigger-composer.cfgLabel.thought"]') as HTMLElement;
    expect(thought.getAttribute("title")).toBe("composer.cfgLabel.thought: Medium");
  });

  test("post-collapse re-delivery at the same bar width confirms collapse (no flip)", async () => {
    const { host, roFake } = await mountWide();
    deliverAll(roFake, full(W.narrow));
    expect(barOf(host).hasAttribute("data-cfg-collapsed")).toBe(true);
    // The collapse shrinks cfg-group/right; the engine re-delivers their new sizes at
    // the SAME avail. The remembered-width exit check must refuse (dots fit, full won't).
    deliverAll(roFake, dot(W.narrow));
    expect(barOf(host).hasAttribute("data-cfg-collapsed")).toBe(true);
  });

  test("restore width exits; identical repeated deliveries never flip (no jitter)", async () => {
    const { host, roFake } = await mountWide();
    deliverAll(roFake, full(W.tight));
    expect(barOf(host).hasAttribute("data-cfg-collapsed")).toBe(true);
    deliverAll(roFake, dot(W.wide));
    expect(barOf(host).hasAttribute("data-cfg-collapsed")).toBe(false);
    // Post-exit re-delivery with expanded children at the same avail: stays expanded.
    deliverAll(roFake, full(W.wide));
    expect(barOf(host).hasAttribute("data-cfg-collapsed")).toBe(false);
    // Same width delivered repeatedly: idempotent, no oscillation in either form.
    for (let i = 0; i < 3; i++) deliverAll(roFake, full(W.wide));
    expect(barOf(host).hasAttribute("data-cfg-collapsed")).toBe(false);
    // Re-enter: the DOM follows the attribute, so the engine first re-delivers FULL
    // child sizes (attr is off) — the same canonical threshold then re-collapses, and
    // the post-collapse child re-deliveries confirm it.
    for (let i = 0; i < 3; i++) deliverAll(roFake, full(W.narrow));
    expect(barOf(host).hasAttribute("data-cfg-collapsed")).toBe(true);
    for (let i = 0; i < 3; i++) deliverAll(roFake, dot(W.narrow));
    expect(barOf(host).hasAttribute("data-cfg-collapsed")).toBe(true);
  });

  test("stale remembered width self-heals: expand then re-collapse on fresh measurement", async () => {
    const { host, roFake } = await mountWide();
    deliverAll(roFake, full(W.narrow)); // collapse; remembers cfgFull=120
    expect(barOf(host).hasAttribute("data-cfg-collapsed")).toBe(true);
    // Model renamed longer while collapsed: exit passes on the stale 120 (340 ≥ 308)…
    deliverAll(roFake, dot(340));
    expect(barOf(host).hasAttribute("data-cfg-collapsed")).toBe(false);
    // …but the fresh expanded delivery measures cfg=180 -> need 368 > 340 -> re-collapse.
    deliverAll(roFake, full(340, 180));
    expect(barOf(host).hasAttribute("data-cfg-collapsed")).toBe(true);
  });

  test("hidden bar (avail 0) decides nothing", async () => {
    const { host, roFake } = await mountWide();
    deliverAll(roFake, full(0));
    expect(barOf(host).hasAttribute("data-cfg-collapsed")).toBe(false);
  });

  test("collapsed dot click still opens the popover and selects via the real chain", async () => {
    const calls: [string, string][] = [];
    const { host } = mount(<Composer value="" {...BASE_PROPS} onSetConfig={(id, v) => calls.push([id, v])} />);
    await flush();
    const roFake = FakeResizeObserver.instances[FakeResizeObserver.instances.length - 1];
    deliverAll(roFake, full(W.narrow));
    expect(barOf(host).hasAttribute("data-cfg-collapsed")).toBe(true);
    const thought = host.querySelector('[data-testid="cfg-trigger-composer.cfgLabel.thought"]') as HTMLElement;
    thought.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    const opt = host.querySelector('[data-testid="cfg-option-low"]') as HTMLElement;
    expect(opt).not.toBeNull();
    opt.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    // Real id passes through (not the legacy hardcoded "effort"), popover chain intact.
    expect(calls).toContainEqual(["thinking_budget", "low"]);
  });
});
