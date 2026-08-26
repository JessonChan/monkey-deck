// errorDiag.ts: presentation mapping for chat error status payloads (#46 step 3).
//
// The backend classifies Prompt failures (internal/acp DiagnosePromptError) and
// attaches a structured diagnostic payload — rootCause / resetAt / attempts
// (types.ts StatusPayload). This module turns that payload into the error
// banner content, branched by the stable error code family:
//
//   - quota family    → localized copy with the reset moment interpolated;
//                       attempt counts are never shown (quota is zero-retry —
//                       retrying before the reset only hits the same wall).
//   - transient fam.  → localized copy with the retry count interpolated; the
//                       verbatim root cause is demoted to a secondary line
//                       (small text) instead of crowding the primary message.
//   - unknown         → localized prefix + the verbatim root cause text
//                       (untranslated — it is the provider's own wording).
//
// Fallback chain (review #24347 P3-3): i18n key hit → interpolated copy;
// key missing → raw root cause text; neither → the pre-existing fallback
// (code translation / detail / app.errorFallback), unchanged.

import type { StatusPayload } from "../types";

// View model for the error banner: a primary localized message plus an
// optional secondary line carrying the verbatim root cause.
export interface ChatErrorView {
  message: string;
  secondary: string | null;
}

// Minimal i18n surface the renderer needs — satisfied by the i18next singleton
// (kept as a parameter so the mapping stays a pure, DOM-free function).
// language (optional) drives the reset-moment display locale; falls back to
// the runtime default locale when absent.
export interface DiagL10n {
  t: (key: string, opts?: Record<string, unknown>) => string;
  exists: (key: string) => boolean;
  language?: string;
}

// Error code families (chat.error.* codes from internal/chat). Prefix match:
// the backend names quota codes "provider_quota*" and transient ones
// "provider_transient*" — future codes in the same family render the same way.
const QUOTA_PREFIX = "provider_quota";
const TRANSIENT_PREFIX = "provider_transient";

// Locale keys for the interpolated variants. The generic fallbacks for both
// families (chat.error.provider_quota_exhausted / provider_transient_error)
// stay as shipped — they cover payloads without resetAt/attempts.
const K_QUOTA_RESET = "chat.error.provider_quota_exhausted_reset";
const K_TRANSIENT_RETRIED = "chat.error.provider_transient_error_retried_other";
const K_ROOT_CAUSE_PREFIX = "chat.error.rootCausePrefix";

// renderChatError maps an error StatusPayload onto the banner view.
export function renderChatError(s: StatusPayload, l10n: DiagL10n): ChatErrorView {
  const key = s.code ? `chat.error.${s.code}` : "";
  const keyHit = !!key && l10n.exists(key);
  const rootCause = (s.rootCause || "").trim();

  if (keyHit) {
    const code = s.code as string;
    // Quota: interpolate the reset moment; never surface attempt counts.
    if (code.startsWith(QUOTA_PREFIX)) {
      const resetAt = (s.resetAt || "").trim();
      if (resetAt && l10n.exists(K_QUOTA_RESET)) {
        return { message: l10n.t(K_QUOTA_RESET, { resetAt: formatResetAt(resetAt, l10n.language) }), secondary: null };
      }
      return { message: l10n.t(key), secondary: null };
    }
    // Transient: retry count = total attempts - 1 (attempts counts the initial
    // send too, e.g. 4 attempts = 3 auto-retries); show the retried variant
    // only when at least one retry actually happened.
    if (code.startsWith(TRANSIENT_PREFIX)) {
      const retries = Math.max((s.attempts ?? 1) - 1, 0);
      const message = retries >= 1 && l10n.exists(K_TRANSIENT_RETRIED)
        ? l10n.t(K_TRANSIENT_RETRIED, { count: retries })
        : l10n.t(key);
      return { message, secondary: rootCause || null };
    }
    // Unknown class with diagnostics: localized prefix + verbatim root cause.
    if (rootCause) {
      const prefix = l10n.exists(K_ROOT_CAUSE_PREFIX) ? l10n.t(K_ROOT_CAUSE_PREFIX) : "";
      return { message: prefix ? `${prefix}${rootCause}` : rootCause, secondary: null };
    }
    // Known code, no diagnostics — today's plain code-driven translation
    // (agent_turn_incomplete / harness_disconnected & co, unchanged).
    return { message: l10n.t(key), secondary: null };
  }

  // Key missing → raw root cause (already stripped of protocol wrapping by the
  // backend, §4.4: human text, not JSON).
  if (rootCause) return { message: rootCause, secondary: null };

  // Neither — the pre-existing fallback chain, untouched. Every keyHit path
  // returns above, so the code here is always a key miss: t(key) would echo
  // the raw key string (i18next missing-key behavior) — never do that.
  return { message: s.detail || l10n.t("app.errorFallback"), secondary: null };
}

// formatResetAt localizes the FORMAT of the verbatim provider reset moment.
// Numeric datetimes ("2026-08-26 16:32:32", the empirically observed bigmodel
// form) are parsed as naive provider-local wall time and re-rendered in the
// user's locale WITHOUT any timezone conversion — the backend passes the text
// verbatim precisely because the provider's local time is what the user should
// see; re-formatting the display keeps the same wall clock. Anything else
// (english tail captures like "9am", "Monday") passes through verbatim — it
// cannot be re-formatted without guessing semantics.
export function formatResetAt(raw: string, locale?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
  if (!m) return raw;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), m[6] ? Number(m[6]) : 0);
  if (Number.isNaN(d.getTime())) return raw;
  try {
    return d.toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return raw; // exotic locales without Intl data fall back to the raw text
  }
}
