// Mount-test ModelSelect with happy-dom + React (Task #21293 review).
// Regression test for the "hardcoded configId" bug: ModelSelect used to pass
// "model"/"mode"/"effort" as the configId to onSetConfig, instead of the
// ConfigOption's actual `id` field. This test uses config options whose `id`
// intentionally differs from those hardcoded strings, so:
//   - OLD code (onSetConfig("effort", v)) → FAILS (passes "effort", not "thinking_budget")
//   - NEW code (onSetConfig(effortOpt.id, v)) → PASSES (passes "thinking_budget")
// This pins the fix and catches any regression that re-introduces the hardcode.
//
// We mock @radix-ui/react-popover and cmdk to thin pass-throughs so the test
// exercises the REAL ModelSelect + ConfigSelect callback wiring (the code under
// review) without depending on Radix FocusScope / cmdk ResizeObserver internals
// (which are brittle in happy-dom). The mock preserves the callback chain:
// Trigger → Root open state → Content render gate; Command.Item → onSelect(v).

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

// ---- mock @radix-ui/react-popover: context-driven open state, no Portal/FocusScope ----
// Mirrors the controlled API ConfigSelect uses: <Popover.Root open onOpenChange>
// + <Popover.Trigger asChild> + <Popover.Portal><Popover.Content>.
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
  Command.Loading = () => null;
  Command.Separator = () => null;
  return { Command };
});

// react-i18next: return the key so testids are predictable (cfg-trigger-<key>).
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k) => k }),
  initReactI18next: { type: "3rd-party" },
  default: { useTranslation: () => ({ t: (k) => k }) },
}));

const { ModelSelect } = await import("./Composer.tsx");
import type { ConfigOption } from "../types";

function mount(jsx) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(jsx);
  return { host, root };
}

async function flush() {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 5));
}

// Config options with `id` intentionally ≠ the old hardcoded strings.
// This is the shape a non-opencode harness (or a future opencode id rename)
// would expose. OLD code would pass "model"/"mode"/"effort" (wrong);
// NEW code must pass the actual id.
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

describe("ModelSelect configId wiring", () => {
  test("effort select passes ConfigOption.id (not hardcoded \"effort\")", async () => {
    const calls: [string, string][] = [];
    const onSetConfig = (configId: string, value: string) => calls.push([configId, value]);
    const { host } = mount(
      <ModelSelect configOptions={CFG_OPTS} disabled={false} onSetConfig={onSetConfig} onRefreshConfig={() => {}} contextTokens={0} />
    );
    await flush();
    const effortTrigger = host.querySelector('[data-testid="cfg-trigger-composer.cfgLabel.thought"]') as HTMLElement;
    expect(effortTrigger).not.toBeNull();
    effortTrigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    const opt = host.querySelector('[data-testid="cfg-option-low"]') as HTMLElement;
    expect(opt).not.toBeNull();
    opt.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    // Must use the actual id "thinking_budget", NOT the hardcoded "effort".
    expect(calls).toContainEqual(["thinking_budget", "low"]);
  });

  test("mode select passes ConfigOption.id (not hardcoded \"mode\")", async () => {
    const calls: [string, string][] = [];
    const onSetConfig = (configId: string, value: string) => calls.push([configId, value]);
    const { host } = mount(
      <ModelSelect configOptions={CFG_OPTS} disabled={false} onSetConfig={onSetConfig} onRefreshConfig={() => {}} contextTokens={0} />
    );
    await flush();
    const modeTrigger = host.querySelector('[data-testid="cfg-trigger-composer.cfgLabel.mode"]') as HTMLElement;
    expect(modeTrigger).not.toBeNull();
    modeTrigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    const opt = host.querySelector('[data-testid="cfg-option-plan"]') as HTMLElement;
    expect(opt).not.toBeNull();
    opt.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    expect(calls).toContainEqual(["build_mode", "plan"]);
  });

  test("model select passes ConfigOption.id (not hardcoded \"model\")", async () => {
    const calls: [string, string][] = [];
    const onSetConfig = (configId: string, value: string) => calls.push([configId, value]);
    const { host } = mount(
      <ModelSelect configOptions={CFG_OPTS} disabled={false} onSetConfig={onSetConfig} onRefreshConfig={() => {}} contextTokens={0} />
    );
    await flush();
    const modelTrigger = host.querySelector('[data-testid="cfg-trigger-composer.cfgLabel.model"]') as HTMLElement;
    expect(modelTrigger).not.toBeNull();
    modelTrigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    const opt = host.querySelector('[data-testid="cfg-option-ant/claude"]') as HTMLElement;
    expect(opt).not.toBeNull();
    opt.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    expect(calls).toContainEqual(["model_id_custom", "ant/claude"]);
  });
});
