// Lock the merge invariants behind remote:resync / openSession status
// reconciliation (issues #134/#127). Assertions target merge OUTCOMES, not field
// presence: each test reproduces a user-visible stuck-state bug and asserts the
// state it resolves to.
import { describe, expect, test } from "bun:test";
import { mergeStatusSnapshot, type StatusMap } from "./sessionStatusMerge";

describe("mergeStatusSnapshot", () => {
  test("#134 repro: snapshot absent + cached prompting → idle (lost idle push)", () => {
    // WS dropped mid-turn; the turn ended while disconnected. Backend has no live
    // harness for s1 → the stale "prompting" must be dropped, not kept forever.
    const prev: StatusMap = { s1: "prompting", s2: "idle" };
    const next = mergeStatusSnapshot(prev, { s2: "idle" });
    expect(next.s1).toBe("idle");
    expect(next.s2).toBe("idle");
  });

  test("#134 variant: stale reconnecting also cleared when harness is gone", () => {
    const next = mergeStatusSnapshot({ s1: "reconnecting" }, {});
    expect(next.s1).toBe("idle");
  });

  test("#127 repro: snapshot prompting overwrites stale empty/idle (missed prompting push)", () => {
    // Remote client connected mid-turn; never saw the prompting push. The snapshot
    // must lock the composer by reporting prompting.
    const next = mergeStatusSnapshot({ s1: "empty", s2: "idle" }, { s1: "prompting" });
    expect(next.s1).toBe("prompting");
    expect(next.s2).toBe("idle");
  });

  test("snapshot truth wins for every reported session", () => {
    const next = mergeStatusSnapshot({ s1: "idle", s2: "prompting", s3: "idle" }, { s1: "error", s2: "idle", s3: "reconnecting" });
    expect(next).toEqual({ s1: "error", s2: "idle", s3: "reconnecting" });
  });

  test("display states survive absence (no live harness still meaningful)", () => {
    const prev: StatusMap = { s1: "error", s2: "notice", s3: "readonly", s4: "closed" };
    const next = mergeStatusSnapshot(prev, {});
    expect(next).toEqual(prev);
  });

  test("pull/push race: a push received after pull-start beats the snapshot", () => {
    // snapshot(t0)="idle" lands AFTER the one-and-only prompting push → without the
    // guard the turn would show idle until turn end (#127 resurrected via race).
    const prev: StatusMap = { s1: "prompting" };
    const next = mergeStatusSnapshot(prev, { s1: "idle" }, () => true);
    expect(next.s1).toBe("prompting");
  });

  test("pull/push race: fresh sessions are exempt from the absent-sweep too", () => {
    // Push "prompting" arrived during the pull window; the snapshot (older) does
    // not list the session — sweeping it to idle would clobber the fresh push.
    const prev: StatusMap = { s1: "prompting" };
    const next = mergeStatusSnapshot(prev, {}, (sid) => sid === "s1");
    expect(next.s1).toBe("prompting");
  });

  test("unknown wire values are dropped, not cast into the union", () => {
    // Future backend statuses must not silently violate the frontend type; the
    // cached value stands and the session is not swept (it IS live per snapshot).
    const prev: StatusMap = { s1: "prompting" };
    const next = mergeStatusSnapshot(prev, { s1: "some-future-state" });
    expect(next).toBe(prev); // untouched, same reference
  });

  test("idempotent: no-op merge returns the previous reference (no rerender)", () => {
    const prev: StatusMap = { s1: "prompting", s2: "error" };
    expect(mergeStatusSnapshot(prev, { s1: "prompting" })).toBe(prev);
  });
});
