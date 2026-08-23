// Remote-browser client detection (AGENTS.md §1.8): the embedded remote server
// serves /wails/custom.js only to browser clients, and that script sets
// window.__mdRemote before the app bundle renders. The desktop webview gets a
// 404 for the script, so the flag stays undefined there.
declare global {
  interface Window { __mdRemote?: boolean; }
}

// True when this UI runs in a remote browser (phone / LAN client), not the
// desktop webview. Used to degrade desktop-only affordances (native file
// dialogs, OS window popouts) that cannot work over the remote connection.
export function isRemoteClient(): boolean {
  return typeof window !== "undefined" && window.__mdRemote === true;
}
