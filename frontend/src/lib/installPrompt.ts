// PWA install guidance (M2): Chrome fires beforeinstallprompt some time after
// load; capturing it lets us offer install from our own UI — the browser's
// menu entry is undiscoverable. iOS Safari never fires it, so callers fall
// back to manual "Share → Add to Home Screen" instructions. The desktop
// webview never fires it and the banner UI is CSS-gated off; inert there.

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    for (const fn of listeners) fn();
  });
}

/** Subscribe to "an install prompt became available". Returns unsubscribe. */
export function onInstallAvailable(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function canInstall(): boolean {
  return deferred !== null;
}

/** Show the browser install sheet. Resolves with the user's choice. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!deferred) return "unavailable";
  const ev = deferred;
  deferred = null;
  await ev.prompt();
  return (await ev.userChoice).outcome;
}

/** True when running as an installed app (manifest display: standalone). */
export function isStandalone(): boolean {
  return typeof window !== "undefined" &&
    !!window.matchMedia?.("(display-mode: standalone)").matches;
}
