// Mount-test Sidebar scheduled-send alarm (#138 / issue #138).
//
// Pins the row-marker contract end-to-end from the prop the App derives out of
// authoritative chat:queue snapshots down to what a user can see/click:
//  1. A future entry renders the amber .scheduled-indicator chip (AlarmClock
//     glyph, tooltip keyed sidebar.scheduledTip) on that session row, with the
//     entry's {count, earliest} interpolated into the tip (#24916: "N pending").
//  2. Absent/empty prop → no chip anywhere; rows fall back to .session-time.
//  3. A past timestamp never renders the chip (the "> now" gate hides it early,
//     before the next backend snapshot drops the entry).
//  4. The alarm is an INDEPENDENT mark: a session with both a composer draft and
//     a pending schedule shows BOTH chips (neither masks the other).
//  5. Prominence rework (#141): the chip's exact geometry lives in CSS — here we
//     pin the DUE-SOON behavior: a send within DUE_SOON_MS renders .is-due-soon
//     immediately, and an entry crossing into the window flips its class via the
//     component's one-shot wake timer (no new snapshot, no prop change).
//
// Same mock scaffolding as Sidebar.batch.mount.test.tsx (bindings / i18n /
// tooltip / clipboard stubbed; no real backend calls during mount).

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { readFileSync } from "node:fs";
import { createRoot } from "react-dom/client";

// ---- happy-dom setup ----
const window = new Window();
const document = window.document;
globalThis.window = window;
globalThis.document = document;
globalThis.navigator = window.navigator;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
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
  // Echo the key, appending any interpolation args as JSON so tests can pin
  // which values the component feeds a tooltip (count/time for #24916).
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

const sess = (id: string, projectId: string) => ({
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
});

const baseProps = () => ({
  projects: [proj("p1", "alpha")],
  selectedProjectId: null,
  sessionsByProject: { p1: [sess("s1", "p1"), sess("s2", "p1"), sess("s3", "p1")] },
  selectedSessionId: null,
  onSelectProject: async () => {},
  onSelectSession: () => {},
  onCreateSession: () => {},
  onAddProject: () => {},
  onRemoveProject: async () => {},
  onRemoveSession: async () => {},
  onTogglePin: () => {},
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
  root.render(<Sidebar {...({ ...baseProps(), ...extra } as never)} />);
  return { host, root };
}

async function flush() {
  for (let i = 0; i < 8; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
}

async function mounted(extra: Record<string, unknown> = {}) {
  localStorage.setItem(EXPANDED_KEY, JSON.stringify(["p1"]));
  const m = mount(extra);
  await flush();
  return m;
}

const alarmChip = (host: HTMLElement, id: string): HTMLElement | null =>
  host.querySelector(`[data-testid="scheduled-${id}"]`);

describe("Sidebar scheduled-send alarm (#138)", () => {
  beforeEach(() => {
    localStorage.clear();
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  });

  test("future scheduled entry renders the alarm chip with its glyph", async () => {
    const future = Date.now() + 60 * 60_000;
    const { host } = await mounted({ scheduledBySession: { s1: { count: 2, earliest: future } } });

    const chip = alarmChip(host, "s1");
    expect(chip).not.toBeNull();
    expect(chip!.className).toContain("scheduled-indicator");
    // Far-future entry sits outside the due-soon window → static chip (#141).
    expect(chip!.className).not.toContain("is-due-soon");
    // AlarmClock lucide glyph inside the chip.
    expect(chip!.querySelector("svg")).not.toBeNull();
    // Tooltip carries the interpolated entry (mock echoes key + JSON args).
    const tip = chip!.getAttribute("data-tooltip-content")!;
    expect(tip).toContain("sidebar.scheduledTip");
    expect(tip).toContain('"count":2');

    // Other rows without schedules stay plain. The alarm is an INDEPENDENT mark,
    // so even the scheduled row's tail keeps its session-time fallback — the chip
    // never eats the exclusive tail slot (perm/unread/draft signals stay intact).
    expect(alarmChip(host, "s2")).toBeNull();
    expect(host.querySelectorAll(".session-time").length).toBe(3);
  });

  test("absent or empty prop renders no chips and keeps the session-time fallback", async () => {
    const { host } = await mounted({});
    expect(host.querySelectorAll(".scheduled-indicator").length).toBe(0);
    expect(host.querySelectorAll(".session-time").length).toBe(3);

    const none = await mounted({ scheduledBySession: {} });
    expect(none.host.querySelectorAll(".scheduled-indicator").length).toBe(0);
  });

  test("a past timestamp never renders the chip (> now gate)", async () => {
    const past = Date.now() - 60_000;
    const { host } = await mounted({ scheduledBySession: { s2: { count: 3, earliest: past } } });
    expect(alarmChip(host, "s2")).toBeNull();
    expect(host.querySelectorAll(".scheduled-indicator").length).toBe(0);
  });

  test("alarm and draft chips coexist on one row (independent marks)", async () => {
    const future = Date.now() + 5 * 60_000;
    const { host } = await mounted({
      draftBySession: { s3: "pending text" },
      scheduledBySession: { s3: { count: 1, earliest: future } },
    });
    expect(alarmChip(host, "s3")).not.toBeNull();
    expect(host.querySelector('[data-testid="draft-s3"]')).not.toBeNull();
  });

  test("an entry inside the due-soon window gets .is-due-soon right away", async () => {
    const soon = Date.now() + 20 * 1000;
    const { host } = await mounted({ scheduledBySession: { s1: { count: 1, earliest: soon } } });
    const chip = alarmChip(host, "s1");
    expect(chip).not.toBeNull();
    expect(chip!.className).toContain("scheduled-indicator");
    expect(chip!.className).toContain("is-due-soon");
  });

  test("crossing into the due-soon window flips the class via the one-shot wake", async () => {
    // 0.5s past the arming point: mounted OUTSIDE the window, then the armed
    // timeout fires mid-test and the class flips WITHOUT any prop change or
    // snapshot arriving — that's the whole point of the wake hook (#141).
    const { host } = await mounted({
      scheduledBySession: { s1: { count: 1, earliest: Date.now() + 60_000 + 500 } },
    });
    expect(alarmChip(host, "s1")!.className).not.toContain("is-due-soon");

    const deadline = Date.now() + 3000;
    let chip = alarmChip(host, "s1")!;
    while (!chip.className.includes("is-due-soon")) {
      if (Date.now() > deadline) throw new Error("wake timer never flipped .is-due-soon on");
      await new Promise<void>((r) => setTimeout(r, 25));
    }
    chip = alarmChip(host, "s1")!;
    expect(chip.className).toContain("scheduled-indicator");
  });

  test("colorway + geometry pinned to the #162 spec values, computed from the real stylesheet", async () => {
    // happy-dom resolves class rules only when the sheet is in the document:
    // inject the REAL index.css, then read computed values off a live chip —
    // no duplicated fixture values, the assertions read the shipped CSS.
    const style = document.createElement("style");
    style.textContent = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    document.head.appendChild(style);
    try {
      const future = Date.now() + 60 * 60_000;
      const { host } = await mounted({ scheduledBySession: { s1: { count: 2, earliest: future } } });
      const chip = alarmChip(host, "s1");
      expect(chip).not.toBeNull();
      const cs = getComputedStyle(chip!);
      // color: var(--amber) → #ffd60a (accept either computed form).
      expect(["#ffd60a", "rgb(255, 214, 10)"]).toContain(cs.color);
      // background: the exact spec'd tint (0.12, draft-indicator family).
      expect(cs.backgroundColor).toBe("rgba(255, 214, 10, 0.12)");
      // border-radius: 50% — back to the circular silhouette (#162).
      expect(cs.borderRadius).toBe("50%");
      // Fixed 14px box — the row-height invariant (rows with/without the chip match).
      expect(cs.width).toBe("14px");
      expect(cs.height).toBe("14px");
      // Glyph stays at 10px.
      const svg = chip!.querySelector("svg");
      expect(svg).not.toBeNull();
      const scs = getComputedStyle(svg!);
      expect(scs.width).toBe("10px");
      expect(scs.height).toBe("10px");
    } finally {
      style.remove();
    }
  });

  test("due-soon pulse binds the dedicated alarm-pulse keyframes, not perm-pulse (#28407)", async () => {
    // Mount a live due-soon chip, then retrieve the rule it selects from the
    // REAL injected stylesheet — happy-dom does not decompose the `animation`
    // shorthand into computed longhands (probed: every animation-* longhand
    // reads back empty), so stylesheet rule retrieval is the pinning mechanism.
    const style = document.createElement("style");
    style.textContent = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    document.head.appendChild(style);
    try {
      const soon = Date.now() + 20 * 1000;
      const { host } = await mounted({ scheduledBySession: { s1: { count: 1, earliest: soon } } });
      const chip = alarmChip(host, "s1");
      expect(chip!.className).toContain("is-due-soon");
      const rules: CSSRule[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        for (let i = 0; i < sheet.cssRules.length; i++) rules.push(sheet.cssRules[i]);
      }
      // The rule this very chip's class list selects…
      const dueSoon = rules.find((r) => (r as CSSStyleRule).selectorText === ".scheduled-indicator.is-due-soon");
      expect(dueSoon).toBeDefined();
      // …binds the calm dedicated pulse (1.6s alternate) and no longer the
      // perm-dot keyframes (old reference eliminated, clean cutover).
      const body = (dueSoon as CSSStyleRule).cssText;
      expect(body).toMatch(/animation:\s*alarm-pulse\b/);
      expect(body).not.toMatch(/perm-pulse/);
      expect(body).toMatch(/1\.6s/);
      expect(body).toMatch(/alternate/);
      // Keyframes ship with the spec'd ~1/10-amplitude endpoints (happy-dom
      // normalizes from/to → 0%/100%).
      const kf = rules.find((r) => /@keyframes\s+alarm-pulse\s*\{/.test(r.cssText));
      expect(kf).toBeDefined();
      const ktext = kf!.cssText;
      expect(ktext).toMatch(/0%\s*\{[^}]*\bopacity:\s*1\s*;/);
      expect(ktext).toMatch(/0%\s*\{[^}]*\bscale\(1\)/);
      expect(ktext).toMatch(/100%\s*\{[^}]*\bopacity:\s*0\.94/);
      expect(ktext).toMatch(/100%\s*\{[^}]*\bscale\(0\.98\)/);
    } finally {
      style.remove();
    }
  });
});
