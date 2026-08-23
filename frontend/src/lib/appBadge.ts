// App icon badge (installed PWA / Android WebAPK): bump when an
// attention-worthy event (natural turn end, permission request) arrives while
// the page is hidden; clear when the app returns to the foreground.
//
// Deliberately best-effort without push (M4+ per AGENTS.md §7): a badge update
// needs live JS, and Chrome freezes backgrounded pages — this covers
// "switched away for a few minutes", not deep background. Guarded to
// standalone display mode: a desktop webview / plain browser tab never
// matches, so neither the calls nor their rejections ever happen there.

export interface BadgeEnv {
  supported(): boolean;
  set(count: number): void;
  clear(): void;
}

export interface Badge {
  /** Count one attention event; updates the icon badge when supported. */
  bump(): void;
  /** Foreground return: retire the badge and reset the counter. */
  reset(): void;
  /** Current count (0 when unsupported — nothing to show). */
  readonly value: number;
}

export function createBadge(env: BadgeEnv): Badge {
  let count = 0;
  return {
    bump() {
      if (!env.supported()) return;
      count++;
      env.set(count);
    },
    reset() {
      count = 0;
      if (env.supported()) env.clear();
    },
    get value() { return count; },
  };
}

const browserEnv: BadgeEnv = {
  supported: () =>
    typeof navigator !== "undefined" && "setAppBadge" in navigator && "clearAppBadge" in navigator &&
    typeof window !== "undefined" && !!window.matchMedia?.("(display-mode: standalone)").matches,
  set: (n) => { navigator.setAppBadge(n).catch(() => {}); },
  clear: () => { navigator.clearAppBadge().catch(() => {}); },
};

export const appBadge = createBadge(browserEnv);
