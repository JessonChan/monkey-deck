// Mount-test for markdown table column resizing (#140): every GFM <thead><th>
// gains a drag grip; dragging commits a px width onto that column's cells;
// widths are remembered per chat SESSION (module map) and re-stamped when the
// message tree remounts; double-click restores auto sizing; a touch contact
// never starts a drag (mobile-disable layer 2; layers 1/3 are module flag +
// CSS media query and need a real device/webview to observe).
//
// Structural contract here; visual cursor/bar affordances live in index.css
// (.md-col-grip rules) and need a real webview to judge.
//
// Same recipe as ChatView.table.mount.test.tsx: happy-dom + real React tree +
// real react-markdown pipeline, geometry mocks for the virtualizer, bindings
// stubbed (no backend calls at mount).

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
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.localStorage = window.localStorage;
window.React = React;

// ---- geometry mocks (same shape as the table/virtual-mount tests) ----
const mockRowH = 100;
Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    if (this.classList?.contains("cv-item")) return mockRowH;
    return 0;
  },
});
Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.classList?.contains("chat-body") ? 600 : 0;
  },
});

class MockResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(_el: Element) {}
  unobserve(_el: Element) {}
  disconnect() {}
}
(globalThis as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;

// ---- binding / i18n / tooltip mocks (nothing touches the backend at mount) ----
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => ({
  ToggleMaximise: async () => {},
  OpenURL: async () => {},
  SessionReadFile: async () => "",
  SessionListDir: async () => [],
  SessionFuzzyFind: async () => [],
  PickFiles: async () => [],
  GetSessionMcpServers: async () => [],
}));
mock.module("react-tooltip", () => ({ Tooltip: () => null, default: () => null }));
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: "3rd-party" },
  default: { useTranslation: () => ({ t: (k: string) => k }) },
}));

// Import after mocks (dynamic literal import, same reason as the table test).
const { default: ChatView } = await import("./ChatView.tsx");
import type { ChatItem } from "../types";

// Per-test-distinct header labels double as width-store keys: the module-level
// store outlives individual mounts, so isolation comes from content, not setup.
const MD_A = ["| Alpha | Beta |", "| --- | --- |", "| a1 | b1 |", "| a2 | b2 |"].join("\n");
const MD_B = ["| Gamma | Delta |", "| --- | --- |", "| g1 | d1 |"].join("\n");
const MD_RESET = ["| Reset | Other |", "| --- | --- |", "| r1 | o1 |"].join("\n");
const MD_TOUCH = ["| Touchme | Still |", "| --- | --- |", "| t1 | s1 |"].join("\n");

function baseProps(items: ChatItem[]) {
  return {
    project: null,
    session: { id: "s1" },
    items,
    status: "idle",
    statusDetail: "",
    usage: { used: 0, size: 0, cost: 0, cachedReadTokens: 0, cachedWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
    error: null,
    permission: null,
    mergeResult: null,
    onSend: () => {},
    onEnqueue: () => {},
    onStop: () => {},
    onContinue: () => {},
    onRespondPermission: () => {},
    onToggleTerminal: () => {},
    onRefreshConfig: () => {},
    onMerge: () => {},
    queue: [],
    onInterruptQueue: () => {},
    onRevokeQueue: () => {},
    onEditQueue: () => {},
    onScheduleQueue: () => {},
    onReorderQueue: () => {},
    composerValue: "",
    onComposerChange: () => {},
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
    history: [],
    sessionId: "s1",
    configOptions: [],
    branch: "",
    livePlan: null,
    onSetConfig: () => {},
    hasMore: false,
    loadingMore: false,
    onLoadMore: () => {},
  };
}

function mount(items: ChatItem[]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<ChatView {...(baseProps(items) as never)} />);
  return { host, root };
}

async function flush() {
  // happy-dom + React 19 need several ticks to finish commit + passive effects.
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 2));
}

// Fire a real bubbling PointerEvent on el. React delegates pointerdown to its
// root; the resizer's pointermove/up listeners sit natively on window, which
// bubbling reaches too. happy-dom reports 0px rects (no layout), so the
// component's MIN-width fallback makes drags deterministic: start 48,
// end = clamp(48 + dx). MouseEvent cannot carry pointerType — the dedicated
// constructor can.
function firePointer(el: Element, type: string, x: number, pointerType = "mouse") {
  el.dispatchEvent(
    new (window as unknown as { PointerEvent: new (type: string, init?: Record<string, unknown>) => Event }).PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      pointerType,
    })
  );
}

async function dragGrip(grip: Element, dx: number) {
  // Two move samples ending exactly at target: a real gesture streams moves
  // continuously and the commit takes the LAST one — firing up straight from
  // down would misrepresent it just as skipping input would.
  const x0 = 100;
  firePointer(grip, "pointerdown", x0);
  firePointer(grip, "pointermove", x0 + Math.round(dx / 2));
  firePointer(grip, "pointermove", x0 + dx);
  firePointer(grip, "pointerup", x0 + dx);
  await flush();
}

describe("markdown table resize (#140)", () => {
  test("every header cell grows a grip; wrap skeleton intact", async () => {
    const { host, root } = mount([{ type: "agent", id: "a1", text: MD_A }]);
    await flush();

    const wrap = host.querySelector(".bubble-agent .md-table-wrap");
    expect(wrap).not.toBeNull();
    const table = wrap!.querySelector("table");
    expect(table).not.toBeNull();
    // One grip per header cell.
    expect(table!.querySelectorAll("thead th").length).toBe(2);
    expect(table!.querySelectorAll('[data-testid="md-col-grip"]').length).toBe(2);
    // Grip rides inside its own th (position:relative anchor in CSS).
    for (const grip of table!.querySelectorAll('[data-testid="md-col-grip"]')) {
      expect(grip.parentElement!.tagName).toBe("TH");
    }
    void root.unmount;
    root.unmount();
  });

  test("drag commits clamped px width onto the whole column", async () => {
    const { host, root } = mount([{ type: "agent", id: "a1", text: MD_A }]);
    await flush();

    const table = host.querySelector(".md-table-wrap table")!;
    const th0 = table.querySelector("thead th")!;
    const grips = table.querySelectorAll('[data-testid="md-col-grip"]');
    await dragGrip(grips[0], 100); // start falls back to MIN 48 → 148

    expect(th0.getAttribute("style")).toContain("148px");
    // Whole-column stamping: body cells of column 0 carry it too; column 1 untouched.
    const bodyCols = Array.from(table.querySelectorAll("tbody tr")).map(
      (tr) => (tr as HTMLTableRowElement).cells[0]
    );
    for (const cell of bodyCols) expect(cell.getAttribute("style")).toContain("148px");
    expect(table.querySelector("thead th:nth-child(2)")!.getAttribute("style")).toBeNull();

    root.unmount();
  });

  test("widths survive remount within the same session (in-session memory)", async () => {
    const first = mount([{ type: "agent", id: "a1", text: MD_B }]);
    await flush();
    const gripsA = first.host.querySelectorAll('[data-testid="md-col-grip"]');
    await dragGrip(gripsA[1], -20); // shrink below min → clamps to 48

    first.root.unmount();
    await flush();

    // Fresh mount, same session id, identical header signature → re-stamped.
    const second = mount([{ type: "agent", id: "b1", text: MD_B }]);
    await flush();
    const table = second.host.querySelector(".md-table-wrap table")!;
    const col1 = Array.from(table.querySelectorAll("tr")).map((tr) => (tr as HTMLTableRowElement).cells[1]);
    for (const cell of col1) expect(cell.getAttribute("style")).toContain("48px");
    second.root.unmount();
  });

  test("double-click resets the column and drops the stored entry when empty", async () => {
    const { host, root } = mount([{ type: "agent", id: "a1", text: MD_RESET }]);
    await flush();

    const table = host.querySelector(".md-table-wrap table")!;
    const grip = table.querySelector('[data-testid="md-col-grip"]')!;
    await dragGrip(grip, 80);
    expect(table.querySelector("thead th")!.getAttribute("style")).toContain("128px");
    firePointer(grip, "dblclick", 100);
    await flush();
    // Column back to auto: no inline width anywhere in column 0.
    for (const cell of Array.from(table.querySelectorAll("tr"))) {
      // A reset cell carries NO style attribute at all — null is the win state.
      const style = (cell as HTMLTableRowElement).cells[0].getAttribute("style") ?? "";
      expect(style).not.toContain("width");
    }

    root.unmount();
  });
  test("touch contact never starts a drag (mobile layer 2)", async () => {
    const { host, root } = mount([{ type: "agent", id: "a1", text: MD_TOUCH }]);
    await flush();

    const table = host.querySelector(".md-table-wrap table")!;
    const grip = table.querySelector('[data-testid="md-col-grip"]')!;

    firePointer(grip, "pointerdown", 100, "touch");
    firePointer(grip, "pointermove", 200, "touch");
    firePointer(grip, "pointerup", 200, "touch");
    await flush();

    for (const cell of Array.from(table.querySelectorAll("tr"))) {
      expect((cell as HTMLTableRowElement).cells[0].getAttribute("style")).toBeNull();
    }
    root.unmount();
  });
});
