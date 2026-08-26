// ErrorCard mount test (#46 step 3): the rendered error banner contract —
// the three diagnostic paths and the fallback chain, anchored on the DOM.
//
//   1. quota        → primary message with the localized reset moment; no
//                     secondary line; copy copies the message.
//   2. transient    → primary shows the auto-retry count; the verbatim
//                     rootCause renders as the secondary line; copy copies
//                     BOTH lines (message + "\n" + rootCause).
//   3. unknown code → i18n key missing → raw rootCause verbatim in the
//                     primary line (fallback chain middle rung).
//   4. quota w/o    → the generic pre-existing copy renders untouched
//      resetAt       (last rung of the fallback chain).
//
// The view is produced by the real renderChatError against a mini-l10n backed
// by the real zh.json subtree (i18next-style {{var}} interpolation), so the
// payload→view→DOM pipeline is exercised end to end. react-i18next is mocked
// (same as sibling mount tests) for CopyIconButton.

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import zh from "../i18n/locales/zh.json";

// ---- happy-dom setup (same as CopyIconButton.mount.test.tsx) ----
const win = new Window();
const doc = win.document;
(globalThis as Record<string, unknown>).window = win;
(globalThis as Record<string, unknown>).document = doc;
(globalThis as Record<string, unknown>).navigator = win.navigator;
(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(performance.now()), 0);
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);
win.React = React;

// react-i18next: return keys verbatim (CopyIconButton tooltips only).
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "zh" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

// Capture the text the copy button writes (Wails3 clipboard channel).
const setTextMock = mock((_t: string) => Promise.resolve());
mock.module("@wailsio/runtime", () => ({ Clipboard: { SetText: setTextMock } }));
Object.defineProperty(win.navigator, "clipboard", { value: undefined, configurable: true });

// Mini-l10n: the REAL zh.json chat.error subtree + i18next-style interpolation.
// resolve() mimics i18next key lookup through nested objects.
const subtree = zh as Record<string, unknown>;
function resolve(key: string): string | undefined {
  let cur: unknown = subtree;
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" ? cur : undefined;
}
const miniL10n = {
  t: (k: string, o?: Record<string, unknown>) => {
    const s = resolve(k) ?? k;
    return s.replace(/\{\{(\w+)\}\}/g, (_, v) => String(o?.[v] ?? ""));
  },
  exists: (k: string) => resolve(k) !== undefined,
  language: "zh",
};

const { renderChatError } = await import("../lib/errorDiag");
const { default: ErrorCard } = await import("./ErrorCard");
import type { StatusPayload } from "../types";

const err = (p: Partial<StatusPayload>): StatusPayload => ({ sessionId: "s1", status: "error", ...p });

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 2));
}

function render(node: React.ReactNode): { container: HTMLElement; root: Root } {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container);
  root.render(node);
  return { container, root };
}

function mountPayload(p: Partial<StatusPayload>) {
  return render(<ErrorCard view={renderChatError(err(p), miniL10n)} />);
}

const msgNode = (c: HTMLElement) => c.querySelector('[data-testid="error-bar-msg"]') as HTMLElement;
const secondaryNode = (c: HTMLElement) => c.querySelector('[data-testid="error-bar-secondary"]');
const copyBtn = (c: HTMLElement) => c.querySelector(".copy-icon-btn") as HTMLButtonElement;

beforeEach(() => {
  setTextMock.mockReset();
  setTextMock.mockImplementation((_t: string) => Promise.resolve());
});

describe("ErrorCard diagnostic rendering", () => {
  test("quota + resetAt → reset moment in the message, no secondary, copy = message", async () => {
    const { container } = mountPayload({
      code: "provider_quota_exhausted",
      rootCause: "已达到 5 小时的使用上限。您的限额将在 2026-08-26 16:32:32 重置。",
      resetAt: "2026-08-26 16:32:32",
      attempts: 1,
    });
    await flush();
    const msg = msgNode(container).textContent || "";
    expect(msg).toContain("供应商配额已耗尽");
    expect(msg).toContain("将于 2026年8月26日 16:32 重置"); // localized format, wall time kept
    expect(msg).not.toContain("重试"); // attempts never surfaced for quota
    expect(secondaryNode(container)).toBeNull();
    copyBtn(container).click();
    await flush();
    expect(setTextMock).toHaveBeenCalledTimes(1);
    expect(setTextMock.mock.calls[0][0]).toContain("将于 2026年8月26日 16:32 重置");
  });

  test("transient + attempts → retry count in message, rootCause as secondary, copy = both lines", async () => {
    const { container } = mountPayload({
      code: "provider_transient_error",
      rootCause: "503 Service Unavailable",
      attempts: 4,
    });
    await flush();
    const msg = msgNode(container).textContent || "";
    expect(msg).toContain("已自动重试 3 次");
    const sec = secondaryNode(container) as HTMLElement;
    expect(sec.textContent).toBe("503 Service Unavailable"); // verbatim root cause
    copyBtn(container).click();
    await flush();
    expect(setTextMock.mock.calls[0][0]).toContain("已自动重试 3 次仍失败。请稍后重试发送。");
    expect(setTextMock.mock.calls[0][0]).toContain("\n503 Service Unavailable"); // both lines
  });

  test("unknown code (key missing) → raw rootCause verbatim in the primary line", async () => {
    const { container } = mountPayload({
      code: "provider_brand_new_failure",
      rootCause: "供应商原始错误文本",
    });
    await flush();
    expect(msgNode(container).textContent).toContain("供应商原始错误文本");
    expect(secondaryNode(container)).toBeNull();
  });

  test("quota without resetAt → generic pre-existing copy, untouched", async () => {
    const { container } = mountPayload({
      code: "provider_quota_exhausted",
      attempts: 1,
    });
    await flush();
    expect(msgNode(container).textContent).toContain("请等待配额重置后再试");
    expect(secondaryNode(container)).toBeNull();
  });
});
