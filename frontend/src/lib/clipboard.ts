// Unified clipboard writer for Wails3 webview + remote-browser clients.
//
// Problem: navigator.clipboard.writeText() is unavailable inside Wails3 webviews
// (WKWebView / WebView2 don't grant JS clipboard-write permission), so every
// button-triggered copy silently failed — calls were wrapped in `catch { noop }`
// which swallowed the NotAllowedError. Ctrl+C still worked because it goes through
// the native OS clipboard via webview text selection, not the JS Clipboard API.
//
// Channels, tried in order:
//  - Desktop webview: Wails3 runtime Clipboard.SetText (native, reliable in
//    WKWebView / WebView2). Skipped for remote-browser clients (§1.8): over the
//    remote transport the call would write the *desktop's* clipboard, not the
//    phone's local one — the copy appears to succeed but nothing is pastable on
//    the client device (issue #129).
//  - navigator.clipboard.writeText (secure contexts only: https / localhost).
//  - execCommandCopy: legacy synchronous path. This is the only channel on iOS
//    Safari over plain-HTTP LAN (the common phone/PWA path — insecure context,
//    no async Clipboard API at all).
//
// Returns whether any channel succeeded; never throws. Callers surface the
// failure to the user instead of showing a false "Copied".
import { Clipboard } from "@wailsio/runtime";
import { isRemoteClient } from "./remote";

// Synchronous execCommand-based copy. Must stay await-free end to end: iOS Safari
// only honors execCommand("copy") while the originating user gesture is still
// alive, and every `await` on the path to it burns that transient activation.
// The Range/Selection dance (instead of plain textarea.select()) plus the
// contentEditable/readonly flip is the classic iOS recipe; it is a harmless
// superset on desktop browsers, so it is applied unconditionally instead of
// UA-sniffing (§5.3 — no fragile heuristics).
export function execCommandCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.contentEditable = "true";
  ta.readOnly = false;
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  try {
    const range = document.createRange();
    range.selectNodeContents(ta);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    ta.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}

export async function copyText(text: string): Promise<boolean> {
  // Desktop webview: Wails3 native clipboard. Remote browsers must not take this
  // path (see header) — branch before the first await so the gesture-preserving
  // fallback below is never one async hop late.
  if (!isRemoteClient()) {
    try {
      await Clipboard.SetText(text);
      return true;
    } catch {
      // Not in a Wails3 context (pure browser dev) or runtime unavailable.
    }
  }

  // Remote-browser channel 1: async Clipboard API. Absent in insecure contexts
  // (plain-HTTP LAN), so the check falls straight through with zero awaits and
  // execCommandCopy still runs inside the user gesture on iOS.
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // NotAllowedError / document not focused / etc.
    }
  }

  // Remote-browser channel 2 (and last resort everywhere else).
  return execCommandCopy(text);
}

// Fire-and-forget variant for call sites with no visible feedback surface
// (context menus that close on click, selection toolbars that dismiss on run):
// quiet for the user, but copy failures stay observable in the console.
export function copyTextQuiet(text: string): void {
  void copyText(text).then((ok) => {
    if (!ok) console.warn("monkey-deck: clipboard copy failed");
  });
}
