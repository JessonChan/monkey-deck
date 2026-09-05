// Mount-test the #195 harness detail card: the fixed strip under the picker grid.
//
// Locks:
//   1. Nothing selected → faint placeholder, no detail rows.
//   2. Selecting a harness fills the rows (name / command / path / versions / install
//      state); switching harness refreshes every field — including the omission of the
//      path row when the executable was never discovered, and the gray "not installed"
//      value + user-defined chip on an uninstalled user harness.
//   3. Upgrade available → the ↗ marker with the upgradeHint tooltip; absent otherwise.
//   4. Copy affordances (command button, path click-to-copy) route through
//      copyTextQuiet from lib/clipboard (mocked — no real clipboard in tests).
//
// §5.3: pin invariants ("rows mirror the current selection"; "missing path → no row").

import { describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";
import type { Harness } from "../../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";

// ---- happy-dom setup (same as NewSessionModal.mount.test.tsx) ----
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
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

// MCP catalog: empty → no MCP section (same rationale as the sibling mount test).
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => ({
  ListMcpServers: async () => [],
}));

// Clipboard: capture copyTextQuiet calls; the detail card must not touch the real
// clipboard channels in tests.
const copyQuiet = mock((_text: string) => {});
mock.module("../lib/clipboard", () => ({ copyTextQuiet: copyQuiet }));

// Dynamic import: mock.module must register BEFORE the component module evaluates.
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

const pick = (host: Element, id: string) =>
  host.querySelector(`[data-testid="ns-harness-${id}"]`)!.dispatchEvent(click());

// Full Harness fixture: the detail card reads the runtime discovery fields
// (path / versions / upgradeAvailable / userDefined) the sibling test's partials omit.
const mk = (over: Partial<Harness> & { id: string }): Harness =>
  ({
    icon: "",
    userDefined: false,
    installed: true,
    upgradeAvailable: false,
    name: over.id,
    command: `${over.id} acp`,
    ...over,
  }) as unknown as Harness;

const OMP = mk({
  id: "omp",
  name: "Oh My Pi",
  command: "omp acp",
  path: "/Users/jesson/.bun/bin/omp",
  installedVersion: "1.2.3",
  latestVersion: "1.4.0",
  upgradeAvailable: true,
});

const GOOSE = mk({
  id: "goose",
  name: "Goose",
  command: "goose acp --stdio",
  installed: false,
  path: undefined,
  userDefined: true,
});

const mountModal = () =>
  mount(
    <NewSessionModal
      harnesses={[OMP, GOOSE]}
      isGit={false}
      lastHarness=""
      defaultBaseRef=""
      recentRefs={[]}
      branches={[]}
      worktrees={[]}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );

describe("NewSessionModal harness detail card (#195)", () => {
  test("nothing selected: faint placeholder, no detail rows", async () => {
    const { host } = mountModal();
    await flush();
    expect(host.querySelector('[data-testid="ns-detail-placeholder"]')!.textContent).toBe(
      "newSession.detailPlaceholder",
    );
    expect(host.querySelector('[data-testid="ns-detail-command"]')).toBeNull();
    expect(host.querySelector('[data-testid="ns-detail-install"]')).toBeNull();
  });

  test("selection fills the rows; switching harness refreshes every field", async () => {
    const { host } = mountModal();
    await flush();

    pick(host, "omp");
    await flush();
    expect(host.querySelector('[data-testid="ns-detail-name"]')!.textContent).toBe("Oh My Pi");
    expect(host.querySelector('[data-testid="ns-detail-command"]')!.textContent).toBe("omp acp");
    const path = host.querySelector('[data-testid="ns-detail-path"]')!;
    expect(path.textContent).toBe("/Users/jesson/.bun/bin/omp");
    expect(path.getAttribute("data-tooltip-content")).toBe("/Users/jesson/.bun/bin/omp");
    const version = host.querySelector('[data-testid="ns-detail-version"]')!;
    expect(version.textContent).toContain("1.2.3");
    expect(version.textContent).toContain("1.4.0");
    expect(host.querySelector('[data-testid="ns-detail-upgrade"]')!.getAttribute("data-tooltip-content")).toBe(
      "newSession.upgradeHint",
    );
    expect(host.querySelector('[data-testid="ns-detail-install"]')!.textContent).toBe(
      "newSession.detailInstalled",
    );
    expect(host.querySelector('[data-testid="ns-detail-chip"]')).toBeNull();

    pick(host, "goose");
    await flush();
    expect(host.querySelector('[data-testid="ns-detail-name"]')!.textContent).toBe("Goose");
    expect(host.querySelector('[data-testid="ns-detail-command"]')!.textContent).toBe("goose acp --stdio");
    // Never discovered on PATH → the whole path row is omitted.
    expect(host.querySelector('[data-testid="ns-detail-path"]')).toBeNull();
    // Not upgradeable → no marker; not installed → gray "not installed" value.
    expect(host.querySelector('[data-testid="ns-detail-upgrade"]')).toBeNull();
    const install = host.querySelector('[data-testid="ns-detail-install"]')!;
    expect(install.textContent).toBe("newSession.notInstalled");
    expect(install.classList.contains("ns-detail-muted")).toBe(true);
    // User harness → 自定义 chip.
    expect(host.querySelector('[data-testid="ns-detail-chip"]')!.textContent).toBe(
      "newSession.userDefinedChip",
    );
  });

  test("copy affordances route through copyTextQuiet (command button, path click)", async () => {
    const { host } = mountModal();
    await flush();
    pick(host, "omp");
    await flush();

    host.querySelector('[data-testid="ns-detail-copy"]')!.dispatchEvent(click());
    host.querySelector('[data-testid="ns-detail-path"]')!.dispatchEvent(click());
    await flush();
    expect(copyQuiet).toHaveBeenCalledTimes(2);
    expect(copyQuiet.mock.calls[0][0]).toBe("omp acp");
    expect(copyQuiet.mock.calls[1][0]).toBe("/Users/jesson/.bun/bin/omp");
  });
});
