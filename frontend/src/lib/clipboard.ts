// Unified clipboard writer for Wails3 webview + browser dev fallback.
//
// Problem: navigator.clipboard.writeText() is unavailable inside Wails3 webviews
// (WKWebView / WebView2 don't grant JS clipboard-write permission), so every
// button-triggered copy silently failed — calls were wrapped in `catch { noop }`
// which swallowed the NotAllowedError. Ctrl+C still worked because it goes through
// the native OS clipboard via webview text selection, not the JS Clipboard API.
//
// Fix: prefer Wails3 runtime Clipboard.SetText (native, reliable in the webview),
// then fall back to navigator.clipboard (browser dev / server mode), then to the
// legacy execCommand("copy") as a last resort. Callers no longer need their own
// try/catch — this function never throws.
import { Clipboard } from "@wailsio/runtime";

export async function copyText(text: string): Promise<void> {
  // Primary: Wails3 native clipboard (works inside WKWebView / WebView2).
  try {
    await Clipboard.SetText(text);
    return;
  } catch {
    // Not in a Wails3 context (pure browser dev) or runtime unavailable.
  }

  // Fallback 1: async Clipboard API (secure contexts: localhost dev, https).
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // NotAllowedError / missing secure context / unsupported.
  }

  // Fallback 2: legacy synchronous path (hidden textarea + execCommand).
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
}
