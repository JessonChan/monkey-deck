import { describe, test, expect } from "bun:test";
import { createBackStack, type BackStackEnv } from "./backStack";

// Fake environment: counts pushState/back calls, lets tests fire popstate.
// Contract under test (M2 PWA back stack):
//   1. back gesture (popstate) closes the TOP pushed layer, nothing else;
//   2. UI-close consumes its own history entry via back(), and the popstate
//      that back() produces is swallowed (never closes another layer);
//   3. desktop-registered layers (≤768px gate off) own no history entry:
//      popstate leaves them open and cleanup never calls back();
//   4. a popstate nobody owns is passed through (default browser behavior).

function fakeEnv(mobile = true) {
  const state = { pushes: 0, backs: 0, listeners: [] as Array<() => void> };
  const env: BackStackEnv = {
    pushState: () => { state.pushes++; },
    back: () => { state.backs++; },
    onPopState: (fn) => {
      state.listeners.push(fn);
      return () => { state.listeners = state.listeners.filter((f) => f !== fn); };
    },
    isMobileViewport: () => mobile,
  };
  return { state, env, pop: () => [...state.listeners].forEach((f) => f()) };
}

test("back gesture closes the top layer and consumes its entry (no extra back)", () => {
  const { state, env, pop } = fakeEnv();
  const stack = createBackStack(env);
  const closed: string[] = [];
  const remove = stack.push("a", () => closed.push("a"));
  expect(state.pushes).toBe(1);
  pop(); // user back gesture
  expect(closed).toEqual(["a"]);
  expect(state.backs).toBe(0); // popstate itself consumed the entry
  remove(); // post-close cleanup (unmount) must NOT back() again
  expect(state.backs).toBe(0);
});

test("UI close consumes its own entry; the resulting popstate is swallowed", () => {
  const { state, env, pop } = fakeEnv();
  const stack = createBackStack(env);
  const closed: string[] = [];
  const remove = stack.push("a", () => closed.push("a"));
  remove(); // closed via scrim/Esc, not via back gesture
  expect(state.backs).toBe(1);
  pop(); // the popstate fired by our own back()
  expect(closed).toEqual([]); // must not re-close / close anything
  expect(state.backs).toBe(1);
});

test("stacked layers: back gestures close top-first, one per press", () => {
  const { env, pop } = fakeEnv();
  const stack = createBackStack(env);
  const closed: string[] = [];
  const rmA = stack.push("a", () => closed.push("a"));
  stack.push("b", () => closed.push("b"));
  pop(); // first back gesture → closes b (top); its entry is consumed by the popstate
  expect(closed).toEqual(["b"]);
  rmA(); // a closed via UI → back() consumes a's entry
  pop(); // popstate from our own back() → swallowed
  expect(closed).toEqual(["b"]); // a was closed by rmA's removal, never by a popstate
});

test("desktop (>768px): no pushState, popstate passes through, cleanup no-op", () => {
  const { state, env, pop } = fakeEnv(false);
  const stack = createBackStack(env);
  const closed: string[] = [];
  const remove = stack.push("a", () => closed.push("a"));
  expect(state.pushes).toBe(0); // gate: never touched desktop history
  pop(); // user pressed browser-back on a desktop remote browser
  expect(closed).toEqual([]); // layer does not own the popstate → default nav
  remove();
  expect(state.backs).toBe(0); // nothing of ours to consume
});

test("duplicate id push is ignored (React effect re-runs are safe)", () => {
  const { state, env } = fakeEnv();
  const stack = createBackStack(env);
  stack.push("a", () => {});
  const remove2 = stack.push("a", () => {});
  expect(state.pushes).toBe(1);
  remove2();
});

test("popstate with an empty stack is a harmless no-op", () => {
  const { env, pop } = fakeEnv();
  const stack = createBackStack(env);
  const remove = stack.push("a", () => {});
  remove();
  pop(); // stray popstate after everything closed
  pop();
  expect(true).toBe(true); // reached without throwing
});

test("dispose unsubscribes the popstate listener", () => {
  const { state, env, pop } = fakeEnv();
  const stack = createBackStack(env);
  const closed: string[] = [];
  stack.push("a", () => closed.push("a"));
  stack.dispose();
  pop();
  expect(closed).toEqual([]); // listener gone
  expect(state.listeners.length).toBe(0);
});
