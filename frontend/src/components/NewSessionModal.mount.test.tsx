// Mount-test NewSessionModal with happy-dom + React.
//
// Locks the worktree base-ref selector behavior rework (2026-07-30):
//   1. baseRef is NEVER pre-selected — "Create" stays disabled until the user picks a
//      branch explicitly (the old code pre-filled the detected default, which caused
//      wrong-base mistakes). OLD code (useState(defaultBaseRef)) → this test FAILS
//      because Create is enabled immediately.
//   2. The dropdown groups branches Default → Recently used → All, each branch appears
//      EXACTLY ONCE (no duplication), in that priority. Default is excluded from Recent;
//      both are excluded from All; All keeps backend committerdate-desc order.
//   3. Picking a branch closes the dropdown, enables Create, and surfaces the choice to
//      onConfirm.
//
// §5.3: pin the invariant ("each branch once, in priority order") rather than ad-hoc shape.

import { describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";
import type { Harness } from "../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";
import type { BranchInfo } from "../bindings/github.com/jessonchan/monkey-deck/internal/worktree/models";

// ---- happy-dom setup (same as ModelSelect/Composer mount tests) ----
const window = new Window();
const document = window.document;
globalThis.window = window;
globalThis.document = document;
globalThis.navigator = window.navigator;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.MouseEvent = window.MouseEvent;
window.React = React;

// react-i18next: return the key so the DOM is predictable.
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: "3rd-party" },
}));

// Dynamic import is intentional: mock.module() must register BEFORE the component module
// is evaluated so NewSessionModal picks up the mocked react-i18next. A static import would
// run first and bypass the mock (same pattern as every sibling *.mount.test.tsx).
const { default: NewSessionModal } = await import("./NewSessionModal.tsx");

function mount(jsx: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(jsx);
  return { host, root };
}

async function flush() {
  for (let i = 0; i < 8; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
}

const click = () => new window.MouseEvent("click", { bubbles: true, button: 0 });

// Branch names from an option element's data-testid ("ns-base-ref-option-<name>").
function namesIn(container: Element | null): string[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll('[data-testid^="ns-base-ref-option-"]'))
    .map((el) => el.getAttribute("data-testid")!.slice("ns-base-ref-option-".length));
}

// Backend ListBranches returns committerdate-desc; dates below encode that order.
const BRANCHES: BranchInfo[] = [
  { name: "feature-x", kind: "local", date: 3000 },
  { name: "develop", kind: "local", date: 2000 },
  { name: "origin/main", kind: "remote", date: 1500 },
  { name: "main", kind: "local", date: 1000 },
  { name: "release-1.0", kind: "local", date: 500 },
];
const DEFAULT = "main";
const RECENT = ["develop", "feature-x"]; // most-recent-first
// Only the static id/name/command fields are read by the modal; the binding's Harness type
// also carries runtime install/version fields irrelevant to this DOM-level test.
const HARNESS = [{ id: "omp", name: "omp", command: "omp" }] as unknown as Harness[];

describe("NewSessionModal base-ref selector", () => {
  test("baseRef is NOT pre-selected — Create disabled until an explicit pick", async () => {
    const { host } = mount(
      <NewSessionModal
        harnesses={HARNESS}
        isGit
        lastHarness="omp"
        defaultBaseRef={DEFAULT}
        recentRefs={RECENT}
        branches={BRANCHES}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await flush();
    // Pick worktree mode to reveal the base-ref field.
    host.querySelector('[data-testid="ns-worktree-new"]')!.dispatchEvent(click());
    await flush();
    // Create MUST be disabled: nothing was pre-selected for the user.
    const confirmBtn = host.querySelector('[data-testid="ns-confirm"]') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  test("groups Default → Recently used → All, each branch exactly once", async () => {
    const { host } = mount(
      <NewSessionModal
        harnesses={HARNESS}
        isGit
        lastHarness="omp"
        defaultBaseRef={DEFAULT}
        recentRefs={RECENT}
        branches={BRANCHES}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await flush();
    host.querySelector('[data-testid="ns-worktree-new"]')!.dispatchEvent(click());
    await flush();
    host.querySelector('[data-testid="ns-base-ref-select"]')!.dispatchEvent(click());
    await flush();

    // Default group: only the detected default, starred.
    const defGroup = host.querySelector('[data-testid="ns-base-ref-group-default"]');
    expect(defGroup).not.toBeNull();
    expect(namesIn(defGroup)).toEqual(["main"]);
    expect(defGroup!.querySelector(".ns-baseref-default")).not.toBeNull(); // ★ marker

    // Recently used: recentRefs order, default excluded.
    const recGroup = host.querySelector('[data-testid="ns-base-ref-group-recent"]');
    expect(namesIn(recGroup)).toEqual(["develop", "feature-x"]);

    // All: the rest, in backend date-desc order.
    const allGroup = host.querySelector('[data-testid="ns-base-ref-group-all"]');
    expect(namesIn(allGroup)).toEqual(["origin/main", "release-1.0"]);

    // Invariant: every branch appears exactly once across the whole list, no dups.
    const allNames = namesIn(host.querySelector(".ns-baseref-list"));
    expect(allNames.length).toBe(new Set(allNames).size);
    expect(new Set(allNames)).toEqual(new Set(BRANCHES.map((b) => b.name)));
  });

  test("picking a branch closes the dropdown, enables Create, surfaces to onConfirm", async () => {
    const onConfirm = mock(() => {});
    const { host } = mount(
      <NewSessionModal
        harnesses={HARNESS}
        isGit
        lastHarness="omp"
        defaultBaseRef={DEFAULT}
        recentRefs={RECENT}
        branches={BRANCHES}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    await flush();
    host.querySelector('[data-testid="ns-worktree-new"]')!.dispatchEvent(click());
    await flush();
    host.querySelector('[data-testid="ns-base-ref-select"]')!.dispatchEvent(click());
    await flush();
    host.querySelector('[data-testid="ns-base-ref-option-develop"]')!.dispatchEvent(click());
    await flush();

    // Dropdown closed after the pick.
    expect(host.querySelector('[data-testid="ns-base-ref-option-develop"]')).toBeNull();
    const confirmBtn = host.querySelector('[data-testid="ns-confirm"]') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
    confirmBtn.dispatchEvent(click());
    await flush();
    expect(onConfirm).toHaveBeenCalledWith("omp", true, "develop");
  });
});
