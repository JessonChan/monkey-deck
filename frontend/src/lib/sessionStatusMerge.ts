// Pure merge of the backend's read-only status snapshot (ChatService.SessionStatuses)
// into the cached per-session status map — the reconciliation behind remote:resync
// and openSession (issues #134/#127). Extracted as a pure function so unit tests can
// lock the merge invariants (same pattern as sessionDrop.ts).
import type { StatusPayload } from "../types";

export type StatusMap = Record<string, StatusPayload["status"] | "empty">;

// The only values SessionStatuses legitimately reports (derived backend-side from
// live-harness truth). Unknown wire values are dropped instead of flowing into state
// typed as the union — a string the type layer doesn't know about must not silently
// violate StatusPayload["status"].
const LIVE_STATUSES: ReadonlySet<string> = new Set(["prompting", "reconnecting", "error", "idle"]);

/**
 * Merge rules:
 * - In snapshot: backend truth wins (authoritative at pull time).
 * - Absent from snapshot: no live harness — stale liveness states
 *   (prompting/reconnecting) reset to idle (#134: the idle push was lost to a WS
 *   gap); display states (error/notice/readonly/...) carry meaning without a live
 *   harness and are kept as-is.
 * - `isFresh` (optional): returns true for sessions whose chat:status push arrived
 *   AFTER the pull started. WS delivery is ordered, so such a push is strictly
 *   fresher than the snapshot for that session — the snapshot must not touch it,
 *   in either direction (a snapshot(t0)="idle" applying after the one-and-only
 *   "prompting" push would stick idle for the whole turn: #127 resurrected by the
 *   pull/push race). Local optimistic writes need no guard — every real turn start
 *   also emits a prompting push that re-asserts over the snapshot.
 *
 * Returns `prev` by reference when nothing changed (idempotent no-rerender guard).
 */
export function mergeStatusSnapshot(
  prev: StatusMap,
  live: Record<string, string>,
  isFresh?: (sessionId: string) => boolean,
): StatusMap {
  let changed = false;
  const next = { ...prev };
  for (const [sid, raw] of Object.entries(live)) {
    if (isFresh?.(sid)) continue;
    if (!LIVE_STATUSES.has(raw)) continue;
    const st = raw as StatusPayload["status"];
    if (next[sid] !== st) {
      next[sid] = st;
      changed = true;
    }
  }
  for (const sid of Object.keys(next)) {
    if (!(sid in live) && !isFresh?.(sid) && (next[sid] === "prompting" || next[sid] === "reconnecting")) {
      next[sid] = "idle";
      changed = true;
    }
  }
  return changed ? next : prev;
}
