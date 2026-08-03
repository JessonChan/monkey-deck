// Per-session snapshot of FilePanel's navigational state: expanded dirs, loaded
// directory listings, selected row, and the open file preview. SidePanel is keyed by
// sessionId (App.tsx), so FilePanel is unmounted/remounted on every session-tab switch;
// this cache bridges the two mounts so the file tree reappears exactly as the user left
// it — expanded folders stay expanded, the open preview reopens.
//
// Process-local, not persisted: a restart starts fresh (the tree reloads from disk
// anyway). Cleared on tab close (App.closeTab) to avoid unbounded growth.

import type { FileNode } from "../../bindings/github.com/jessonchan/monkey-deck/internal/fsview/models";

export type ChildrenMap = Record<string, FileNode[]>;

export type Preview =
  | { kind: "text"; name: string; path: string; content: string }
  | { kind: "image"; name: string; path: string; url: string };

export interface FilePanelSnapshot {
  expanded: Set<string>;
  children: ChildrenMap;
  selected: string | null;
  preview: Preview | null;
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
