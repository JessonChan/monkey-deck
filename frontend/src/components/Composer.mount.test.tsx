// Mount-test Composer paste-collapse regression (Task #21328).
//
// Reproduces "复制后无法输入": pasting into an already-long, expanded composer
// yanked the textarea into collapsed-preview mode mid-edit, so keystrokes were lost.
//
// Root cause: onPaste forced setCollapsed(true) whenever the pasted *result* was long,
// WITHOUT checking whether the composer was already long / actively expanded. Pasting
// even one character into a long composer collapsed it, removing the textarea from the
// DOM -> keystrokes went nowhere. This contradicted both the auto-collapse effect's own
// focus guard (document.activeElement !== ref.current) and the design principle
// "聚焦中不打断输入" (docs/worklog/2026-07-14-composer-long-text-collapse.md).
//
// Fix: only force-collapse on the short->long transition (!isLong && futureIsLong),
// so pasting into an already-long composer respects the user's expanded/editing state.
//
// This test pins the fix:
//   - OLD code (collapse whenever future is long) -> FAILS: textarea vanishes after paste
//   - NEW code (collapse only on short->long)      -> PASSES: textarea stays editable
//
// We mock @radix-ui/react-popover / cmdk / react-i18next to thin pass-throughs (same as
// ModelSelect.mount.test.tsx) so the test exercises the REAL Composer paste + collapse
// wiring without depending on Radix FocusScope / cmdk internals in happy-dom. A faithful
// native paste event (ClipboardEvent + DataTransfer) drives the real onPaste handler.

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

const Composer = (await import("./Composer.tsx")).default;

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

// Minimal prop stubs (no session / no attachments / no image support / empty config).
const STUB_PROPS = {
  onChange: () => {},
  disabled: false,
  prompting: false,
  configOptions: [],
  onSetConfig: () => {},
  history: [],
  sessionId: "",
  attachments: [],
  onAttachmentsChange: () => {},
  mentions: [],
  onMentionsChange: () => {},
  images: [],
  onImagesChange: () => {},
  imageSupported: false,
  usage: { used: 0, size: 0, cost: 0 } as any,
  onSend: () => {},
  onEnqueue: () => {},
  onStop: () => {},
  onAction: () => {},
};

// >8 lines so isLong is true on mount.
const LONG_DRAFT = Array.from({ length: 12 }, (_, i) => `line ${i + 1}: some draft content`).join("\n");

// Dispatch a faithful native paste event carrying `text` on the textarea, at the end of current value.
function pasteText(ta: HTMLTextAreaElement, text: string) {
  const dt = new window.DataTransfer();
  dt.setData("text", text);
  const ev = new window.ClipboardEvent("paste", { clipboardData: dt, bubbles: true });
  ta.dispatchEvent(ev);
}

describe("Composer paste-into-long regression (Task #21328)", () => {
  test("pasting into an expanded long composer keeps the textarea editable", async () => {
    const { host } = mount(<Composer value={LONG_DRAFT} {...STUB_PROPS} />);
    await flush();

    // Long draft + not focused on mount -> auto-collapses to preview, textarea absent.
    expect(host.querySelector('[data-testid="composer-collapse"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="composer-input"]')).toBeNull();

    // Expand via the top toggle (simulates user clicking "expand" to edit the long draft).
    const toggle = host.querySelector('[data-testid="composer-collapse-toggle"]') as HTMLElement;
    expect(toggle).not.toBeNull();
    toggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    // Textarea is back and focused (expandInput focuses it via rAF).
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    expect(ta).not.toBeNull();

    // Reproduce the bug: paste a short snippet into the long, focused composer.
    // BUGGY code collapsed here (future is still long) -> textarea would vanish.
    pasteText(ta, " appended short line");
    await flush();

    // FIXED: textarea must remain editable (not yanked into collapsed preview).
    expect(host.querySelector('[data-testid="composer-input"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="composer-collapse"]')).toBeNull();
  });
});

// Task #22131: 主动入队列 —— Composer 入队列按钮 + ⌘⇧↩ 快捷键应调 onEnqueue(而非 onSend)。
describe("Composer active enqueue (Task #22131)", () => {
  test("enqueue button calls onEnqueue (not onSend) and clears the input", async () => {
    const onSend = mock(() => {});
    const onEnqueue = mock(() => {});
    const onChange = mock(() => {});
    const { host } = mount(
      <Composer value={"do something"} {...STUB_PROPS} onSend={onSend} onEnqueue={onEnqueue} onChange={onChange} />
    );
    await flush();

    const btn = host.querySelector('[data-testid="enqueue-btn"]') as HTMLElement;
    expect(btn).not.toBeNull();
    btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    expect(onEnqueue).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    // submit 总是以 (text, mentions[], imgs) 调用并清空输入。
    expect(onChange).toHaveBeenCalledWith("");
  });

  test("⌘⇧↩ on the textarea triggers enqueue, plain ↩ triggers send", async () => {
    const onSend = mock(() => {});
    const onEnqueue = mock(() => {});
    const { host } = mount(
      <Composer value={"hello"} {...STUB_PROPS} onSend={onSend} onEnqueue={onEnqueue} />
    );
    await flush();

    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    expect(ta).not.toBeNull();

    // ⌘⇧↩ → enqueue
    ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, metaKey: true, bubbles: true }));
    await flush();
    expect(onEnqueue).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });
});
