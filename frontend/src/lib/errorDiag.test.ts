// errorDiag.test.ts: presentation mapping for the #46 diagnostic payload —
// three interpolation paths (quota resetAt / transient attempts / unknown
// rootCause) and the full fallback chain (key hit → interpolated copy;
// key missing → raw rootCause; neither → pre-existing fallback untouched).
//
// Runs against the REAL i18next instance with the REAL zh/en locale JSON, so
// the tests also anchor the shipped copy (interpolation keys present in both
// languages — the leaf-key parity test in i18n/locales.test.ts covers the rest).

import { test, expect, beforeAll } from "bun:test";
import i18next from "i18next";
import zh from "../i18n/locales/zh.json";
import en from "../i18n/locales/en.json";
import { renderChatError, formatResetAt, type DiagL10n } from "./errorDiag";
import type { StatusPayload } from "../types";

const inst = i18next.createInstance();
await inst.init({
  resources: { zh: { translation: zh }, en: { translation: en } },
  lng: "zh",
  interpolation: { escapeValue: false },
});

const l10n = (lng: "zh" | "en"): DiagL10n => ({
  t: (k, o) => inst.t(k, { lng, ...o }),
  exists: (k) => inst.exists(k, { lng }),
  language: lng,
});

const err = (p: Partial<StatusPayload>): StatusPayload => ({ sessionId: "s1", status: "error", ...p });

beforeAll(() => {
  inst.changeLanguage("zh");
});

// ---- quota family: reset moment interpolated, attempts never surfaced ----

test("quota + resetAt → copy with localized reset moment, no attempts anywhere", () => {
  const v = renderChatError(err({
    code: "provider_quota_exhausted",
    rootCause: "已达到 5 小时的使用上限。您的限额将在 2026-08-26 16:32:32 重置。",
    resetAt: "2026-08-26 16:32:32",
    attempts: 1,
  }), l10n("zh"));
  // The probe's §A event-1 moment, rendered in the zh display locale.
  expect(v.message).toBe("供应商配额已耗尽,本轮未发送成功。将于 2026年8月26日 16:32 重置,届时可再发送。");
  expect(v.secondary).toBeNull();
  expect(v.message).not.toContain("重试"); // quota is zero-retry: attempts never shown
});

test("quota en locale → reset moment re-formatted in en", () => {
  const v = renderChatError(err({
    code: "provider_quota_exhausted", resetAt: "2026-08-26 16:32:32",
  }), l10n("en"));
  expect(v.message).toContain("resets at Aug 26, 2026");
  expect(v.message).toContain("4:32"); // en-US 2-digit hour (04:32 PM)
});

test("quota without resetAt → existing generic copy, untouched", () => {
  const v = renderChatError(err({ code: "provider_quota_exhausted", attempts: 1 }), l10n("zh"));
  expect(v.message).toBe("供应商配额已耗尽,本轮未发送成功。请等待配额重置后再试。");
  expect(v.secondary).toBeNull();
});

test("quota resetAt non-numeric (english tail capture) passes through verbatim", () => {
  const v = renderChatError(err({ code: "provider_quota_exhausted", resetAt: "9am tomorrow" }), l10n("zh"));
  expect(v.message).toContain("将于 9am tomorrow 重置");
});

// ---- transient family: retry count interpolated, rootCause demoted ----

test("transient attempts=4 → retried-3 copy + rootCause as secondary", () => {
  const v = renderChatError(err({
    code: "provider_transient_error",
    rootCause: "503 Service Unavailable",
    attempts: 4,
  }), l10n("zh"));
  expect(v.message).toBe("供应商服务暂不可用,已自动重试 3 次仍失败。请稍后重试发送。");
  expect(v.secondary).toBe("503 Service Unavailable");
});

test("transient en + count → pluralized retried copy", () => {
  const v = renderChatError(err({
    code: "provider_transient_error", rootCause: "socket hang up", attempts: 4,
  }), l10n("en"));
  expect(v.message).toContain("auto-retried 3 times");
  expect(v.secondary).toBe("socket hang up");
});

test("transient attempts=1 (no retry happened) → generic copy, no count", () => {
  const v = renderChatError(err({
    code: "provider_transient_error", rootCause: "429 Too Many Requests", attempts: 1,
  }), l10n("zh"));
  expect(v.message).toBe("供应商服务暂不可用,自动重试后仍失败。请稍后重试发送。");
  expect(v.secondary).toBe("429 Too Many Requests");
});

test("transient without rootCause → primary only, no empty secondary node", () => {
  const v = renderChatError(err({ code: "provider_transient_error", attempts: 2 }), l10n("zh"));
  expect(v.message).toContain("已自动重试 1 次");
  expect(v.secondary).toBeNull();
});

// ---- unknown class: prefix + verbatim root cause ----

test("known code + rootCause → localized prefix + verbatim root cause", () => {
  const v = renderChatError(err({
    code: "agent_turn_incomplete", rootCause: "Internal error: boom",
  }), l10n("zh"));
  expect(v.message).toBe("本轮发送失败:Internal error: boom");
  expect(v.secondary).toBeNull();
});

test("known code without diagnostics → today's plain translation, byte-identical", () => {
  const v = renderChatError(err({ code: "agent_turn_incomplete" }), l10n("zh"));
  expect(v.message).toBe(zh.chat.error.agent_turn_incomplete);
  expect(v.secondary).toBeNull();
});

// ---- fallback chain ----

test("i18n key missing → raw root cause verbatim", () => {
  const v = renderChatError(err({
    code: "provider_brand_new_failure", rootCause: "供应商原始错误文本",
  }), l10n("zh"));
  expect(v.message).toBe("供应商原始错误文本");
  expect(v.secondary).toBeNull();
});

test("key missing + no root cause → detail (pre-existing fallback)", () => {
  const v = renderChatError(err({ code: "provider_brand_new_failure", detail: "boom" }), l10n("zh"));
  expect(v.message).toBe("boom");
});

test("no code + no root cause → app.errorFallback (pre-existing fallback)", () => {
  const v = renderChatError(err({ detail: "" }), l10n("zh"));
  expect(v.message).toBe(zh.app.errorFallback);
});

test("no code + root cause → root cause wins over detail", () => {
  const v = renderChatError(err({ detail: "old detail", rootCause: "real cause" }), l10n("zh"));
  expect(v.message).toBe("real cause");
});

// ---- formatResetAt edge cases ----

test("formatResetAt: ISO 'T' form parses; invalid datetime passes through raw", () => {
  expect(formatResetAt("2026-08-26T16:32:32", "zh")).toBe("2026年8月26日 16:32");
  // Out-of-range month rolls over in JS Date; the value stays a valid Date —
  // the guard only catches NaN. Assert the never-worse contract: raw passthrough
  // for anything unparseable, reformatted for parseable input.
  expect(formatResetAt("not a date at all", "zh")).toBe("not a date at all");
  expect(formatResetAt("", "zh")).toBe("");
});
