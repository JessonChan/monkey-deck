// Mount-test MermaidRenderer with happy-dom + React, exercising the real React tree
// (Task #21290 review). Stubs the dynamic `import("mermaid")` so the test doesn't pull
// ~600KB / real layout, but exercises the actual `renderMermaid` lib + component state machine.
// Goal: prove the component's state transitions and fallback UX actually fire in React,
// not just read correctly in source — closes the worklog OPEN item "server 模式实测" with a
// deterministic, hermetic alternative that runs in `bun test`.

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
window.React = React;
// react-tooltip & react-i18next imports must resolve; their defaults are no-ops in our test path.
// Patch dynamic import to return a fake mermaid before importing the component.
const calls = [];
const validSvg = "<svg class='fake-mermaid'><g>diagram</g></svg>";
const fakeMermaid = {
  default: {
    initialize: (config) => calls.push({ init: config }),
    render: async (id, text) => {
      calls.push({ render: id, text });
      if (text.includes("BROKEN")) throw new Error("parse error: broken");
      return { svg: validSvg, diagramType: "flowchart-v2", bindFunctions: (el) => { calls.push({ bind: !!el }); } };
    },
  },
};
// Mock mermaid (dynamic import). Our lib does `mod.default.initialize/render`, so the
// mocked module namespace must expose `{ default: { initialize, render } }`.
mock.module("mermaid", () => ({ default: fakeMermaid.default }));
mock.module("react-tooltip", () => ({ Tooltip: () => null, default: () => null }));
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k) => k }),
  initReactI18next: { type: "3rd-party" },
  default: { useTranslation: () => ({ t: (k) => k }) },
}));

// Mock mermaidExport (issue #86): the real module rasterizes via canvas/Image,
// which happy-dom can't do. The component only needs the tri-state outcome.
const copyImageCalls = [];
const copyMermaidImageMock = mock(async (svg) => {
  copyImageCalls.push(svg);
  return copyMermaidImageMock.outcome;
});
copyMermaidImageMock.outcome = "copied";
mock.module("../lib/mermaidExport.ts", () => ({ copyMermaidImage: copyMermaidImageMock }));

// Now import the components fresh (after mocks are registered).
const { default: MermaidRenderer } = await import("./MermaidRenderer.tsx");
const { renderMermaid, getCachedSvg, __resetMermaidCacheForTest } = await import("../lib/mermaidRenderer.ts");

function mount(jsx) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(jsx);
  return { host, root };
}

async function flush() {
  // happy-dom + React 19 need a tick to commit + run effects.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
}

describe("renderMermaid (lib)", () => {
  test("valid code → {ok, svg}", async () => {
    __resetMermaidCacheForTest();
    const r = await renderMermaid("graph TD\n  A --> B");
    expect(r.ok).toBe(true);
    expect(r.svg).toContain("<svg");
  });

  test("invalid code → {ok:false, error}", async () => {
    __resetMermaidCacheForTest();
    const r = await renderMermaid("BROKEN SYNTAX");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("parse error");
  });

  test("same valid code → cached (render called once)", async () => {
    __resetMermaidCacheForTest();
    calls.length = 0;
    await renderMermaid("graph TD\n  A --> B");
    await renderMermaid("graph TD\n  A --> B");
    const renders = calls.filter((c) => "render" in c);
    expect(renders.length).toBe(1);
  });

  test("getCachedSvg: undefined before render, returns SVG after render (same code)", async () => {
    __resetMermaidCacheForTest();
    const code = "graph TD\n  A --> B";
    // Before any render: nothing cached.
    expect(getCachedSvg(code)).toBeUndefined();
    const r = await renderMermaid(code);
    expect(r.ok).toBe(true);
    // After render: synchronous lookup returns the cached SVG (enables mount-from-cache).
    const cached = getCachedSvg(code);
    expect(cached).toBe(r.svg);
    // Whitespace-only / empty → undefined (never cached).
    expect(getCachedSvg("   ")).toBeUndefined();
  });

  test("empty code → {ok:false}", async () => {
    const r = await renderMermaid("   ");
    expect(r.ok).toBe(false);
  });
});

describe("MermaidRenderer (component)", () => {
  test("streaming=true → shows source, does not call render", async () => {
    __resetMermaidCacheForTest();
    calls.length = 0;
    const { host } = mount(<MermaidRenderer code={"graph TD\n  A --> B"} streaming={true} />);
    await flush();
    expect(host.querySelector('[data-testid="mermaid-source"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="mermaid-diagram"]')).toBeNull();
    const renders = calls.filter((c) => "render" in c);
    expect(renders.length).toBe(0);
  });

  test("streaming=false + valid code → renders SVG", async () => {
    __resetMermaidCacheForTest();
    calls.length = 0;
    const { host } = mount(<MermaidRenderer code={"graph TD\n  A --> B"} streaming={false} />);
    await flush();
    // First commit shows loading, then async resolves to success.
    const diag = host.querySelector('[data-testid="mermaid-diagram"]');
    expect(diag).not.toBeNull();
    expect(diag.querySelector("svg")).not.toBeNull();
    // bindFunctions should have been called on the host element.
    const binds = calls.filter((c) => "bind" in c);
    expect(binds.length).toBe(1);
  });

  test("invalid code → fallback with source + error message", async () => {
    __resetMermaidCacheForTest();
    calls.length = 0;
    const { host } = mount(<MermaidRenderer code={"BROKEN SYNTAX"} streaming={false} />);
    await flush();
    const fb = host.querySelector('[data-testid="mermaid-fallback"]');
    expect(fb).not.toBeNull();
    const err = host.querySelector('[data-testid="mermaid-error-msg"]');
    expect(err).not.toBeNull();
    expect(err.textContent).toContain("parse error");
  });

  test("empty code → idle (no diagram, no loading, no fallback)", async () => {
    const { host } = mount(<MermaidRenderer code={"   "} streaming={false} />);
    await flush();
    expect(host.querySelector('[data-testid="mermaid-diagram"]')).toBeNull();
    expect(host.querySelector('[data-testid="mermaid-fallback"]')).toBeNull();
    expect(host.querySelector('[data-testid="mermaid-loading"]')).toBeNull();
    expect(host.querySelector('[data-testid="mermaid-source"]')).not.toBeNull();
  });

  test("transition streaming=true → false triggers render", async () => {
    __resetMermaidCacheForTest();
    calls.length = 0;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    root.render(<MermaidRenderer code={"graph TD\n  A --> B"} streaming={true} />);
    await flush();
    expect(host.querySelector('[data-testid="mermaid-source"]')).not.toBeNull();
    expect(calls.filter((c) => "render" in c).length).toBe(0);
    root.render(<MermaidRenderer code={"graph TD\n  A --> B"} streaming={false} />);
    await flush();
    expect(host.querySelector('[data-testid="mermaid-diagram"]')).not.toBeNull();
  });

  test("remount with cached SVG → diagram shows, no redundant render (flicker-free remount)", async () => {
    // Simulates a session-tab switch: key=sessionId remounts the whole chat body,
    // so MermaidRenderer unmounts and a fresh instance mounts. With the SVG already
    // cached, the lazy initializer paints success immediately (no idle→loading flicker)
    // and the effect's cache-hit branch skips renderMermaid entirely.
    __resetMermaidCacheForTest();
    calls.length = 0;
    const code = "graph TD\n  A --> B";
    const host1 = document.createElement("div");
    document.body.appendChild(host1);
    const root1 = createRoot(host1);
    root1.render(<MermaidRenderer code={code} streaming={false} />);
    await flush();
    expect(host1.querySelector('[data-testid="mermaid-diagram"]')).not.toBeNull();
    expect(calls.filter((c) => "render" in c).length).toBe(1);

    // Fresh instance, same code (cache already populated by the first mount).
    const host2 = document.createElement("div");
    document.body.appendChild(host2);
    const root2 = createRoot(host2);
    root2.render(<MermaidRenderer code={code} streaming={false} />);
    await flush();
    await flush();
    // Diagram present (mount-from-cache) and mermaid.render NOT called again.
    expect(host2.querySelector('[data-testid="mermaid-diagram"]')).not.toBeNull();
    expect(calls.filter((c) => "render" in c).length).toBe(1);
    root1.unmount();
    root2.unmount();
  });

  // ---- Task #22115: view-source toggle + zoom ----

  // reset 按钮 tooltip 形如 "chat.mermaidZoomReset · 120%";取百分比段断言缩放倍率。
  function resetPct(h) {
    const btn = h.querySelector('[data-testid="mermaid-zoom-reset"]');
    return btn?.getAttribute("data-tooltip-content") || "";
  }

  test("view-source toggle switches diagram ↔ source", async () => {
    __resetMermaidCacheForTest();
    const { host } = mount(<MermaidRenderer code={"graph TD\n  A --> B"} streaming={false} />);
    await flush();
    expect(host.querySelector(".mermaid-svg-host")).not.toBeNull();
    expect(host.querySelector(".mermaid-src-pre")).toBeNull();
    host.querySelector('[data-testid="mermaid-src-toggle"]').click();
    await flush();
    expect(host.querySelector(".mermaid-src-pre")).not.toBeNull();
    expect(host.querySelector(".mermaid-svg-host")).toBeNull();
    host.querySelector('[data-testid="mermaid-src-toggle"]').click();
    await flush();
    expect(host.querySelector(".mermaid-svg-host")).not.toBeNull();
    expect(host.querySelector(".mermaid-src-pre")).toBeNull();
  });

  test("zoom-in / zoom-out buttons change zoom (read reset %)", async () => {
    __resetMermaidCacheForTest();
    const { host } = mount(<MermaidRenderer code={"graph TD\n  A --> B"} streaming={false} />);
    await flush();
    expect(resetPct(host)).toContain("100%");
    host.querySelector('[data-testid="mermaid-zoom-in"]').click();
    await flush();
    expect(resetPct(host)).toContain("120%");
    host.querySelector('[data-testid="mermaid-zoom-out"]').click();
    await flush();
    expect(resetPct(host)).toContain("100%");
  });

  test("reset button restores 100%", async () => {
    __resetMermaidCacheForTest();
    const { host } = mount(<MermaidRenderer code={"graph TD\n  A --> B"} streaming={false} />);
    await flush();
    host.querySelector('[data-testid="mermaid-zoom-in"]').click();
    host.querySelector('[data-testid="mermaid-zoom-in"]').click();
    await flush();
    expect(resetPct(host)).toContain("140%");
    host.querySelector('[data-testid="mermaid-zoom-reset"]').click();
    await flush();
    expect(resetPct(host)).toContain("100%");
  });

  test("zoom buttons clamp + disable at min/max", async () => {
    __resetMermaidCacheForTest();
    const { host } = mount(<MermaidRenderer code={"graph TD\n  A --> B"} streaming={false} />);
    await flush();
    const out = () => host.querySelector('[data-testid="mermaid-zoom-out"]');
    const inn = () => host.querySelector('[data-testid="mermaid-zoom-in"]');
    expect(out().disabled).toBe(false);
    // 0.2 步进从 1.0 缩到 0.3(clamp),额外点击被 clamp 吸收。
    for (let i = 0; i < 8; i++) out().click();
    await flush();
    expect(out().disabled).toBe(true);
    // 从 0.2/0.3 一路放大到 3.0(clamp)。
    for (let i = 0; i < 20; i++) inn().click();
    await flush();
    expect(inn().disabled).toBe(true);
  });

  test("Ctrl/⌘ + wheel zooms; plain wheel does not", async () => {
    __resetMermaidCacheForTest();
    const { host } = mount(<MermaidRenderer code={"graph TD\n  A --> B"} streaming={false} />);
    await flush();
    const svgHost = host.querySelector(".mermaid-svg-host");
    // happy-dom 的 WheelEvent 构造器不会从 init 设 ctrlKey(真实浏览器会),这里显式补上以测逻辑。
    const ctrlWheel = (deltaY) => {
      const ev = new window.WheelEvent("wheel", { deltaY });
      Object.defineProperty(ev, "ctrlKey", { value: true });
      svgHost.dispatchEvent(ev);
    };
    // 无 ctrl 不缩放(deltaY 非 0 但 ctrlKey 缺省 falsy)。
    svgHost.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -100 }));
    await flush();
    expect(resetPct(host)).toContain("100%");
    // ctrl + 滚轮上 ×3 → +0.3 → 130%。
    for (let i = 0; i < 3; i++) ctrlWheel(-100);
    await flush();
    expect(resetPct(host)).toContain("130%");
  });

  // ---- Task #22945: fullscreen modal(复用 zoom)----

  // modal 内 reset 按钮 testid=mermaid-fs-zoom-reset,与 inline 区分避免选择器误选。
  function fsResetPct(h) {
    const btn = h.querySelector('[data-testid="mermaid-fs-zoom-reset"]');
    return btn?.getAttribute("data-tooltip-content") || "";
  }

  test("fullscreen button opens modal overlay with SVG", async () => {
    __resetMermaidCacheForTest();
    const { host } = mount(<MermaidRenderer code={"graph TD\n  A --> B"} streaming={false} />);
    await flush();
    expect(host.querySelector('[data-testid="mermaid-fullscreen"]')).toBeNull();
    host.querySelector('[data-testid="mermaid-fullscreen-open"]').click();
    await flush();
    const fs = host.querySelector('[data-testid="mermaid-fullscreen"]');
    expect(fs).not.toBeNull();
    expect(fs.querySelector("svg")).not.toBeNull();
    // modal 有独立的 zoom 控件 + 关闭按钮。
    expect(fs.querySelector('[data-testid="mermaid-fs-zoom-in"]')).not.toBeNull();
    expect(fs.querySelector('[data-testid="mermaid-fullscreen-close"]')).not.toBeNull();
  });

  test("close button closes fullscreen", async () => {
    __resetMermaidCacheForTest();
    const { host } = mount(<MermaidRenderer code={"graph TD\n  A --> B"} streaming={false} />);
    await flush();
    host.querySelector('[data-testid="mermaid-fullscreen-open"]').click();
    await flush();
    expect(host.querySelector('[data-testid="mermaid-fullscreen"]')).not.toBeNull();
    host.querySelector('[data-testid="mermaid-fullscreen-close"]').click();
    await flush();
    expect(host.querySelector('[data-testid="mermaid-fullscreen"]')).toBeNull();
  });

  test("click on mask closes fullscreen; click inside card does not", async () => {
    __resetMermaidCacheForTest();
    const { host } = mount(<MermaidRenderer code={"graph TD\n  A --> B"} streaming={false} />);
    await flush();
    host.querySelector('[data-testid="mermaid-fullscreen-open"]').click();
    await flush();
    const overlay = host.querySelector(".mermaid-fs-overlay");
    // 点卡片内部不关(点 zoom-in 验证 stopPropagation)。
    host.querySelector('[data-testid="mermaid-fs-zoom-in"]').click();
    await flush();
    expect(host.querySelector('[data-testid="mermaid-fullscreen"]')).not.toBeNull();
    // 点遮罩关闭:直接派发 click 到 overlay。
    overlay.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await flush();
    expect(host.querySelector('[data-testid="mermaid-fullscreen"]')).toBeNull();
  });

  test("Esc closes fullscreen", async () => {
    __resetMermaidCacheForTest();
    const { host } = mount(<MermaidRenderer code={"graph TD\n  A --> B"} streaming={false} />);
    await flush();
    host.querySelector('[data-testid="mermaid-fullscreen-open"]').click();
    await flush();
    expect(host.querySelector('[data-testid="mermaid-fullscreen"]')).not.toBeNull();
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(host.querySelector('[data-testid="mermaid-fullscreen"]')).toBeNull();
  });

  test("modal zoom is independent + starts at 100%", async () => {
    __resetMermaidCacheForTest();
    const { host } = mount(<MermaidRenderer code={"graph TD\n  A --> B"} streaming={false} />);
    await flush();
    // inline 先放大到 120%(不应影响稍后打开的 modal)。
    host.querySelector('[data-testid="mermaid-zoom-in"]').click();
    await flush();
    expect(resetPct(host)).toContain("120%");
    host.querySelector('[data-testid="mermaid-fullscreen-open"]').click();
    await flush();
    // modal 独立状态:打开即 100%。
    expect(fsResetPct(host)).toContain("100%");
    host.querySelector('[data-testid="mermaid-fs-zoom-in"]').click();
    await flush();
    expect(fsResetPct(host)).toContain("120%");
    // inline 的缩放未被 modal 影响。
    expect(resetPct(host)).toContain("120%");
  });

  // ---- issue #86: copy as image ----

  const copyImageTip = (h, testId) =>
    h.querySelector(`[data-testid="${testId}"]`)?.getAttribute("data-tooltip-content") || "";

  test("copy-image button: visible in success view, hidden while streaming", async () => {
    __resetMermaidCacheForTest();
    const { host } = mount(<MermaidRenderer code={"graph TD\n  A --> B"} streaming={true} />);
    await flush();
    expect(host.querySelector('[data-testid="mermaid-copy-image"]')).toBeNull();
  });

  test("copy-image click → copyMermaidImage receives the SVG, tooltip flips to copied", async () => {
    __resetMermaidCacheForTest();
    copyImageCalls.length = 0;
    copyMermaidImageMock.outcome = "copied";
    const { host } = mount(<MermaidRenderer code={"graph TD\n  A --> B"} streaming={false} />);
    await flush();
    const btn = host.querySelector('[data-testid="mermaid-copy-image"]');
    expect(btn).not.toBeNull();
    expect(copyImageTip(host, "mermaid-copy-image")).toBe("chat.mermaidCopyImage");
    btn.click();
    await flush();
    expect(copyImageCalls).toEqual([validSvg]);
    expect(copyImageTip(host, "mermaid-copy-image")).toBe("chat.mermaidImageCopied");
  });

  test("downloaded outcome → tooltip announces the download fallback", async () => {
    __resetMermaidCacheForTest();
    copyMermaidImageMock.outcome = "downloaded";
    const { host } = mount(<MermaidRenderer code={"graph TD\n  A --> B"} streaming={false} />);
    await flush();
    host.querySelector('[data-testid="mermaid-copy-image"]').click();
    await flush();
    expect(copyImageTip(host, "mermaid-copy-image")).toBe("chat.mermaidImageDownloaded");
  });

  test("failed outcome → tooltip announces failure", async () => {
    __resetMermaidCacheForTest();
    copyMermaidImageMock.outcome = "failed";
    const { host } = mount(<MermaidRenderer code={"graph TD\n  A --> B"} streaming={false} />);
    await flush();
    host.querySelector('[data-testid="mermaid-copy-image"]').click();
    await flush();
    expect(copyImageTip(host, "mermaid-copy-image")).toBe("chat.mermaidImageCopyFailed");
  });

  test("fullscreen modal has its own copy-image button (independent feedback)", async () => {
    __resetMermaidCacheForTest();
    copyImageCalls.length = 0;
    copyMermaidImageMock.outcome = "copied";
    const { host } = mount(<MermaidRenderer code={"graph TD\n  A --> B"} streaming={false} />);
    await flush();
    host.querySelector('[data-testid="mermaid-fullscreen-open"]').click();
    await flush();
    const fsBtn = host.querySelector('[data-testid="mermaid-fs-copy-image"]');
    expect(fsBtn).not.toBeNull();
    fsBtn.click();
    await flush();
    expect(copyImageCalls).toEqual([validSvg]);
    expect(copyImageTip(host, "mermaid-fs-copy-image")).toBe("chat.mermaidImageCopied");
    // inline 按钮的反馈状态不受 modal 独立实例影响。
    expect(copyImageTip(host, "mermaid-copy-image")).toBe("chat.mermaidCopyImage");
  });
});
