// 端到端验收:harness 更新感知 + 自动升级(定时检查 ticker 已由后端单测覆盖;此处覆盖前端可观测行为)。
//
// 防的失败模式(Reviewer 职责):「组件渲染了但没真正接上后端」——开关看上去在,点上去不调
// SetCheckHarnessUpdates / SetAutoHarnessUpgrade;红点的 className 加了但条件渲染写反。这里挂载
// 真实组件 + mock 后端 binding,断言:
//   1. HarnessPane mount 时调 GetConfig 拉当前值,两开关 aria-checked 反映 GetConfig 字段
//      (checkHarnessUpdates / autoHarnessUpgrade)。
//   2. 点「自动检查」开关 → 调 SetCheckHarnessUpdates(翻转值);后端报错时 UI 回滚。
//   3. 点「自动升级」子开关 → 调 SetAutoHarnessUpgrade(翻转值);后端报错时 UI 回滚。
//   4. SettingsPanel 在 harnessUpdateAvailable=true 时,models 分类导航项渲染 .update-dot;
//      false 时不渲染(条件渲染方向正确)。
//   5. 自动升级行带风险 tooltip(data-tooltip-content = autoUpgradeRiskTip)。
//
// 后端「定时检查 / 自动升级」由 internal/chat/harness_test.go 与 auto_upgrade_test.go 守卫,
// 此处不重复。

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
// 用可变 holder 让单测按需决定 GetConfig 的返回值与各 setter 的副作用 / 失败。
// GetConfig 是后端聚合只读快照(checkHarnessUpdates / autoHarnessUpgrade 等字符串字段,Task #22385 已暴露 autoHarnessUpgrade)。
const harnessState = {
  autoCheck: true,
  autoUpgrade: false,
  setCheckFails: false,
  setUpgradeFails: false,
};
const calls: { fn: string; arg?: boolean }[] = [];
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => ({
  GetConfig: async () => {
    calls.push({ fn: "GetConfig" });
    return {
      checkHarnessUpdates: String(harnessState.autoCheck),
      autoHarnessUpgrade: String(harnessState.autoUpgrade),
    };
  },
  SetCheckHarnessUpdates: async (on: boolean) => {
    calls.push({ fn: "SetCheckHarnessUpdates", arg: on });
    if (harnessState.setCheckFails) throw new Error("boom");
    harnessState.autoCheck = on;
  },
  SetAutoHarnessUpgrade: async (on: boolean) => {
    calls.push({ fn: "SetAutoHarnessUpgrade", arg: on });
    if (harnessState.setUpgradeFails) throw new Error("boom");
    harnessState.autoUpgrade = on;
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

describe("HarnessPane 开关初值经 GetConfig 接线", () => {
  test("mount 调 GetConfig,两开关 aria-checked 反映 GetConfig 字段(check=true / upgrade=false)", async () => {
    calls.length = 0;
    harnessState.autoCheck = true;
    harnessState.autoUpgrade = false;
    const { host } = mount(<HarnessPane />);
    await flush();
    expect(calls.some((c) => c.fn === "GetConfig")).toBe(true);
    const sw = host.querySelector('[data-testid="harness-autocheck"]') as HTMLElement;
    expect(sw).not.toBeNull();
    expect(sw.getAttribute("aria-checked")).toBe("true");
    const up = host.querySelector('[data-testid="harness-autoupgrade"]') as HTMLElement;
    expect(up).not.toBeNull();
    expect(up.getAttribute("aria-checked")).toBe("false");
  });

  test("GetConfig 报告 autoUpgrade=true → 子开关 aria-checked=true", async () => {
    harnessState.autoUpgrade = true;
    const { host } = mount(<HarnessPane />);
    await flush();
    const up = host.querySelector('[data-testid="harness-autoupgrade"]') as HTMLElement;
    expect(up.getAttribute("aria-checked")).toBe("true");
    harnessState.autoUpgrade = false; // 复位
  });
});

describe("HarnessPane 「自动检查」开关 绑定后端", () => {
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
    harnessState.setCheckFails = true; // 后端 Set 抛错
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
    harnessState.setCheckFails = false; // 复位,避免污染后续用例
  });
});

describe("HarnessPane 「自动升级」子开关 绑定后端 + 风险 tooltip", () => {
  test("点子开关 → 调 SetAutoHarnessUpgrade(翻转值),aria-checked 翻转", async () => {
    calls.length = 0;
    harnessState.autoUpgrade = false;
    const { host } = mount(<HarnessPane />);
    await flush();
    const up = host.querySelector('[data-testid="harness-autoupgrade"]') as HTMLElement;
    expect(up.getAttribute("aria-checked")).toBe("false");
    up.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    // 必须真正调到后端,且传入翻转后的 true(防「渲染了但不接后端」)。
    expect(calls).toContainEqual({ fn: "SetAutoHarnessUpgrade", arg: true });
    const up2 = host.querySelector('[data-testid="harness-autoupgrade"]') as HTMLElement;
    expect(up2.getAttribute("aria-checked")).toBe("true");
  });

  test("SetAutoHarnessUpgrade 报错 → UI 回滚到原值", async () => {
    calls.length = 0;
    harnessState.autoUpgrade = false;
    harnessState.setUpgradeFails = true; // 后端 Set 抛错
    const { host } = mount(<HarnessPane />);
    await flush();
    const up = host.querySelector('[data-testid="harness-autoupgrade"]') as HTMLElement;
    expect(up.getAttribute("aria-checked")).toBe("false");
    up.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
    await flush();
    // 翻转尝试过(true),但后端失败 → catch 块回滚 UI 回 false。
    expect(calls).toContainEqual({ fn: "SetAutoHarnessUpgrade", arg: true });
    const up2 = host.querySelector('[data-testid="harness-autoupgrade"]') as HTMLElement;
    expect(up2.getAttribute("aria-checked")).toBe("false");
    harnessState.setUpgradeFails = false; // 复位
  });

  test("子开关行带风险 tooltip(autoUpgradeRiskTip)", async () => {
    const { host } = mount(<HarnessPane />);
    await flush();
    const row = host.querySelector('[data-testid="harness-autoupgrade-row"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.getAttribute("data-tooltip-content")).toBe("settings.harness.autoUpgradeRiskTip");
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
