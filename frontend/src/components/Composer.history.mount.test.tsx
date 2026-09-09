// Mount-test the composer history chip/badge removal (#198).
//
// The compose-tools hint chip (idle) and navigation badge (mid-navigation) were
// visual-only affordances for the ↑↓ history shortcut; #198 removes them (and
// with them the navDisplay state mirror, which only the badge consumed). The
// removal must NOT touch the keyboard navigation state machine (navRef /
// navigateHistory). This file pins both sides of that contract:
//   1. neither chip nor badge renders — idle AND mid-navigation (the badge used
//      to pop in exactly then)
//   2. ↑↓ still walks history and past-the-newest restores the draft
// Controlled-component note: the parent mock never re-renders, so assertions
// observe the onChange call sequence (the contract consumers see).

import { describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";
import type { Usage } from "../types";

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

// Dynamic import (not static): bun's mock.module must be registered BEFORE the
// module under test loads, and static imports hoist above the mock calls —
// same pattern as Composer.mount.test.tsx / Composer.cfgdot.mount.test.tsx.
const Composer = (await import("./Composer.tsx")).default;

function mount(jsx) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(jsx);
  return { host, root };
}

async function flush() {
  for (let i = 0; i < 10; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
}

const ZERO_USAGE: Usage = {
  used: 0, size: 0, cost: 0,
  cachedReadTokens: 0, cachedWriteTokens: 0,
  inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0,
};

const STUB_PROPS = {
  disabled: false,
  prompting: false,
  configOptions: [],
  onSetConfig: () => {},
  onRefreshConfig: () => {},
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

// Both render forms must be gone: idle chip (testid + class) and the badge that
// used to appear only while navigating (testid + class).
function chipBadgeAbsent(host: HTMLElement) {
  expect(host.querySelector('[data-testid="composer-history-chip"]')).toBeNull();
  expect(host.querySelector('[data-testid="composer-history-badge"]')).toBeNull();
  expect(host.querySelector(".compose-history-chip")).toBeNull();
  expect(host.querySelector(".compose-history-badge")).toBeNull();
}

// The parent mock never re-renders (controlled value stays the mounted prop),
// so the observable contract is the onChange call sequence.
function lastOnChange(onChange: { mock: { calls: unknown[][] } }) {
  return onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
}

describe("Composer history chip/badge removal (#198)", () => {
  test("chip/badge never render; ↑↓ still navigates and past-newest restores the draft", async () => {
    const onChange = mock(() => {});
    const { host } = mount(
      <Composer value="draft msg" {...STUB_PROPS} history={["older", "newer"]} onChange={onChange} />
    );
    await flush();

    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    expect(ta).not.toBeNull();
    chipBadgeAbsent(host);

    const press = (key: string) =>
      ta.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));

    // Focus before dispatching keys: key events only reach React's delegated
    // handler when the textarea has focus (happy-dom + React 19) — same as
    // real usage, where the composer is focused when the user presses ↑↓.
    ta.focus();

    // ↑ enters history at the newest entry. The badge used to render right here.
    press("ArrowUp");
    await flush();
    expect(lastOnChange(onChange)).toBe("newer");
    chipBadgeAbsent(host);

    // ↑ walks further back.
    press("ArrowUp");
    await flush();
    expect(lastOnChange(onChange)).toBe("older");

    // ↓ walks forward again...
    press("ArrowDown");
    await flush();
    expect(lastOnChange(onChange)).toBe("newer");

    // ...and past the newest entry restores the draft captured on entry.
    press("ArrowDown");
    await flush();
    expect(lastOnChange(onChange)).toBe("draft msg");
    chipBadgeAbsent(host);
  });
});
