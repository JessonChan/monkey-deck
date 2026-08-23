import { describe, test, expect } from "bun:test";
import { createBadge, type BadgeEnv } from "./appBadge";

// Contract: bump counts attention events and pushes each new total to the
// platform; reset clears both counter and platform badge; an unsupported
// environment (desktop webview / plain tab) must stay completely inert.

function fakeEnv(supported: boolean) {
  const calls: string[] = [];
  const env: BadgeEnv = {
    supported: () => supported,
    set: (n) => calls.push(`set:${n}`),
    clear: () => calls.push("clear"),
  };
  return { calls, env };
}

test("bump accumulates and reports each new total", () => {
  const { calls, env } = fakeEnv(true);
  const badge = createBadge(env);
  badge.bump();
  badge.bump();
  badge.bump();
  expect(calls).toEqual(["set:1", "set:2", "set:3"]);
  expect(badge.value).toBe(3);
});

test("reset clears counter and platform badge; counting restarts at 1", () => {
  const { calls, env } = fakeEnv(true);
  const badge = createBadge(env);
  badge.bump();
  badge.reset();
  expect(calls).toEqual(["set:1", "clear"]);
  expect(badge.value).toBe(0);
  badge.bump();
  expect(calls).toEqual(["set:1", "clear", "set:1"]);
});

test("unsupported environment is fully inert (no calls, no phantom count)", () => {
  const { calls, env } = fakeEnv(false);
  const badge = createBadge(env);
  badge.bump();
  badge.bump();
  badge.reset();
  expect(calls).toEqual([]);
  expect(badge.value).toBe(0);
});
