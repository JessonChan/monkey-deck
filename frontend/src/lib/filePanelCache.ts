// Per-session snapshot of FilePanel's navigational state: expanded dirs, loaded
// directory listings, selected row. SidePanel is keyed by sessionId (App.tsx), so
// FilePanel is unmounted/remounted on every session-tab switch; this cache bridges
// the two mounts so the file tree reappears exactly as the user left it — expanded
// folders stay expanded.
//
// Process-local, not persisted: a restart starts fresh (the tree reloads from disk
// anyway). Cleared on tab close (App.closeTab) to avoid unbounded growth.

import type { FileNode } from "../../bindings/github.com/jessonchan/monkey-deck/internal/fsview/models";

export type ChildrenMap = Record<string, FileNode[]>;

export interface FilePanelSnapshot {
  expanded: Set<string>;
  children: ChildrenMap;
  selected: string | null;
  // Search UI state is snapshot-restored too (#167): reopening a session tab
  // brings back the open search row and the typed query. Results are NOT part
  // of the snapshot — the debounce search effect re-runs on remount.
  searchOpen: boolean;
  query: string;
}

const cache = new Map<string, FilePanelSnapshot>();

export function getFilePanelState(sid: string): FilePanelSnapshot | undefined {
  return cache.get(sid);
}

export function saveFilePanelState(sid: string, snap: FilePanelSnapshot): void {
  cache.set(sid, snap);
}

export function deleteFilePanelState(sid: string): void {
  cache.delete(sid);
}

// ── Recent file searches (#167) ──
// Project-level localStorage asset: the key is derived from the project root
// (App resolves sessionId → project and passes rootPath down), so every
// session of the same project shares one history. When the root is unknown
// (rootPath empty) the key degrades to per-session. Deliberately NOT cleared
// by tab close / session eviction (closeTab / evictSessionCache / purgeSession
// only touch the process-local snapshot Map) — the cap below is the only
// retention bound.
export const RECENT_FILE_SEARCH_CAP = 12;

export function recentFileSearchesKey(rootPath: string, sessionId: string): string {
  return rootPath !== ""
    ? `md:recent-file-searches:${rootPath}`
    : `md:recent-file-searches:${sessionId}`;
}

// Defensive read (same posture as Composer's md:recent-models): corrupt JSON,
// non-array shapes and non-string entries all degrade to a clean list.
export function loadRecentFileSearches(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const all = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(all)) return [];
    return all.filter((v): v is string => typeof v === "string").slice(0, RECENT_FILE_SEARCH_CAP);
  } catch {
    return [];
  }
}

// Move-to-front dedupe write, capped at RECENT_FILE_SEARCH_CAP. Blank queries
// are never recorded.
export function rememberRecentFileSearch(key: string, query: string): void {
  const q = query.trim();
  if (!q) return;
  try {
    const next = [q, ...loadRecentFileSearches(key).filter((x) => x !== q)].slice(0, RECENT_FILE_SEARCH_CAP);
    localStorage.setItem(key, JSON.stringify(next));
  } catch { /* storage unavailable/full: history is best-effort */ }
}

export function removeRecentFileSearch(key: string, query: string): void {
  try {
    localStorage.setItem(key, JSON.stringify(loadRecentFileSearches(key).filter((x) => x !== query)));
  } catch { /* noop */ }
}

