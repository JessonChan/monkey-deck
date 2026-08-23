// PWA manifest shortcuts (Android long-press app icon) launch the app with an
// ?action= query — see manifest.webmanifest `shortcuts`. Parse it once at
// startup, act, then strip it from the URL (history.replaceState) so a refresh
// doesn't re-trigger the navigation. Unknown/absent values → null; the desktop
// webview never carries the param, so all of this is inert there.

export type LaunchAction = "new-session" | "settings" | "switch-project";

const KNOWN_ACTIONS: readonly LaunchAction[] = ["new-session", "settings", "switch-project"];

/** Extract the shortcut launch action from a URL query string ("" → null). */
export function parseLaunchAction(search: string): LaunchAction | null {
  const raw = new URLSearchParams(search).get("action");
  return KNOWN_ACTIONS.includes(raw as LaunchAction) ? (raw as LaunchAction) : null;
}
