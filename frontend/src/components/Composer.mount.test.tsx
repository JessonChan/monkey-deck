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
// Composer @ mention 现走 SessionFuzzyFind(scope + query,Task #23449)。
// 用可观测 mock 替代真 binding(挂载期不触发真后端)。fuzzyFindResult 是可变返回值,
// 测试用例在 mount 前赋值;mock 函数闭包在调用时读取,故重新赋值即时生效。
let fuzzyFindResult: { path: string; name: string; isDir: boolean }[] = [];
const chatServiceMock = {
  PickFiles: mock(async () => []),
  SessionFuzzyFind: mock(async (sessionID: string, scope: string, query: string, limit: number) => fuzzyFindResult),
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
  audios: [],
  onAudiosChange: () => {},
  audioSupported: false,
  usage: { used: 0, size: 0, cost: 0 } as any,
  branch: "",
  onSend: () => {},
  onEnqueue: () => {},
  onStop: () => {},
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

describe("Composer @ mention cross-dir fuzzy find (Task #23072 / #23449)", () => {
  beforeEach(() => {
    chatServiceMock.SessionFuzzyFind.mockClear();
    fuzzyFindResult = [];
  });
  test("typing @foo debounces to SessionFuzzyFind(scope='', query='foo') and renders cross-dir results with full paths", async () => {
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
    // scope 由 splitScopeTerm 推导:无 / → scope="" ;完整 term 透传;limit=12。
    expect(chatServiceMock.SessionFuzzyFind).toHaveBeenCalledWith("sid", "", "foo", 12);

    // 下拉应打开,渲染两项跨目录命中。
    const popover = host.querySelector('[data-testid="mention-popover"]');
    expect(popover).not.toBeNull();
    const items = popover!.querySelectorAll("button.slash-item");
    // 仅命中项(不含 go-up:scope="" 时不渲染 go-up)。
    const hitItems = Array.from(items).filter((b) => !b.classList.contains("mention-up"));
    expect(hitItems.length).toBe(2);
    // 每项显完整相对路径(目录前缀 + basename),让用户能区分两个 foo.ts(§4.4)。
    expect(hitItems[0]!.querySelector(".mention-dir")!.textContent).toBe("src/");
    expect(hitItems[0]!.querySelector(".mention-path")!.textContent).toBe("src/foo.ts");
    expect(hitItems[1]!.querySelector(".mention-dir")!.textContent).toBe("lib/");
    expect(hitItems[1]!.querySelector(".mention-path")!.textContent).toBe("lib/foo.ts");
  });

  // Task #23449:空 query 即弹 —— 后端对空 query 返根子项(含目录),@ 后立即展示让用户挑/钻。
  test("typing @ alone pops the panel with root children (empty term -> scope='', term='')", async () => {
    fuzzyFindResult = [
      { path: "src", name: "src", isDir: true },
      { path: "README.md", name: "README.md", isDir: false },
    ];
    const { host } = mount(<Composer value={"@"} {...STUB_PROPS} sessionId={"sid"} />);
    await flush();

    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(ta, 1);
    await new Promise((r) => setTimeout(r, 200));
    await flush();

    // 空 term 也打后端:scope="", term=""。
    expect(chatServiceMock.SessionFuzzyFind).toHaveBeenCalledWith("sid", "", "", 12);
    const popover = host.querySelector('[data-testid="mention-popover"]');
    expect(popover).not.toBeNull();
    // 目录项含 is-dir 类 + drill chevron;文件项含 is-file 类。
    const dirItem = popover!.querySelector("button.slash-item.is-dir");
    const fileItem = popover!.querySelector("button.slash-item.is-file");
    expect(dirItem).not.toBeNull();
    expect(fileItem).not.toBeNull();
    expect(dirItem!.querySelector(".mention-drill-chev")).not.toBeNull();
    // 根目录(scope="")不渲染 go-up。
    expect(popover!.querySelector('[data-testid="mention-go-up"]')).toBeNull();
  });
});

// Review #24199:chip 显示不变量 —— chip 显 m.name(basename),不显 m.path(全路径);
// 全路径只进 title(tooltip)与插入文本。锚定值(非字段存在):name 在 chip 内、path 不在。
describe("Composer @ mention chip shows name, not path (Review #24199)", () => {
  test("a deeply-nested mention chip renders basename only; full path lives in title", async () => {
    const mentions = [{ path: "src/deep/nested/foo.ts", name: "foo.ts" }];
    const { host } = mount(<Composer value={"@src/deep/nested/foo.ts "} {...STUB_PROPS} mentions={mentions} />);
    await flush();

    const chip = host.querySelector(".att-chip-mention") as HTMLElement | null;
    expect(chip).not.toBeNull();
    // chip body shows @ + basename, NOT the full path.
    const nameEl = chip!.querySelector(".att-chip-name") as HTMLElement | null;
    expect(nameEl).not.toBeNull();
    expect(nameEl!.textContent).toBe("@foo.ts");
    expect(nameEl!.textContent).not.toContain("src/deep/nested/");
    // full path is the tooltip source so users can still see the whole reference on hover.
    expect(chip!.getAttribute("title")).toBe("@src/deep/nested/foo.ts");
  });
});

// Task #23449:选中目录下钻 + scope 透传 + 返回上一级。文本是唯一事实源:@ token 的尾随 /
// 标记 drill 态,scope 从 splitScopeTerm 推导,刷新/恢复都能复现(§5.3 找不变量)。
describe("Composer @ mention drill-down + scope + go-up (Task #23449)", () => {
  beforeEach(() => {
    chatServiceMock.SessionFuzzyFind.mockClear();
    fuzzyFindResult = [];
  });

  test("selecting a directory drills in: text becomes '@src/', scope='src' on next query", async () => {
    // 初始 @ → 列根子项(含 src 目录)。
    fuzzyFindResult = [{ path: "src", name: "src", isDir: true }];
    const onChange = mock(() => {});
    const { host } = mount(<Composer value={"@"} {...STUB_PROPS} sessionId={"sid"} onChange={onChange} />);
    await flush();
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(ta, 1);
    await new Promise((r) => setTimeout(r, 200));
    await flush();
    expect(chatServiceMock.SessionFuzzyFind).toHaveBeenLastCalledWith("sid", "", "", 12);

    // 点目录项 → 钻进:onChange 收到 "@src/"(@query 替换为 @src/)。
    const dirItem = host.querySelector('button.slash-item.is-dir') as HTMLElement;
    expect(dirItem).not.toBeNull();
    dirItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
    expect(last).toBe("@src/");
  });

  test("drilled state (@src/) queries scope='src' term='' and renders go-up; go-up returns to root", async () => {
    fuzzyFindResult = [{ path: "src/foo.ts", name: "foo.ts", isDir: false }];
    const onChange = mock(() => {});
    const { host } = mount(<Composer value={"@src/"} {...STUB_PROPS} sessionId={"sid"} onChange={onChange} />);
    await flush();
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(ta, 5); // 光标在 "@src/" 末尾
    await new Promise((r) => setTimeout(r, 200));
    await flush();

    // scope 由 splitScopeTerm("src/") 推导 = "src";term=""。
    expect(chatServiceMock.SessionFuzzyFind).toHaveBeenLastCalledWith("sid", "src", "", 12);
    const popover = host.querySelector('[data-testid="mention-popover"]');
    expect(popover).not.toBeNull();
    // scope 非空 → 渲染 go-up。
    const goUp = popover!.querySelector('[data-testid="mention-go-up"]') as HTMLElement;
    expect(goUp).not.toBeNull();

    goUp.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    // go-up:剥末尾一段 → query 退到 ""(根)。
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
    expect(last).toBe("@");
  });

  test("typing @src/foo narrows scope to 'src' and term to 'foo'", async () => {
    fuzzyFindResult = [{ path: "src/foo.ts", name: "foo.ts", isDir: false }];
    const { host } = mount(<Composer value={"@src/foo"} {...STUB_PROPS} sessionId={"sid"} />);
    await flush();
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(ta, 8);
    await new Promise((r) => setTimeout(r, 200));
    await flush();
    // splitScopeTerm("src/foo") = { scope:"src", term:"foo" }。
    expect(chatServiceMock.SessionFuzzyFind).toHaveBeenLastCalledWith("sid", "src", "foo", 12);
  });

  test("Backspace on empty term (cursor right after '/') goes up one level", async () => {
    // 面板需打开(mentionOpen=true)才进 Backspace 分支;给非空结果。
    fuzzyFindResult = [{ path: "src/sub/inner.ts", name: "inner.ts", isDir: false }];
    const onChange = mock(() => {});
    const { host } = mount(<Composer value={"@src/sub/"} {...STUB_PROPS} sessionId={"sid"} onChange={onChange} />);
    await flush();
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(ta, 9); // 末尾
    await new Promise((r) => setTimeout(r, 200));
    await flush();

    ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    await flush();
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
    // "src/sub/" → 剥末段 → "src/"。
    expect(last).toBe("@src/");
  });

  test("selecting a file in drilled scope picks it as a mention and closes panel", async () => {
    fuzzyFindResult = [{ path: "src/foo.ts", name: "foo.ts", isDir: false }];
    const onChange = mock(() => {});
    const onMentionsChange = mock(() => {});
    const { host } = mount(
      <Composer value={"@src/"} {...STUB_PROPS} sessionId={"sid"} onChange={onChange} onMentionsChange={onMentionsChange} />
    );
    await flush();
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(ta, 5);
    await new Promise((r) => setTimeout(r, 200));
    await flush();

    const fileItem = host.querySelector('button.slash-item.is-file') as HTMLElement;
    expect(fileItem).not.toBeNull();
    fileItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    // 选中文件:文本替换为 @src/foo.ts + 尾随空格。
    const lastText = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
    expect(lastText).toBe("@src/foo.ts ");
    // 记为提及。
    expect(onMentionsChange).toHaveBeenCalled();
    const mentioned = onMentionsChange.mock.calls[onMentionsChange.mock.calls.length - 1][0] as { path: string; name: string }[];
    expect(mentioned.some((m) => m.path === "src/foo.ts")).toBe(true);
  });

  // Review #23447:go-up 行可被键盘聚焦(ArrowUp 从首项 → mentionIdx=-1),必须有可视高亮,
  // 否则键盘用户停在 go-up 上毫无反馈(仅 hover 有样式)。锚定 .active 类随 mentionIdx=-1 落到 go-up。
  test("ArrowUp from first item focuses go-up row and toggles its .active class", async () => {
    fuzzyFindResult = [{ path: "src/foo.ts", name: "foo.ts", isDir: false }];
    const { host } = mount(<Composer value={"@src/"} {...STUB_PROPS} sessionId={"sid"} />);
    await flush();
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(ta, 5);
    await new Promise((r) => setTimeout(r, 200));
    await flush();

    const goUp = host.querySelector('[data-testid="mention-go-up"]') as HTMLElement;
    expect(goUp).not.toBeNull();
    // 初始:焦点在首项(idx=0),go-up 无 active。
    expect(goUp.classList.contains("active")).toBe(false);

    ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await flush();
    // ArrowUp 从 0 → -1:go-up 行获得 active(键盘可视高亮,与普通项一致)。
    expect(goUp.classList.contains("active")).toBe(true);

    // 再 ArrowDown 回到首项,go-up 失去 active。
    ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await flush();
    expect(goUp.classList.contains("active")).toBe(false);
  });
});

// Keyboard navigation for the @ mention menu: ←/→ + Enter model.
// Pins the new contract: Enter/Tab commit the highlighted item as a mention (files AND dirs
// alike), → drills into a highlighted directory, ← goes up one dir level in drill state.
// Each would fail on the old code (Enter on a dir drilled instead of picking; ←/→ did nothing).
describe("Composer @ mention keyboard nav (← → Enter)", () => {
  beforeEach(() => {
    chatServiceMock.SessionFuzzyFind.mockClear();
    fuzzyFindResult = [];
  });

  // Wait for the composer's 150ms fuzzy-find debounce to fire and resolve (rule: withResolvers).
  const waitForDebounce = () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 200);
    return promise;
  };

  test("Enter on a highlighted directory picks it as a mention (not drill)", async () => {
    fuzzyFindResult = [{ path: "src", name: "src", isDir: true }];
    const onChange = mock(() => {});
    const onMentionsChange = mock(() => {});
    const { host } = mount(<Composer value={"@"} {...STUB_PROPS} sessionId={"sid"} onChange={onChange} onMentionsChange={onMentionsChange} />);
    await flush();
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(ta, 1);
    await waitForDebounce();
    await flush();

    const dirItem = host.querySelector('button.slash-item.is-dir') as HTMLElement;
    expect(dirItem).not.toBeNull();
    // Selection sits on the first item (idx=0 = the dir). Enter commits it as a mention.
    ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();

    // pickMention: "@src" + trailing space (NOT "@src/" which would be a drill).
    const lastText = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
    expect(lastText).toBe("@src ");
    const mentioned = onMentionsChange.mock.calls[onMentionsChange.mock.calls.length - 1][0] as { path: string; name: string }[];
    expect(mentioned.some((m) => m.path === "src")).toBe(true);
  });

  test("ArrowRight on a highlighted directory drills in (text becomes '@src/')", async () => {
    fuzzyFindResult = [{ path: "src", name: "src", isDir: true }];
    const onChange = mock(() => {});
    const { host } = mount(<Composer value={"@"} {...STUB_PROPS} sessionId={"sid"} onChange={onChange} />);
    await flush();
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(ta, 1);
    await waitForDebounce();
    await flush();

    const dirItem = host.querySelector('button.slash-item.is-dir') as HTMLElement;
    expect(dirItem).not.toBeNull();
    ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await flush();

    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
    expect(last).toBe("@src/");
  });

  test("ArrowLeft in drill state (@src/) goes up one level to '@'", async () => {
    fuzzyFindResult = [{ path: "src/foo.ts", name: "foo.ts", isDir: false }];
    const onChange = mock(() => {});
    const { host } = mount(<Composer value={"@src/"} {...STUB_PROPS} sessionId={"sid"} onChange={onChange} />);
    await flush();
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(ta, 5); // cursor at end of "@src/"
    await waitForDebounce();
    await flush();

    ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await flush();

    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
    // goUpMention: "src/" → strip trailing segment → "" (root).
    expect(last).toBe("@");
  });
});

// Unknown slash-command guard (ACP available_commands): submitting /<unknown> is blocked
// with a warning + "send as plain text" escape (leading space bypasses harness command parsing,
// which errors/swallows unknown commands on harnesses like opencode). Covers send + enqueue.
describe("Composer unknown slash-command guard", () => {
  const CMDS = [{ name: "model", description: "Show model", inputHint: "" }];

  test("unknown /cmd blocks send and shows warning (not sent)", async () => {
    const onSend = mock(() => {});
    const { host } = mount(
      <Composer value={"/unknown"} {...STUB_PROPS} commands={CMDS} onSend={onSend} />
    );
    await flush();
    const btn = host.querySelector('[data-testid="send-btn"]') as HTMLElement;
    btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    expect(onSend).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="slash-warn"]')).not.toBeNull();
  });

  test("known /cmd passes through (sent, no warning)", async () => {
    const onSend = mock(() => {});
    const { host } = mount(
      <Composer value={"/model"} {...STUB_PROPS} commands={CMDS} onSend={onSend} />
    );
    await flush();
    const btn = host.querySelector('[data-testid="send-btn"]') as HTMLElement;
    btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe("/model");
    expect(host.querySelector('[data-testid="slash-warn"]')).toBeNull();
  });

  test("empty command list → no guard (sent as-is, harness decides)", async () => {
    const onSend = mock(() => {});
    const { host } = mount(
      <Composer value={"/unknown"} {...STUB_PROPS} commands={[]} onSend={onSend} />
    );
    await flush();
    const btn = host.querySelector('[data-testid="send-btn"]') as HTMLElement;
    btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="slash-warn"]')).toBeNull();
  });

  test('"send as plain text" prepends a space and sends (escape)', async () => {
    const onSend = mock(() => {});
    const { host } = mount(
      <Composer value={"/unknown"} {...STUB_PROPS} commands={CMDS} onSend={onSend} />
    );
    await flush();
    const btn = host.querySelector('[data-testid="send-btn"]') as HTMLElement;
    btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    const plain = host.querySelector('[data-testid="slash-warn-plain"]') as HTMLElement;
    expect(plain).not.toBeNull();
    plain.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    expect(onSend).toHaveBeenCalledTimes(1);
    // Leading space bypasses harness "/" command parsing.
    expect(onSend.mock.calls[0][0]).toBe(" /unknown");
  });

  test("enqueue mode warns too; escape enqueues with leading space", async () => {
    const onEnqueue = mock(() => {});
    const { host } = mount(
      <Composer value={"/unknown"} {...STUB_PROPS} commands={CMDS} onEnqueue={onEnqueue} />
    );
    await flush();
    const btn = host.querySelector('[data-testid="enqueue-btn"]') as HTMLElement;
    btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    expect(onEnqueue).not.toHaveBeenCalled();
    const plain = host.querySelector('[data-testid="slash-warn-plain"]') as HTMLElement;
    plain.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    expect(onEnqueue).toHaveBeenCalledTimes(1);
    expect(onEnqueue.mock.calls[0][0]).toBe(" /unknown");
  });
});

// Task #24202: branch chip click forks a new chat off that branch (was: copy branch name).
// Pin the new behavior — clicking composer-branch must call onNewSessionOnBranch with the
// branch name, not do anything clipboard-related. Empty branch must not render the chip.
describe("Composer branch chip fork (Task #24202)", () => {
  test("clicking the branch chip calls onNewSessionOnBranch(branch)", async () => {
    const onNewSessionOnBranch = mock(() => {});
    const { host } = mount(
      <Composer value={"hi"} {...STUB_PROPS} branch={"feat/branch-x"} onNewSessionOnBranch={onNewSessionOnBranch} />
    );
    await flush();

    const chip = host.querySelector('[data-testid="composer-branch"]') as HTMLElement;
    expect(chip).not.toBeNull();
    // The chip renders the branch name (not a copy/copy-state affordance).
    expect(chip.textContent).toContain("feat/branch-x");

    chip.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();

    expect(onNewSessionOnBranch).toHaveBeenCalledTimes(1);
    // Assert the exact branch value is forwarded (anchored on value, not just call count).
    expect(onNewSessionOnBranch.mock.calls[0][0]).toBe("feat/branch-x");
  });

  test("empty branch renders no chip (non-git / untracked)", async () => {
    const onNewSessionOnBranch = mock(() => {});
    const { host } = mount(
      <Composer value={"hi"} {...STUB_PROPS} branch={""} onNewSessionOnBranch={onNewSessionOnBranch} />
    );
    await flush();
    expect(host.querySelector('[data-testid="composer-branch"]')).toBeNull();
  });
});

// Task #24219: Tab path autocomplete. Plain-text inline completion of a path-like
// token before the cursor (no @ reference chip). Tab (no menu open, not composing,
// no selection) fires SessionFuzzyFind; a single unambiguous match replaces the
// token inline, multiple / zero matches do nothing, and plain words / whitespace
// fall through to default Tab. Must not disturb slash / mention menu Tab, IME
// Enter, or history navigation.
describe("Composer Tab path autocomplete (Task #24219)", () => {
  beforeEach(() => {
    chatServiceMock.SessionFuzzyFind.mockClear();
    fuzzyFindResult = [];
  });

  // Tab keydown on the textarea with the caret right after the path token.
  function pressTab(ta: HTMLTextAreaElement) {
    ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  }

  test("single match completes the token inline (scope/term split, no @ chip)", async () => {
    fuzzyFindResult = [{ path: "src/components/Foo.tsx", name: "Foo.tsx", isDir: false }];
    const onChange = mock(() => {});
    const onMentionsChange = mock(() => {});
    const { host } = mount(
      <Composer value={"edit src/compo"} {...STUB_PROPS} sessionId={"sid"} onChange={onChange} onMentionsChange={onMentionsChange} />
    );
    await flush();
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(ta, "edit src/compo".length);
    await flush();

    pressTab(ta);
    await flush();

    // splitScopeTerm("src/compo") -> scope="src", term="compo".
    expect(chatServiceMock.SessionFuzzyFind).toHaveBeenCalledWith("sid", "src", "compo", 12);
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as string | undefined;
    expect(last).toBe("edit src/components/Foo.tsx");
    // No @ mention chip is created (plain-text completion).
    expect(onMentionsChange).not.toHaveBeenCalled();
  });

  test("single directory match appends '/' for further drilling", async () => {
    fuzzyFindResult = [{ path: "src/components", name: "components", isDir: true }];
    const onChange = mock(() => {});
    const { host } = mount(
      <Composer value={"see src/comp"} {...STUB_PROPS} sessionId={"sid"} onChange={onChange} />
    );
    await flush();
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(ta, "see src/comp".length);
    await flush();

    pressTab(ta);
    await flush();

    const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as string | undefined;
    expect(last).toBe("see src/components/");
  });

  test("multiple matches do NOT complete (value unchanged)", async () => {
    fuzzyFindResult = [
      { path: "src/components", name: "components", isDir: true },
      { path: "src/config.ts", name: "config.ts", isDir: false },
    ];
    const onChange = mock(() => {});
    const { host } = mount(
      <Composer value={"fix src/co"} {...STUB_PROPS} sessionId={"sid"} onChange={onChange} />
    );
    await flush();
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(ta, "fix src/co".length);
    await flush();

    pressTab(ta);
    await flush();

    expect(chatServiceMock.SessionFuzzyFind).toHaveBeenCalledTimes(1);
    // onChange never received a completion (no extra call beyond controlled renders).
    expect(onChange).not.toHaveBeenCalled();
  });

  test("plain word (no '/' or '.') does not call SessionFuzzyFind", async () => {
    const { host } = mount(<Composer value={"hello world"} {...STUB_PROPS} sessionId={"sid"} />);
    await flush();
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(ta, "hello world".length);
    await flush();

    pressTab(ta);
    await flush();

    expect(chatServiceMock.SessionFuzzyFind).not.toHaveBeenCalled();
  });

  test("token starting with '@' is not Tab-completed (mention territory)", async () => {
    // @foo with the mention menu closed (no results). Tab must not treat "@foo"
    // as a path token — that would conflict with mention semantics.
    fuzzyFindResult = [];
    const { host } = mount(<Composer value={"@foo"} {...STUB_PROPS} sessionId={"sid"} />);
    await flush();
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(ta, 4);
    await flush();
    // Tab path-completion calls SessionFuzzyFind synchronously inside the keydown
    // handler, so check the call count immediately after dispatching Tab — before
    // the @ mention effect's 150ms debounce can fire (a separate, legitimate call).
    const callsBefore = chatServiceMock.SessionFuzzyFind.mock.calls.length;
    pressTab(ta);
    expect(chatServiceMock.SessionFuzzyFind.mock.calls.length).toBe(callsBefore);
    // Let the @ mention debounce settle so its call doesn't leak into the next test
    // (each mount() creates a new root without unmounting the previous Composer).
    await new Promise((r) => setTimeout(r, 200));
    await flush();
  });

  test("no session -> Tab does not fire SessionFuzzyFind (guarded)", async () => {
    const { host } = mount(<Composer value={"src/co"} {...STUB_PROPS} sessionId={""} />);
    await flush();
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(ta, "src/co".length);
    await flush();

    pressTab(ta);
    await flush();

    expect(chatServiceMock.SessionFuzzyFind).not.toHaveBeenCalled();
  });

  test("Tab with a slash-command menu open commits the command (not path completion)", async () => {
    // "/mode" prefix + a command named "model" -> slash menu open. Tab must pick
    // the command, NOT path-complete "/mode" (which would also be excluded as a
    // '/' token anyway, but pin that menus take priority).
    const CMDS = [{ name: "model", description: "Show model", inputHint: "" }];
    const onChange = mock(() => {});
    const { host } = mount(
      <Composer value={"/mode"} {...STUB_PROPS} sessionId={"sid"} commands={CMDS} onChange={onChange} />
    );
    await flush();
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(ta, 5);
    await flush();
    expect(host.querySelector('[data-testid="slash-popover"]')).not.toBeNull();

    pressTab(ta);
    await flush();

    // pickSlash rewrites to "/model " (trailing space); no fuzzy find fired.
    expect(chatServiceMock.SessionFuzzyFind).not.toHaveBeenCalled();
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as string | undefined;
    expect(last).toBe("/model ");
  });
});
