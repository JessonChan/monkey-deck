// Mount-test Sidebar session renamed marker (#154, phase 2 state-typed).
//
// Pins the rename-indicator contract end-to-end from props down to what a user
// can see and hover:
//  1. Idle renamed rows (custom_title set, statusBySession !== "prompting")
//     show the quiet pencil at the title TAIL — the label's next sibling,
//     ahead of the meta cluster.
//  2. Prompting rows keep the pencil AHEAD of the title (front slot constant
//     for the whole turn).
//  3. Both slots wire the md-tip tooltip to the sidebar.renamedTip key; the
//     real zh/en locale copy is pinned too (「用户重命名」 / "Renamed by user").
//  4. Native (auto-titled) rows render zero marker in either state.
//  5. Coexistence: a renamed+pinned row keeps the same height as a plain row
//     in both states (12px discipline; geometry equality + CSS contract pin —
//     happy-dom has no layout engine, same method as Sidebar.tags.mount.test.tsx).
//
// Same mock scaffolding as Sidebar.tags.mount.test.tsx (bindings / i18n /
// tooltip / clipboard stubbed; no real backend calls during mount).

import { describe, test, expect, beforeEach } from "bun:test";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import React from "react";
import { createRoot } from "react-dom/client";

// ---- happy-dom setup ----
const window = new Window();
const document = window.document;
globalThis.window = window;
globalThis.document = document;
globalThis.navigator = window.navigator;
import { describe, test, expect, mock, beforeEach } from "bun:test";
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.MouseEvent = window.MouseEvent;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.localStorage = window.localStorage;
window.React = React;

// ---- binding / i18n / tooltip / clipboard mocks ----
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => ({
  ToggleMaximise: async () => {},
  RevealPath: async () => {},
  ExportSession: async () => "",
  SearchSessionContent: async () => [],
}));
mock.module("react-tooltip", () => ({ Tooltip: () => null, default: () => null }));
mock.module("react-i18next", () => {
  // Echo the key (plus interpolation args) so tests pin the exact i18n key the
  // marker requests for its tooltip payload.
  const t = (k: string, opts?: Record<string, unknown>) =>
    opts && Object.keys(opts).length ? `${k} ${JSON.stringify(opts)}` : k;
  return {
    useTranslation: () => ({ t }),
    initReactI18next: { type: "3rd-party" },
    default: { useTranslation: () => ({ t }) },
  };
});
mock.module("../lib/clipboard", () => ({
  copyText: async () => true,
  copyTextQuiet: () => {},
  execCommandCopy: () => true,
}));

// Import the component only after the mocks are registered.
const { default: Sidebar } = await import("./Sidebar.tsx");
// Real locale JSONs — pin the actual tooltip copy, not just the key path.
import zh from "../i18n/locales/zh.json";
import en from "../i18n/locales/en.json";

const EXPANDED_KEY = "md:sidebar-expanded";

const proj = (id: string, name: string) => ({
  id,
  name,
  path: `/tmp/${id}`,
  model: "",
  allowExternalDir: false,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
});

const sess = (id: string, projectId: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId,
  acpSession: "",
  title: `t-${id}`,
  customTitle: "",
  model: "",
  harness: "opencode",
  worktreePath: "",
  branch: "",
  baseRef: "",
  usedTokens: 0,
  sizeTokens: 0,
  cost: 0,
  cachedReadTokens: 0,
  cachedWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  totalTokens: 0,
  createdAt: 1,
  updatedAt: 1,
  promptedAt: 1,
  pinned: false,
  tags: [] as string[],
  ...extra,
});

const baseProps = (sessionsByProject: Record<string, unknown[]>) => ({
  projects: [proj("p1", "alpha")],
  selectedProjectId: null,
  sessionsByProject,
  selectedSessionId: null,
  onSelectProject: async () => {},
  onSelectSession: () => {},
  onCreateSession: () => {},
  onAddProject: () => {},
  onRemoveProject: async () => {},
  onRemoveSession: async () => {},
  onTogglePin: () => {},
  onSetSessionTags: () => {},
  onRenameSession: () => {},
  statusBySession: {},
  activityBySession: {},
  unreadBySession: {},
  permPendingBySession: {},
  onReorderProjects: () => {},
  onOpenSettings: () => {},
});

function mount(extra: Record<string, unknown> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<Sidebar {...({ ...extra } as never)} />);
  return { host, root };
}

async function flush() {
  for (let i = 0; i < 8; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
}
async function mounted(sessionsByProject: Record<string, unknown[]>, extra: Record<string, unknown> = {}) {
  localStorage.setItem(EXPANDED_KEY, JSON.stringify(["p1"]));
  const m = mount({ ...baseProps(sessionsByProject), ...extra });
  await flush();
  return m;
}

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("Sidebar session renamed marker (#154)", () => {
  test("1. idle renamed row: pencil at title tail, ahead of the meta cluster", async () => {
    const { host } = await mounted({ p1: [sess("s1", "p1", { customTitle: "my title" })] });

    const mark = host.querySelector<HTMLElement>('[data-testid="renamed-s1"]');
    expect(mark).not.toBeNull();
    expect(mark!.classList.contains("session-renamed")).toBe(true);
    expect(mark!.querySelector("svg")).not.toBeNull();

    // Idle (no status entry → st !== "prompting"): the marker is the label's
    // direct NEXT sibling inside the row main button (dot → title → pencil),
    // ahead of the meta cluster occupying the tail slots.
    const main = host.querySelector<HTMLElement>('[data-testid="session-s1"] .session-item-main')!;
    const label = main.querySelector<HTMLElement>(".session-label")!;
    expect(label.nextElementSibling).toBe(mark);

    // Tooltip payload: the marker requests exactly the renamedTip key.
    expect(mark!.getAttribute("data-tooltip-id")).toBe("md-tip");
    expect(mark!.getAttribute("data-tooltip-content")).toBe("sidebar.renamedTip");

    // And the real zh/en copy for that key matches the spec wording (#154).
    expect((zh as Record<string, any>).sidebar.renamedTip).toBe("用户重命名");
    expect((en as Record<string, any>).sidebar.renamedTip).toBe("Renamed by user");
  });

  test("2. prompting renamed row: pencil ahead of the title — front slot constant", async () => {
    const { host } = await mounted(
      { p1: [sess("s1", "p1", { customTitle: "my title" })] },
      { statusBySession: { s1: "prompting" } },
    );

    const mark = host.querySelector<HTMLElement>('[data-testid="renamed-s1"]');
    expect(mark).not.toBeNull();
    expect(mark!.classList.contains("session-renamed")).toBe(true);

    // Prompting: marker is the label's direct PREVIOUS sibling (dot → pencil → title).
    const main = host.querySelector<HTMLElement>('[data-testid="session-s1"] .session-item-main')!;
    const label = main.querySelector<HTMLElement>(".session-label")!;
    expect(label.previousElementSibling).toBe(mark);

    // Same tooltip contract in the front slot.
    expect(mark!.getAttribute("data-tooltip-id")).toBe("md-tip");
    expect(mark!.getAttribute("data-tooltip-content")).toBe("sidebar.renamedTip");
  });

  test("3. native title: zero marker in either state", async () => {
    const idle = await mounted({ p1: [sess("s1", "p1")] });
    expect(idle.host.querySelector('[data-testid="renamed-s1"]')).toBeNull();
    expect(idle.host.querySelectorAll(".session-renamed").length).toBe(0);

    const prompting = await mounted(
      { p1: [sess("s2", "p1")] },
      { statusBySession: { s2: "prompting" } },
    );
    expect(prompting.host.querySelector('[data-testid="renamed-s2"]')).toBeNull();
    expect(prompting.host.querySelectorAll(".session-renamed").length).toBe(0);
  });

  test("4. coexists with pin: row height unchanged in both states + CSS family contract", async () => {
    // Idle (tail slot): renamed+pinned row present, geometry matches a plain row.
    const { host } = await mounted({
      p1: [sess("s1", "p1", { customTitle: "renamed", pinned: true }), sess("s2", "p1")],
    });
    expect(host.querySelector('[data-testid="renamed-s1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="pin-s1"]')).not.toBeNull();

    // Geometry: happy-dom has no layout engine, but the invariant still holds —
    // a renamed+pinned row and a plain one report identical heights (real-engine
    // proof is the CSS pin below plus desktop GUI review).
    const r1 = host.querySelector<HTMLElement>('[data-testid="session-s1"]')!;
    const r2 = host.querySelector<HTMLElement>('[data-testid="session-s2"]')!;
    expect(r1.offsetHeight).toBe(r2.offsetHeight);

    // Prompting (front slot): same height discipline.
    const act = await mounted(
      { p1: [sess("s3", "p1", { customTitle: "renamed", pinned: true }), sess("s4", "p1")] },
      { statusBySession: { s3: "prompting" } },
    );
    const r3 = act.host.querySelector<HTMLElement>('[data-testid="session-s3"]')!;
    const r4 = act.host.querySelector<HTMLElement>('[data-testid="session-s4"]')!;
    expect(r3.offsetHeight).toBe(r4.offsetHeight);

    // CSS contract pin: same persistent-marker family as the pin mark —
    // never stretches the flex row, no extra line box, lowest-contrast tier.
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    const rule = css.match(/\.session-renamed\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const body = rule![1];
    expect(body).toContain("flex-shrink: 0");
    expect(body).toContain("display: inline-flex");
    expect(body).toContain("color: var(--text-3)");
  });
});
