// download.ts:Trigger a client-side file download from text content.
//
// Uses the standard Blob + object URL + <a download> pattern, which works in
// Wails3 webviews (WKWebView / WebView2) and regular browsers. Stays fully on
// the client — no backend round-trip beyond fetching the text itself.

// downloadText saves `content` as a file named `filename` using `mime` (default text/plain).
export function downloadText(content: string, filename: string, mime = "text/plain;charset=utf-8"): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick: some webviews start the download synchronously on click,
  // but revoking too eagerly can truncate it on slower engines.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
