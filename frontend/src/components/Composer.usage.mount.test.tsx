// Mount-test Composer usage panel "not reported" state (Task #23428).
//
// Reproduces the UX gap: when harness-reported usage was all 0 (no context / cost /
// breakdown), ComposerUsage returned null — the usage entry point vanished entirely,
// leaving no signal that usage tracking existed or that the harness simply hadn't
// reported yet.
//
// Fix: when all harness-reported fields are 0, render a gray「—(未上报)」instead of null.
// Determination is based purely on actual data (§5.3 尊重数据源), NOT on
// CapabilityMatrix.emitsUsage (a capability declaration is not the truth — the data is).
//
// Cases pinned here:
//   1. All 0 (no draft)        → composer-usage present, shows「—(未上报)」(.cu-none).
//   2. Draft only, usage all 0  →「~draft · —(未上报)」(draft local estimate + not-reported).
//   3. Context reported        → shows used / size · pct%, NO .cu-none (no regression).
//   4. Cost only               → shows $cost, NO .cu-none (no regression).
//
// Mocks mirror Composer.mount.test.tsx (Radix/cmdk/i18next thin pass-throughs) so the
// real Composer renders without leaning on Radix FocusScope / cmdk internals in happy-dom.

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
window.React = React;

// ---- mock @radix-ui/react-popover / cmdk / react-i18next (see Composer.mount.test) ----
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
  // Return the key so we can assert which i18n string the component selected.
  useTranslation: () => ({ t: (k) => k }),
  initReactI18next: { type: "3rd-party" },
  default: { useTranslation: () => ({ t: (k) => k }) },
}));
const chatServiceMock = {
  PickFiles: mock(async () => []),
  SessionFuzzyFind: mock(async () => []),
};
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => chatServiceMock);

const Composer = (await import("./Composer.tsx")).default;

const ZERO_USAGE = {
  used: 0, size: 0, cost: 0,
  cachedReadTokens: 0, cachedWriteTokens: 0,
  inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0,
};

function mount(jsx) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(jsx);
  return { host, root };
}

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
}

function baseProps(overrides = {}) {
  return {
    value: "",
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
    usage: { ...ZERO_USAGE },
    onSend: () => {},
    onEnqueue: () => {},
    onStop: () => {},
    onAction: () => {},
    ...overrides,
  };
}

describe("Composer usage panel not-reported state (Task #23428)", () => {
  test("all-zero usage renders gray「—(未上报)」instead of vanishing", async () => {
    const { host } = mount(<Composer {...baseProps()} />);
    await flush();

    const panel = host.querySelector('[data-testid="composer-usage"]');
    expect(panel).not.toBeNull();
    const none = panel!.querySelector(".cu-none");
    expect(none).not.toBeNull();
    // i18n key for the not-reported label is rendered (mock t returns the key).
    expect(none!.textContent).toBe("chat.usageNotReported");
    // tooltip explains why (not-reported tip, not the breakdown title).
    expect(panel!.getAttribute("data-tooltip-content")).toBe("chat.usageNotReportedTip");
    // No context / cost spans when nothing reported.
    expect(panel!.querySelector(".cu-ctx")).toBeNull();
    expect(panel!.querySelector(".cu-cost")).toBeNull();
  });

  test("draft present + usage all 0 shows draft then「—(未上报)」", async () => {
    const { host } = mount(<Composer {...baseProps({ value: "hello world draft" })} />);
    await flush();

    const panel = host.querySelector('[data-testid="composer-usage"]');
    expect(panel).not.toBeNull();
    // Local draft estimate still rendered (it is not part of "reported" judgement).
    expect(panel!.querySelector(".cu-draft")).not.toBeNull();
    // And the not-reported marker coexists with the draft.
    expect(panel!.querySelector(".cu-none")).not.toBeNull();
    expect(panel!.querySelector(".cu-none")!.textContent).toBe("chat.usageNotReported");
  });

  test("context reported → renders used / size / pct, no not-reported marker (no regression)", async () => {
    const { host } = mount(
      <Composer {...baseProps({ usage: { ...ZERO_USAGE, used: 5000, size: 20000 } })} />
    );
    await flush();

    const panel = host.querySelector('[data-testid="composer-usage"]');
    expect(panel).not.toBeNull();
    const ctx = panel!.querySelector(".cu-ctx");
    expect(ctx).not.toBeNull();
    // fmtTokens(5000) = "5.0k" (<10000 → 1 decimal), fmtTokens(20000) = "20k", pct = 25%.
    expect(ctx!.textContent).toContain("5.0k");
    expect(ctx!.textContent).toContain("20k");
    expect(ctx!.textContent).toContain("25%");
    // Critical: must NOT show the not-reported marker when data is present.
    expect(panel!.querySelector(".cu-none")).toBeNull();
    // Tooltip falls back to title (no token breakdown reported).
    expect(panel!.getAttribute("data-tooltip-content")).toBe("chat.usageTitle");
  });

  test("cost reported (no context) → renders $cost, no not-reported marker (no regression)", async () => {
    const { host } = mount(
      <Composer {...baseProps({ usage: { ...ZERO_USAGE, cost: 0.0123 } })} />
    );
    await flush();

    const panel = host.querySelector('[data-testid="composer-usage"]');
    expect(panel).not.toBeNull();
    const cost = panel!.querySelector(".cu-cost");
    expect(cost).not.toBeNull();
    expect(cost!.textContent).toBe("$0.0123");
    expect(panel!.querySelector(".cu-none")).toBeNull();
  });
});
