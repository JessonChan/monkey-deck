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
//   4. Every confirmed choice carries mcpServerIDs (per-session MCP selection; empty
//      catalog → []), i.e. the field never goes missing from NewSessionChoice.
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

// ChatService bindings: ListMcpServers mock. The modal loads the global MCP catalog on
// mount; without a mock the wails runtime call attempts a real fetch and rejects (caught
// by the component). Empty catalog → no MCP section, every onConfirm carries
// mcpServerIDs: []. Module shape must match the component's namespace import.
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => ({
  ListMcpServers: async () => [],
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
  { path: "/proj", branch: "main", isMain: true, date: 300 },
  { path: "/proj/wt-a", branch: "md/aaa11111", isMain: false, date: 200 },
  { path: "/proj/wt-b", branch: "feat/x", isMain: false, date: 100 },
];
// id/name/command/installed are the fields the modal reads for the grid (#188); the
// binding's Harness type carries more runtime discovery fields irrelevant to this
// DOM-level test. lastHarness="" + >1 harness → nothing pre-selected.
const h = (id: string, installed: boolean): Harness =>
  ({ id, name: id, command: `${id} acp`, installed }) as unknown as Harness;
const HARNESS = [h("omp", true)];

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
    expect(onConfirm).toHaveBeenCalledWith({ harness: "omp", mode: "project", mcpServerIDs: [] });
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
    expect(onConfirm).toHaveBeenCalledWith({ harness: "omp", mode: "enter", enterPath: "/proj/wt-b", mcpServerIDs: [] });
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
    expect(onConfirm).toHaveBeenCalledWith({ harness: "omp", mode: "new", baseRef: "develop", mcpServerIDs: [] });
  });
});

describe("NewSessionModal quick picks", () => {
  test("existing-dir quick picks: main + 2 recent linked by date desc; click → enter", async () => {
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
    const qp = host.querySelector('[data-testid="ns-wt-quickpicks"]');
    expect(qp).not.toBeNull();
    const paths = Array.from(qp!.querySelectorAll("button"))
      .map((b) => b.getAttribute("data-testid")!.slice("ns-wt-quick-".length));
    // main first, then linked by HEAD date desc: wt-a(200) before wt-b(100).
    expect(paths).toEqual(["/proj", "/proj/wt-a", "/proj/wt-b"]);
    // Clicking a linked quick pick selects it (enter) without opening the dropdown.
    host.querySelector('[data-testid="ns-wt-quick-/proj/wt-a"]')!.dispatchEvent(click());
    await flush();
    host.querySelector('[data-testid="ns-confirm"]')!.dispatchEvent(click());
    await flush();
    expect(onConfirm).toHaveBeenCalledWith({ harness: "omp", mode: "enter", enterPath: "/proj/wt-a", mcpServerIDs: [] });
  });

  test("base-ref quick picks: main + 2 recent; click selects without opening dropdown", async () => {
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
    const qp = host.querySelector('[data-testid="ns-base-ref-quickpicks"]');
    expect(qp).not.toBeNull();
    const names = Array.from(qp!.querySelectorAll("button"))
      .map((b) => b.getAttribute("data-testid")!.slice("ns-base-ref-quick-".length));
    // detected default (main) + up to 2 recent, all existing.
    expect(names).toEqual(["main", "develop", "feature-x"]);
    // Click develop (dropdown stays closed) → onConfirm mode=new baseRef=develop.
    host.querySelector('[data-testid="ns-base-ref-quick-develop"]')!.dispatchEvent(click());
    await flush();
    host.querySelector('[data-testid="ns-confirm"]')!.dispatchEvent(click());
    await flush();
    expect(onConfirm).toHaveBeenCalledWith({ harness: "omp", mode: "new", baseRef: "develop", mcpServerIDs: [] });
  });
});

describe("NewSessionModal harness grid", () => {
  // Deliberately unsorted input: installed {opencode, omp} then uninstalled {goose, claude}.
  // Expected: omp (default) jumps to the head of the installed group; relative order is
  // otherwise preserved (stable sort) — uninstalled tail keeps goose before claude.
  const GRID = [h("opencode", true), h("omp", true), h("goose", false), h("claude", false)];

  // Card testids in DOM order inside the grid container.
  function gridIds(host: Element): string[] {
    return Array.from(host.querySelectorAll('[data-testid="ns-harness-grid"] > button'))
      .map((b) => b.getAttribute("data-testid")!.slice("ns-harness-".length));
  }

  test("renders every harness as a grid card; installed first, default (omp) at the head", async () => {
    const { host } = mount(
      <NewSessionModal harnesses={GRID} isGit={false} lastHarness="" defaultBaseRef="" recentRefs={[]} branches={[]} worktrees={[]} onConfirm={() => {}} onCancel={() => {}} />,
    );
    await flush();
    expect(gridIds(host)).toEqual(["omp", "opencode", "goose", "claude"]);
  });

  test("click selects a card: active class + check badge; confirm carries the picked id", async () => {
    const onConfirm = mock((_c: NewSessionChoice) => {});
    const { host } = mount(
      <NewSessionModal harnesses={GRID} isGit={false} lastHarness="" defaultBaseRef="" recentRefs={[]} branches={[]} worktrees={[]} onConfirm={onConfirm} onCancel={() => {}} />,
    );
    await flush();
    // Nothing pre-selected: no active card, no check badge anywhere.
    expect(host.querySelector(".ns-harness.active")).toBeNull();
    expect(host.querySelector('[data-testid="ns-harness-check"]')).toBeNull();

    host.querySelector('[data-testid="ns-harness-opencode"]')!.dispatchEvent(click());
    await flush();
    const card = host.querySelector('[data-testid="ns-harness-opencode"]')!;
    expect(card.classList.contains("active")).toBe(true);
    expect(card.querySelector('[data-testid="ns-harness-check"]')).not.toBeNull();

    host.querySelector('[data-testid="ns-confirm"]')!.dispatchEvent(click());
    await flush();
    expect(onConfirm).toHaveBeenCalledWith({ harness: "opencode", mode: "project", mcpServerIDs: [] });
  });

  test("uninstalled cards: dimmed + corner badge + command only in the merged tooltip", async () => {
    const { host } = mount(
      <NewSessionModal harnesses={GRID} isGit={false} lastHarness="" defaultBaseRef="" recentRefs={[]} branches={[]} worktrees={[]} onConfirm={() => {}} onCancel={() => {}} />,
    );
    await flush();
    const goose = host.querySelector('[data-testid="ns-harness-goose"]')!;
    expect(goose.classList.contains("uninstalled")).toBe(true);
    expect(goose.querySelector('[data-testid="ns-harness-uninstalled-goose"]')).not.toBeNull();
    // Command chip is gone from the card face; the tooltip (t-mocked → key for the status
    // line) carries name + command + install state instead.
    expect(goose.querySelector(".ns-harness-cmd")).toBeNull();
    expect(goose.getAttribute("data-tooltip-content")).toBe("goose\ngoose acp\nnewSession.notInstalled");

    // Installed card: no dimming, no badge, tooltip = name + command only.
    const omp = host.querySelector('[data-testid="ns-harness-omp"]')!;
    expect(omp.classList.contains("uninstalled")).toBe(false);
    expect(omp.querySelector(".ns-harness-badge-uninstalled")).toBeNull();
    expect(omp.getAttribute("data-tooltip-content")).toBe("omp\nomp acp");
  });

  // #196: installed binary but the catalog pins no verified ACP entry command
  // (needsAdapter) — still listed, yet locked: disabled + dimmed + corner chip,
  // tooltip names the missing piece, clicks never select it.
  const lockedHarness = (id: string): Harness =>
    ({ id, name: id, command: `${id} acp`, installed: true, needsAdapter: true }) as unknown as Harness;

  test("needs-adapter cards: dimmed + chip + tooltip line, ranked to the tail, not selectable", async () => {
    const { host } = mount(
      <NewSessionModal harnesses={[lockedHarness("claude"), h("opencode", true)]} isGit={false} lastHarness="" defaultBaseRef="" recentRefs={[]} branches={[]} worktrees={[]} onConfirm={() => {}} onCancel={() => {}} />,
    );
    await flush();
    // Usable installed first; the locked card sinks into the dimmed tail (#188 rank).
    expect(gridIds(host)).toEqual(["opencode", "claude"]);

    const claude = host.querySelector('[data-testid="ns-harness-claude"]')!;
    expect(claude.classList.contains("needs-adapter")).toBe(true);
    expect(claude.classList.contains("uninstalled")).toBe(false);
    expect(claude.getAttribute("disabled")).not.toBeNull();
    expect(claude.querySelector('[data-testid="ns-harness-needs-adapter-claude"]')).not.toBeNull();
    expect(claude.getAttribute("data-tooltip-content")).toBe(
      "claude\nclaude acp\nsettings.harness.needsAcpAdapter",
    );

    // Clicking a locked card must not select it (no active class, no check badge).
    claude.dispatchEvent(click());
    await flush();
    expect(claude.classList.contains("active")).toBe(false);
    expect(host.querySelector('[data-testid="ns-harness-check"]')).toBeNull();
  });

  test("needs-adapter cards are skipped by preselection (single-card auto-select)", async () => {
    const { host } = mount(
      <NewSessionModal harnesses={[lockedHarness("claude")]} isGit={false} lastHarness="" defaultBaseRef="" recentRefs={[]} branches={[]} worktrees={[]} onConfirm={() => {}} onCancel={() => {}} />,
    );
    await flush();
    expect(host.querySelector(".ns-harness.active")).toBeNull();
  });
});
