// Mount-test FileTabBar (model A + placement A1) in the repo's idiom:
// happy-dom + react-dom createRoot, no @testing-library/react (not a dep).
//
// Invariants pinned here:
//  - Renders nothing when there are no tabs (the row only appears with >=1 tab).
//  - Chat tab is always first and has no close affordance (pinned, not closeable).
//  - A tab's identity is tabKey(tab), not its path: file tabs key as `file:<path>`,
//    diff tabs as `diff:s:<path>` / `diff:u:<path>` — so a path open as both a
//    content tab and a staged/unstaged diff stays three distinct tabs.
//  - Clicking a tab calls onActivate(tabKey); clicking Chat calls onActivate("chat").
//  - Close button calls onCloseFile(tabKey) without activating the tab.

import { describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import FileTabBar, { type FileTab, tabKey } from "./FileTabBar";

// ---- happy-dom setup ----
const win = new Window();
const doc = win.document;
(globalThis as Record<string, unknown>).window = win;
(globalThis as Record<string, unknown>).document = doc;
(globalThis as Record<string, unknown>).navigator = win.navigator;
(globalThis as Record<string, unknown>).getComputedStyle = win.getComputedStyle.bind(win);
(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(performance.now()), 0);
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);
(globalThis as Record<string, unknown>).MouseEvent = win.MouseEvent;
win.React = React;

// react-i18next: FileTabBar calls useTranslation(); return keys verbatim.
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const delay = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};
// React 19 + happy-dom needs several ticks to complete commit + passive effects.
async function flush() {
  for (let i = 0; i < 10; i++) await delay(2);
}

function render(node: React.ReactNode): { container: HTMLElement; root: Root } {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container);
  root.render(node);
  return { container, root };
}

describe("FileTabBar", () => {
  test("renders nothing when there are no tabs", async () => {
    const { container, root } = render(
      <FileTabBar tabs={[]} activeKey="chat" onActivate={() => {}} onCloseFile={() => {}} />,
    );
    await flush();
    expect(container.firstChild).toBeNull();
    const bar = container.querySelector('[data-testid="file-tabbar"]');
    expect(bar).toBeNull();
    root.unmount();
  });

  test("renders Chat tab first + file tabs; Chat tab has no close button", async () => {
    const tabs: FileTab[] = [
      { kind: "file", path: "runner.go" },
      { kind: "file", path: "proc.go", line: 42 },
    ];
    const { container, root } = render(
      <FileTabBar tabs={tabs} activeKey="chat" onActivate={() => {}} onCloseFile={() => {}} />,
    );
    await flush();
    const bar = container.querySelector('[data-testid="file-tabbar"]');
    expect(bar).not.toBeNull();
    const chat = container.querySelector('[data-testid="file-tab-chat"]');
    expect(chat).not.toBeNull();
    // Chat tab must not expose a close affordance (pinned, not closeable).
    expect(chat!.querySelector(".file-tab-close")).toBeNull();
    expect(container.querySelector(`[data-testid="file-tab-${tabKey(tabs[0])}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-testid="file-tab-${tabKey(tabs[1])}"]`)).not.toBeNull();
    root.unmount();
  });

  test("clicking a file tab activates it via tabKey; clicking Chat activates 'chat'", async () => {
    const tabs: FileTab[] = [{ kind: "file", path: "a.go" }];
    const activated: string[] = [];
    const { container, root } = render(
      <FileTabBar
        tabs={tabs}
        activeKey={tabKey(tabs[0])}
        onActivate={(k) => activated.push(k)}
        onCloseFile={() => {}}
      />,
    );
    await flush();
    (container.querySelector('[data-testid="file-tab-chat"]') as HTMLElement).click();
    (container.querySelector(`[data-testid="file-tab-${tabKey(tabs[0])}"]`) as HTMLElement).click();
    expect(activated).toEqual(["chat", tabKey(tabs[0])]);
    root.unmount();
  });

  test("close button calls onCloseFile(tabKey) and does not activate the tab", async () => {
    const tabs: FileTab[] = [{ kind: "file", path: "a.go" }, { kind: "file", path: "b.go" }];
    const closed: string[] = [];
    const activated: string[] = [];
    const { container, root } = render(
      <FileTabBar
        tabs={tabs}
        activeKey={tabKey(tabs[0])}
        onActivate={(k) => activated.push(k)}
        onCloseFile={(p) => closed.push(p)}
      />,
    );
    await flush();
    const aTab = container.querySelector(`[data-testid="file-tab-${tabKey(tabs[0])}"]`)!;
    const closeBtn = aTab.querySelector(".file-tab-close") as HTMLElement;
    expect(closeBtn).not.toBeNull();
    closeBtn.click();
    expect(closed).toEqual([tabKey(tabs[0])]);
    expect(activated).toEqual([]);
    root.unmount();
  });

  test("diff tabs of the same path stay distinct (staged vs unstaged) and activate by tabKey", async () => {
    const tabs: FileTab[] = [
      { kind: "file", path: "a.go" },
      { kind: "diff", path: "a.go", staged: true },
      { kind: "diff", path: "a.go", staged: false },
    ];
    // Three distinct keys for the same path.
    const keys = new Set(tabs.map(tabKey));
    expect(keys.size).toBe(3);
    expect(tabKey(tabs[1])).toBe("diff:s:a.go");
    expect(tabKey(tabs[2])).toBe("diff:u:a.go");

    const activated: string[] = [];
    const { container, root } = render(
      <FileTabBar tabs={tabs} activeKey="chat" onActivate={(k) => activated.push(k)} onCloseFile={() => {}} />,
    );
    await flush();
    // All three render as separate tabs.
    for (const tb of tabs) {
      expect(container.querySelector(`[data-testid="file-tab-${tabKey(tb)}"]`)).not.toBeNull();
    }
    (container.querySelector('[data-testid="file-tab-diff:s:a.go"]') as HTMLElement).click();
    (container.querySelector('[data-testid="file-tab-diff:u:a.go"]') as HTMLElement).click();
    expect(activated).toEqual(["diff:s:a.go", "diff:u:a.go"]);
    root.unmount();
  });
});
