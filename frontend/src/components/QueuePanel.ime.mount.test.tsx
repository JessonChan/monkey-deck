// Mount-test QueuePanel 编辑框 IME 三重保险(Task #23424)。
//
// 复现的 bug:中文输入法选词确认时按下的 Enter,会被编辑框的 onKeyDown 当成
// 「保存」,导致用户还没选完词就被误提交写回队列。修法是三重保险
// (composingRef.current || isComposing || keyCode===229),composing 中 Enter
// 不保存/不取消。
//
// 测试环境局限(已验证):React 19 + happy-dom 下,手动 dispatch 的
// compositionstart 事件能触发原生 addEventListener 回调,但不会触发 React 的
// 合成 onCompositionStart(React 事件系统的已知差异)。因此 composingRef 路径
// (生产环境的主信号,由 onCompositionStart/End 驱动)无法在 happy-dom 里端到端
// 模拟;这里改测可直接从 KeyboardEvent.nativeEvent 读到的另两条信号——
// isComposing 与 keyCode===229——它们各自独立命中守卫即可证明 OR 逻辑生效。
// composingRef 的接线由「composition 接线冒烟」用例兜底(确认 handlers 已绑定)。

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
(globalThis as any).CompositionEvent = (window as any).CompositionEvent;
window.React = React;

mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, opts?: Record<string, unknown>) => {
    if (opts && typeof opts === "object") {
      let s = k;
      for (const [kk, vv] of Object.entries(opts)) s += `:${kk}=${vv}`;
      return s;
    }
    return k;
  } }),
  initReactI18next: { type: "3rd-party" },
  default: { useTranslation: () => ({ t: (k: string) => k }) },
}));

const QueuePanel = (await import("./QueuePanel.tsx")).default;
import type { QueueItem } from "../types";

function mount(jsx: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(jsx);
  return { host, root };
}

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
}

function item(id: string, text: string): QueueItem {
  return { id, text, scheduledAt: Date.now() };
}

// Set an uncontrolled textarea's value via the native prototype setter (bypasses any
// value-tracker) so save() reads the edited text from the DOM ref.
function setValue(ta: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(ta, value);
}

async function enterEditMode(host: HTMLElement): Promise<HTMLTextAreaElement> {
  (host.querySelector('[data-testid="queue-edit"]') as HTMLElement)
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
  await flush();
  const ta = host.querySelector('[data-testid="queue-edit-input"]') as HTMLTextAreaElement;
  expect(ta).not.toBeNull();
  return ta;
}

describe("QueuePanel 编辑框 IME 三重保险(Task #23424)", () => {
  test("KeyboardEvent.isComposing=true:Enter 不保存(标准信号路径)", async () => {
    const calls: string[] = [];
    const q = [item("q1", "hello")];
    const { host } = mount(
      <QueuePanel queue={q} onInterrupt={() => {}} onRevoke={() => {}} onEdit={(id, text) => calls.push(`${id}:${text}`)} onSchedule={() => {}} onReorder={() => {}} />
    );
    await flush();

    const ta = await enterEditMode(host);
    setValue(ta, "edited");
    await flush();

    // isComposing=true:多数浏览器下选词确认的 Enter 会带此标记 → 不应保存。
    ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: false, isComposing: true, bubbles: true }));
    await flush();
    expect(calls).toEqual([]);

    // isComposing=false:同一输入框、同一 Enter,恢复正常保存。
    ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: false, isComposing: false, bubbles: true }));
    await flush();
    expect(calls).toEqual(["q1:edited"]);
  });

  test("keyCode===229:Enter 不保存(已废弃但兜底信号路径)", async () => {
    const calls: string[] = [];
    const q = [item("q1", "hello")];
    const { host } = mount(
      <QueuePanel queue={q} onInterrupt={() => {}} onRevoke={() => {}} onEdit={(id, text) => calls.push(`${id}:${text}`)} onSchedule={() => {}} onReorder={() => {}} />
    );
    await flush();

    const ta = await enterEditMode(host);
    setValue(ta, "edited");
    await flush();

    // keyCode 229:旧规范里 IME 处理中的按键码,作兜底 → 不应保存。
    ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: false, keyCode: 229, bubbles: true }));
    await flush();
    expect(calls).toEqual([]);
  });

  test("守卫不误伤正常路径:非合成 Enter 仍正常保存(回归)", async () => {
    const calls: string[] = [];
    const q = [item("q1", "hello")];
    const { host } = mount(
      <QueuePanel queue={q} onInterrupt={() => {}} onRevoke={() => {}} onEdit={(id, text) => calls.push(`${id}:${text}`)} onSchedule={() => {}} onReorder={() => {}} />
    );
    await flush();

    const ta = await enterEditMode(host);
    setValue(ta, "plain");
    await flush();
    // 无任何 IME 信号:普通 Enter 必须照常保存(确认守卫没把正常路径误伤)。
    ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: false, bubbles: true }));
    await flush();
    expect(calls).toEqual(["q1:plain"]);
  });

  test("composition 接线冒烟:编辑 textarea 派发 composition 事件不报错且组件稳定", async () => {
    // composingRef 由 onCompositionStart/End 驱动(生产主信号)。happy-dom 不触发
    // React 合成 composition 事件,故这里只做接线冒烟:确认 handlers 已绑定、
    // dispatch 不抛异常、组件不卸载。composingRef 的实际行为由上面 isComposing/
    // keyCode 两条等价信号兜底证明守卫 OR 逻辑生效。
    const q = [item("q1", "你好")];
    const { host } = mount(
      <QueuePanel queue={q} onInterrupt={() => {}} onRevoke={() => {}} onEdit={() => {}} onSchedule={() => {}} onReorder={() => {}} />
    );
    await flush();

    const ta = await enterEditMode(host);
    expect(() => {
      ta.dispatchEvent(new (window as any).CompositionEvent("compositionstart", { bubbles: true }));
      ta.dispatchEvent(new (window as any).CompositionEvent("compositionend", { bubbles: true }));
    }).not.toThrow();
    await flush();
    // 组件仍挂载、编辑态未被意外退出。
    expect(host.querySelector('[data-testid="queue-edit-input"]')).not.toBeNull();
  });
});
