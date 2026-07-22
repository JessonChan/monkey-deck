// 端到端验收(Task #22124 Review #43):harness 更新感知(定时检查 ticker 已由后端单测覆盖;
// 此处覆盖前端可观测行为)——「自动检查开关」绑定后端 + 设置内 harness 菜单红点。
//
// 防的失败模式(Reviewer 职责):「组件渲染了但没真正接上后端」——开关看上去在,点上去不调
// SetCheckHarnessUpdates;红点的 className 加了但条件渲染写反。这里挂载真实组件 + mock 后端
// binding,断言:
//   1. HarnessPane mount 时调 GetCheckHarnessUpdates 拉当前值,开关 aria-checked 反映该值。
//   2. 点开关 → 调 SetCheckHarnessUpdates(翻转值);后端报错时 UI 回滚。
//   3. SettingsPanel 在 harnessUpdateAvailable=true 时,models 分类导航项渲染 .update-dot;
//      false 时不渲染(条件渲染方向正确)。
//
// 后端「定时检查」由 internal/chat/harness_test.go 的 TestHarnessRefreshTicker_RunsPeriodically
// 守卫(断言 ticker 真的周期触发且关掉后停),此处不重复。

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
globalThis.localStorage = window.localStorage;
window.React = React;

// ---- mock 后端 chat binding:可观测 + 可控的桩 ----
// 用可变 holder 让单测按需决定 GetCheckHarnessUpdates 的返回值与 Set 的副作用 / 失败。
const harnessState = { autoCheck: true, setFails: false };
const calls: { fn: string; arg?: boolean }[] = [];
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => ({
  GetCheckHarnessUpdates: async () => {
    calls.push({ fn: "GetCheckHarnessUpdates" });
    return harnessState.autoCheck;
  },
  SetCheckHarnessUpdates: async (on: boolean) => {
    calls.push({ fn: "SetCheckHarnessUpdates", arg: on });
    if (harnessState.setFails) throw new Error("boom");
    harnessState.autoCheck = on;
  },
  ListHarnesses: async () => [],
  RefreshHarnesses: async () => [],
  UpgradeHarness: async () => [],
}));
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: "3rd-party" },
  default: { useTranslation: () => ({ t: (k: string) => k }) },
}));

const { default: HarnessPane } = await import("./HarnessSettings.tsx");
const { default: SettingsPanel } = await import("./SettingsPanel.tsx");

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

describe("HarnessPane 自动检查开关 绑定后端", () => {
  test("mount 拉 GetCheckHarnessUpdates,开关 aria-checked 反映后端值(true)", async () => {
    calls.length = 0;
    harnessState.autoCheck = true;
    const { host } = mount(<HarnessPane />);
    await flush();
    expect(calls.some((c) => c.fn === "GetCheckHarnessUpdates")).toBe(true);
    const sw = host.querySelector('[data-testid="harness-autocheck"]') as HTMLElement;
    expect(sw).not.toBeNull();
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  test("点开关 → 调 SetCheckHarnessUpdates(翻转值),aria-checked 翻转", async () => {
    calls.length = 0;
    harnessState.autoCheck = true;
    const { host } = mount(<HarnessPane />);
    await flush();
    const sw = host.querySelector('[data-testid="harness-autocheck"]') as HTMLElement;
    expect(sw.getAttribute("aria-checked")).toBe("true");
    sw.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    // 必须真正调到后端,且传入翻转后的 false(防「渲染了但不接后端」)。
    expect(calls).toContainEqual({ fn: "SetCheckHarnessUpdates", arg: false });
    const sw2 = host.querySelector('[data-testid="harness-autocheck"]') as HTMLElement;
    expect(sw2.getAttribute("aria-checked")).toBe("false");
  });

  test("SetCheckHarnessUpdates 报错 → UI 回滚到原值", async () => {
    calls.length = 0;
    harnessState.autoCheck = true;
    harnessState.setFails = true; // 后端 Set 抛错
    const { host } = mount(<HarnessPane />);
    await flush();
    const sw = host.querySelector('[data-testid="harness-autocheck"]') as HTMLElement;
    expect(sw.getAttribute("aria-checked")).toBe("true");
    sw.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    // 翻转尝试过(false),但后端失败 → catch 块回滚 UI 回 true。
    expect(calls).toContainEqual({ fn: "SetCheckHarnessUpdates", arg: false });
    const sw2 = host.querySelector('[data-testid="harness-autocheck"]') as HTMLElement;
    expect(sw2.getAttribute("aria-checked")).toBe("true");
    harnessState.setFails = false; // 复位,避免污染后续用例
  });
});

describe("SettingsPanel harness 菜单红点(条件渲染方向)", () => {
  test("harnessUpdateAvailable=true → models 分类导航项渲染 .update-dot", async () => {
    const { host } = mount(
      <SettingsPanel onClose={() => {}} initialCategory="general" harnessUpdateAvailable={true} />,
    );
    await flush();
    const modelsNav = host.querySelector('[data-testid="settings-cat-models"]') as HTMLElement;
    expect(modelsNav).not.toBeNull();
    expect(modelsNav.querySelector(".update-dot")).not.toBeNull();
    // 非 models 分类不应有红点(dot = c.id === "models" && ...)。
    const generalNav = host.querySelector('[data-testid="settings-cat-general"]') as HTMLElement;
    expect(generalNav.querySelector(".update-dot")).toBeNull();
  });

  test("harnessUpdateAvailable=false → models 分类导航项无 .update-dot", async () => {
    const { host } = mount(
      <SettingsPanel onClose={() => {}} initialCategory="general" harnessUpdateAvailable={false} />,
    );
    await flush();
    const modelsNav = host.querySelector('[data-testid="settings-cat-models"]') as HTMLElement;
    expect(modelsNav).not.toBeNull();
    expect(modelsNav.querySelector(".update-dot")).toBeNull();
  });
});
