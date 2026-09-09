// Mount-test the ≤768px config chip + bottom sheet (issue #148 phase 2).
// On phones the desktop cfg-trigger row is CSS-hidden; MobileConfigSelect
// replaces that void with one compact chip (current model short name) opening
// a bottom sheet carrying model (cmdk search) / mode / thought_level. The data
// channel must stay IDENTICAL to the desktop popover: every selection goes
// through onSetConfig(<ConfigOption.id>, value) — the same contract pinned by
// ModelSelect.mount.test.tsx (no hardcoded "model"/"mode"/"effort" ids).
//
// matchMedia simulation (existing mount-suite convention, cf.
// FilePanel.coarse.mount.test.tsx): the override lands BEFORE Composer.tsx is
// imported. The mobile gate (useMobileViewport) reads matchMedia at mount, so
// the flag is mutable per test to cover both sides of the breakpoint.
//
// @radix-ui/react-popover and cmdk are mocked to thin pass-throughs (same
// mocks as ModelSelect.mount.test.tsx) — the sheet itself uses cmdk + native
// selects only, but Composer.tsx imports Radix at module scope.

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
globalThis.HTMLSelectElement = window.HTMLSelectElement;
window.React = React;

// Mobile breakpoint simulation — mutable so both sides of 768px are testable.
let mobileMatches = true;
window.matchMedia = (query: string) => ({
  matches: mobileMatches && query.includes("max-width: 768"),
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
});

// ---- mock @radix-ui/react-popover: context-driven open state, no Portal/FocusScope ----
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
    return React.createElement("div", { ...props, "data-popover-content": "true" }, children);
  };
  const Anchor = ({ children }) => children ?? null;
  const Arrow = () => null;
  const Close = ({ children }) => children ?? null;
  return {
    default: { Root, Trigger, Portal, Content, Anchor, Arrow, Close },
    Root, Trigger, Portal, Content, Anchor, Arrow, Close,
  };
});

// ---- mock cmdk: thin pass-through, Command.Item fires onSelect on click ----
mock.module("cmdk", () => {
  const Command = React.forwardRef(({ children, ...props }, ref) =>
    React.createElement("div", { ref, ...props }, children));
  Command.Input = (props) => React.createElement("input", props);
  Command.List = ({ children, ...props }) => React.createElement("div", props, children);
  Command.Empty = () => null;
  Command.Group = ({ children, ...props }) => React.createElement("div", props, children);
  Command.Item = ({ children, onSelect, ...props }) =>
    React.createElement("div", { ...props, onClick: onSelect }, children);
  Command.Separator = () => null;
  return { Command };
});

// react-i18next: return the key so testids/labels are predictable.
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k) => k }),
  initReactI18next: { type: "3rd-party" },
  default: { useTranslation: () => ({ t: (k) => k }) },
}));

const { MobileConfigSelect, useMobileViewport } = await import("./Composer.tsx");
import type { ConfigOption } from "../types";

const mounted: { host: HTMLElement; root: { unmount: () => void } }[] = [];

function mount(jsx) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(jsx);
  mounted.push({ host, root });
  return { host, root };
}

// Portal isolation: the sheet renders into document.body, so a sheet left open
// by one test would shadow the next test's querySelector — unmount everything.
afterEach(async () => {
  while (mounted.length) {
    const { host, root } = mounted.pop()!;
    root.unmount();
    host.remove();
  }
  document.querySelectorAll(".cfg-sheet-layer").forEach((n) => n.remove());
  mobileMatches = true;
});

async function flush() {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 5));
}

function setSelectValue(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function click(el: HTMLElement) {
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
}

// Same shape as ModelSelect.mount.test.tsx: ids intentionally ≠ the hardcoded
// category names, so a regression to onSetConfig("model", v) fails here too.
const CFG_OPTS: ConfigOption[] = [
  {
    id: "model_id_custom",
    name: "Model",
    category: "model",
    currentValue: "zai/glm-5.1",
    options: [
      { value: "zai/glm-5.1", name: "GLM-5.1" },
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

describe("useMobileViewport (≤768px mount gate)", () => {
  test("true when matchMedia reports max-width:768", async () => {
    mobileMatches = true;
    function Probe() {
      const m = useMobileViewport();
      return React.createElement("div", { "data-testid": "probe", "data-mobile": String(m) });
    }
    const { host } = mount(React.createElement(Probe));
    await flush();
    expect(host.querySelector('[data-testid="probe"]')!.getAttribute("data-mobile")).toBe("true");
  });

  test("false above the breakpoint (desktop stays chip-free)", async () => {
    mobileMatches = false;
    function Probe() {
      const m = useMobileViewport();
      return React.createElement("div", { "data-testid": "probe", "data-mobile": String(m) });
    }
    const { host } = mount(React.createElement(Probe));
    await flush();
    expect(host.querySelector('[data-testid="probe"]')!.getAttribute("data-mobile")).toBe("false");
    mobileMatches = true;
  });
});

describe("MobileConfigSelect chip + bottom sheet", () => {
  test("chip renders the current model short name (provider prefix dropped)", async () => {
    const onSetConfig = () => {};
    const { host } = mount(
      <MobileConfigSelect configOptions={CFG_OPTS} disabled={false} onSetConfig={onSetConfig} onRefreshConfig={() => {}} />
    );
    await flush();
    const chip = host.querySelector('[data-testid="cfg-chip"]') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain("glm-5.1");
    expect(chip.textContent).not.toContain("zai/");
  });

  test("chip tap opens the sheet with model/mode/thought groups; model pick calls onSetConfig(ConfigOption.id, value) and closes", async () => {
    const calls: [string, string][] = [];
    const onSetConfig = (configId: string, value: string) => calls.push([configId, value]);
    const { host } = mount(
      <MobileConfigSelect configOptions={CFG_OPTS} disabled={false} onSetConfig={onSetConfig} onRefreshConfig={() => {}} />
    );
    await flush();
    // Closed by default.
    expect(document.querySelector('[data-testid="cfg-sheet"]')).toBeNull();
    click(host.querySelector('[data-testid="cfg-chip"]') as HTMLElement);
    await flush();
    // Sheet renders into a portal on document.body, not inside the host.
    const sheet = document.querySelector('[data-testid="cfg-sheet"]') as HTMLElement;
    expect(sheet).not.toBeNull();
    expect(sheet.querySelector('[data-testid="cfg-sheet-search"]')).not.toBeNull();
    expect(sheet.querySelector('[data-testid="cfg-sheet-mode"]')).not.toBeNull();
    expect(sheet.querySelector('[data-testid="cfg-sheet-thought"]')).not.toBeNull();
    // Model pick → actual ConfigOption.id, not the hardcoded category name.
    const opt = sheet.querySelector('[data-testid="cfg-option-ant/claude"]') as HTMLElement;
    expect(opt).not.toBeNull();
    click(opt);
    await flush();
    expect(calls).toContainEqual(["model_id_custom", "ant/claude"]);
    expect(document.querySelector('[data-testid="cfg-sheet"]')).toBeNull();
  });

  test("mode select commits onSetConfig(ConfigOption.id, value) and the sheet stays open", async () => {
    const calls: [string, string][] = [];
    const onSetConfig = (configId: string, value: string) => calls.push([configId, value]);
    const { host } = mount(
      <MobileConfigSelect configOptions={CFG_OPTS} disabled={false} onSetConfig={onSetConfig} onRefreshConfig={() => {}} />
    );
    await flush();
    click(host.querySelector('[data-testid="cfg-chip"]') as HTMLElement);
    await flush();
    const mode = document.querySelector('[data-testid="cfg-sheet-mode"]') as HTMLSelectElement;
    setSelectValue(mode, "plan");
    await flush();
    expect(calls).toContainEqual(["build_mode", "plan"]);
    // Mode and thought usually change together — the sheet deliberately stays open.
    expect(document.querySelector('[data-testid="cfg-sheet"]')).not.toBeNull();
  });

  test("thought select commits onSetConfig(ConfigOption.id, value)", async () => {
    const calls: [string, string][] = [];
    const onSetConfig = (configId: string, value: string) => calls.push([configId, value]);
    const { host } = mount(
      <MobileConfigSelect configOptions={CFG_OPTS} disabled={false} onSetConfig={onSetConfig} onRefreshConfig={() => {}} />
    );
    await flush();
    click(host.querySelector('[data-testid="cfg-chip"]') as HTMLElement);
    await flush();
    const thought = document.querySelector('[data-testid="cfg-sheet-thought"]') as HTMLSelectElement;
    setSelectValue(thought, "high");
    await flush();
    expect(calls).toContainEqual(["thinking_budget", "high"]);
  });

  test("Esc and scrim tap close the sheet (§4.2)", async () => {
    const { host } = mount(
      <MobileConfigSelect configOptions={CFG_OPTS} disabled={false} onSetConfig={() => {}} onRefreshConfig={() => {}} />
    );
    await flush();
    click(host.querySelector('[data-testid="cfg-chip"]') as HTMLElement);
    await flush();
    expect(document.querySelector('[data-testid="cfg-sheet"]')).not.toBeNull();
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(document.querySelector('[data-testid="cfg-sheet"]')).toBeNull();
    click(host.querySelector('[data-testid="cfg-chip"]') as HTMLElement);
    await flush();
    click(document.querySelector('[data-testid="cfg-sheet-scrim"]') as HTMLElement);
    await flush();
    expect(document.querySelector('[data-testid="cfg-sheet"]')).toBeNull();
  });

  test("opening the sheet fires onRefreshConfig (same freshness contract as the desktop popover)", async () => {
    let refreshes = 0;
    const { host } = mount(
      <MobileConfigSelect configOptions={CFG_OPTS} disabled={false} onSetConfig={() => {}} onRefreshConfig={() => { refreshes++; }} />
    );
    await flush();
    expect(refreshes).toBe(0);
    click(host.querySelector('[data-testid="cfg-chip"]') as HTMLElement);
    await flush();
    expect(refreshes).toBe(1);
  });
});
