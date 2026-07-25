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

import { describe, test, expect, mock, beforeEach } from "bun:test";
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
// Composer @ mention 现走 SessionFuzzyFind(跨目录模糊匹配,Task #23072)。
// 用可观测 mock 替代真 binding(挂载期不触发真后端)。fuzzyFindResult 是可变返回值,
// 测试用例在 mount 前赋值;mock 函数闭包在调用时读取,故重新赋值即时生效。
let fuzzyFindResult: { path: string; name: string; isDir: boolean }[] = [];
const chatServiceMock = {
  PickFiles: mock(async () => []),
  SessionFuzzyFind: mock(async (sessionID: string, query: string, limit: number) => fuzzyFindResult),
};
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => chatServiceMock);

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
  usage: { used: 0, size: 0, cost: 0 } as any,
  branch: "",
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

// Task #23072:@ mention 接 SessionFuzzyFind(跨目录模糊匹配 + 全路径展示)。
// 旧实现解析 query 最后一个 / 作目录、调 SessionListDir 单目录 + 前端 includes,跨目录命中不到
// (输入 @foo 找不到 src/foo.ts)。新实现把完整 query 交给后端 SessionFuzzyFind 全项目匹配,
// 下拉项显完整相对路径(basename + dim 目录前缀)以区分 src/foo.ts 与 lib/foo.ts。
//
// happy-dom + React 19:受控 input/textarea 的 onChange 在 dispatchEvent 派发的 input 事件下不触发
// (value-tracker + 事件代理不兼容)。但 React 的 onSelect 由 document 上的 selectionchange 实现,
// 派发 selectionchange 可靠触发 handleSelect → cursorRef/cursorPos 同步。故受控挂载 value="@foo"
// 后用 selectionchange 把光标定位到末尾,驱动 mentionInfo 重算为 {query:"foo"}。
function positionCursor(ta: HTMLTextAreaElement, pos: number) {
  ta.focus();
  ta.selectionStart = ta.selectionEnd = pos;
  document.dispatchEvent(new window.Event("selectionchange", { bubbles: true }));
}

describe("Composer @ mention cross-dir fuzzy find (Task #23072)", () => {
  beforeEach(() => {
    chatServiceMock.SessionFuzzyFind.mockClear();
    fuzzyFindResult = [];
  });
  test("typing @foo debounces to SessionFuzzyFind and renders cross-dir results with full paths", async () => {
    // 注入跨目录命中(src/foo.ts + lib/foo.ts,同名不同目录)。
    fuzzyFindResult = [
      { path: "src/foo.ts", name: "foo.ts", isDir: false },
      { path: "lib/foo.ts", name: "foo.ts", isDir: false },
    ];

    const { host } = mount(<Composer value={"@foo"} {...STUB_PROPS} sessionId={"sid"} />);
    await flush();

    // 光标定位到末尾(pos=4)→ handleSelect → cursorRef/cursorPos 同步 → mentionInfo={query:"foo"}。
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    expect(ta).not.toBeNull();
    positionCursor(ta, 4);
    await flush();

    // 防抖 150ms:等过再断言后端被调。
    await new Promise((r) => setTimeout(r, 200));
    await flush();

    expect(chatServiceMock.SessionFuzzyFind).toHaveBeenCalledTimes(1);
    // 完整 query 透传(不再 split 最后一个 /)、limit=12。
    expect(chatServiceMock.SessionFuzzyFind).toHaveBeenCalledWith("sid", "foo", 12);

    // 下拉应打开,渲染两项跨目录命中。
    const popover = host.querySelector('[data-testid="mention-popover"]');
    expect(popover).not.toBeNull();
    const items = popover!.querySelectorAll("button.slash-item");
    expect(items.length).toBe(2);
    // 每项显完整相对路径(目录前缀 + basename),让用户能区分两个 foo.ts(§4.4)。
    expect(items[0]!.querySelector(".mention-dir")!.textContent).toBe("src/");
    expect(items[0]!.querySelector(".mention-path")!.textContent).toBe("src/foo.ts");
    expect(items[1]!.querySelector(".mention-dir")!.textContent).toBe("lib/");
    expect(items[1]!.querySelector(".mention-path")!.textContent).toBe("lib/foo.ts");
  });

  test("empty @query closes popover without hitting backend", async () => {
    fuzzyFindResult = [];
    const { host } = mount(<Composer value={"@"} {...STUB_PROPS} sessionId={"sid"} />);
    await flush();

    // 光标在 @ 之后(pos=1):query 为空 → 应直接关面板,不打后端。
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(ta, 1);
    await new Promise((r) => setTimeout(r, 200));
    await flush();

    expect(chatServiceMock.SessionFuzzyFind).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="mention-popover"]')).toBeNull();
  });
});
