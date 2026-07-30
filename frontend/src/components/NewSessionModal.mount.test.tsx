// Mount-test NewSessionModal with happy-dom + React.
//
// Locks the workdir-mode + existing-worktree selector behavior:
//   1. Nothing is pre-selected: "Create" stays disabled until the user picks a workdir mode
//      AND that mode's own choice (an existing dir / a base branch). OLD pre-selecting code
//      (useState(defaultBaseRef) or a default radio) → this test FAILS.
//   2. "Use existing directory": selector groups Project main → Other worktrees; picking the
//      main → onConfirm mode=project; picking a linked worktree → mode=enter (+enterPath).
//   3. "New worktree": base-ref selector groups Default → Recently used → All, each branch
//      exactly once; picking one → mode=new (+baseRef).
//
// §5.3: pin invariants ("explicit pick required"; "each item once in priority order").

import { describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";
import type { Harness } from "../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";
import type { BranchInfo, WorktreeInfo } from "../bindings/github.com/jessonchan/monkey-deck/internal/worktree/models";
import type { NewSessionChoice } from "./NewSessionModal";

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

// Dynamic import is intentional: mock.module() must register BEFORE the component module is
// evaluated so NewSessionModal picks up the mocked react-i18next. A static import would run
// first and bypass the mock (same pattern as every sibling *.mount.test.tsx).
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

// Extract the path from an existing-worktree option's testid ("ns-wt-option-<path>").
function wtPathsIn(container: Element | null): string[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll('[data-testid^="ns-wt-option-"]'))
    .map((el) => el.getAttribute("data-testid")!.slice("ns-wt-option-".length));
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
const WORKTREES: WorktreeInfo[] = [
  { path: "/proj", branch: "main", isMain: true },
  { path: "/proj/wt-a", branch: "md/aaa11111", isMain: false },
  { path: "/proj/wt-b", branch: "feat/x", isMain: false },
];
// Only the static id/name/command fields are read by the modal; the binding's Harness type
// also carries runtime install/version fields irrelevant to this DOM-level test.
const HARNESS = [{ id: "omp", name: "omp", command: "omp" }] as unknown as Harness[];

describe("NewSessionModal workdir mode", () => {
  test("nothing pre-selected — Create disabled until mode + existing dir both picked (→ project)", async () => {
    const onConfirm = mock((_c: NewSessionChoice) => {});
    const { host } = mount(
      <NewSessionModal
        harnesses={HARNESS}
        isGit
        lastHarness="omp"
        defaultBaseRef={DEFAULT}
        recentRefs={RECENT}
        branches={BRANCHES}
        worktrees={WORKTREES}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    await flush();
    // harness auto-picked (lastHarness=omp), but no workdir mode yet → Create disabled.
    let confirmBtn = host.querySelector('[data-testid="ns-confirm"]') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    // Pick "use existing" mode → still no dir picked → Create still disabled.
    host.querySelector('[data-testid="ns-worktree-existing"]')!.dispatchEvent(click());
    await flush();
    confirmBtn = host.querySelector('[data-testid="ns-confirm"]') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    // Open the existing-dir selector and pick the project main.
    host.querySelector('[data-testid="ns-existing-select"]')!.dispatchEvent(click());
    await flush();
    host.querySelector('[data-testid="ns-wt-option-/proj"]')!.dispatchEvent(click());
    await flush();
    confirmBtn = host.querySelector('[data-testid="ns-confirm"]') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
    confirmBtn.dispatchEvent(click());
    await flush();
    expect(onConfirm).toHaveBeenCalledWith({ harness: "omp", mode: "project" });
  });

  test("existing selector groups main → linked; picking a linked worktree → enter", async () => {
    const onConfirm = mock((_c: NewSessionChoice) => {});
    const { host } = mount(
      <NewSessionModal
        harnesses={HARNESS}
        isGit
        lastHarness="omp"
        defaultBaseRef={DEFAULT}
        recentRefs={RECENT}
        branches={BRANCHES}
        worktrees={WORKTREES}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    await flush();
    host.querySelector('[data-testid="ns-worktree-existing"]')!.dispatchEvent(click());
    await flush();
    host.querySelector('[data-testid="ns-existing-select"]')!.dispatchEvent(click());
    await flush();

    // Main group holds only the project main; linked group holds the rest, in given order.
    const mainGroup = host.querySelector('[data-testid="ns-wt-group-main"]');
    expect(wtPathsIn(mainGroup)).toEqual(["/proj"]);
    const linkedGroup = host.querySelector('[data-testid="ns-wt-group-linked"]');
    expect(wtPathsIn(linkedGroup)).toEqual(["/proj/wt-a", "/proj/wt-b"]);

    // Pick a linked worktree → onConfirm mode=enter + its path.
    host.querySelector('[data-testid="ns-wt-option-/proj/wt-b"]')!.dispatchEvent(click());
    await flush();
    const confirmBtn = host.querySelector('[data-testid="ns-confirm"]') as HTMLButtonElement;
    confirmBtn.dispatchEvent(click());
    await flush();
    expect(onConfirm).toHaveBeenCalledWith({ harness: "omp", mode: "enter", enterPath: "/proj/wt-b" });
  });
});

describe("NewSessionModal new-worktree base-ref selector", () => {
  test("groups Default → Recently used → All, each branch exactly once; pick → new", async () => {
    const onConfirm = mock((_c: NewSessionChoice) => {});
    const { host } = mount(
      <NewSessionModal
        harnesses={HARNESS}
        isGit
        lastHarness="omp"
        defaultBaseRef={DEFAULT}
        recentRefs={RECENT}
        branches={BRANCHES}
        worktrees={WORKTREES}
        onConfirm={onConfirm}
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
    const defNames = Array.from(defGroup!.querySelectorAll('[data-testid^="ns-base-ref-option-"]'))
      .map((el) => el.getAttribute("data-testid")!.slice("ns-base-ref-option-".length));
    expect(defNames).toEqual(["main"]);
    expect(defGroup!.querySelector(".ns-baseref-default")).not.toBeNull();

    // Recently used + All keep the expected order.
    const recNames = Array.from(host.querySelector('[data-testid="ns-base-ref-group-recent"]')!.querySelectorAll('[data-testid^="ns-base-ref-option-"]'))
      .map((el) => el.getAttribute("data-testid")!.slice("ns-base-ref-option-".length));
    expect(recNames).toEqual(["develop", "feature-x"]);
    const allNames = Array.from(host.querySelector('[data-testid="ns-base-ref-group-all"]')!.querySelectorAll('[data-testid^="ns-base-ref-option-"]'))
      .map((el) => el.getAttribute("data-testid")!.slice("ns-base-ref-option-".length));
    expect(allNames).toEqual(["origin/main", "release-1.0"]);

    // Pick develop → onConfirm mode=new + baseRef.
    host.querySelector('[data-testid="ns-base-ref-option-develop"]')!.dispatchEvent(click());
    await flush();
    const confirmBtn = host.querySelector('[data-testid="ns-confirm"]') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
    confirmBtn.dispatchEvent(click());
    await flush();
    expect(onConfirm).toHaveBeenCalledWith({ harness: "omp", mode: "new", baseRef: "develop" });
  });
});
