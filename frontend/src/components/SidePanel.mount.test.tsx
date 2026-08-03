// Mount-test SidePanel: switching the internal files/scm tab must NOT unmount the
// inactive panel. Regression test for the bug where SidePanel used conditional rendering
// (`tab === "files" ? <FilePanel/> : <GitPanel/>`), so flipping the tab unmounted the
// hidden panel and threw away its in-component state — expanded dirs / open file preview
// (FilePanel), commit draft / collapsed groups / expanded diff (GitPanel).
//
// Fix: both panels stay mounted; the tab toggle only flips a `side-hidden` CSS class.
// §5.3: pin the invariant "a tab switch keeps both panels mounted".

import { describe, test, expect, mock } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";

// ---- happy-dom setup (same as sibling *.mount.test.tsx) ----
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

mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  initReactI18next: { type: "3rd-party" },
}));

// FilePanel calls SessionListDir on mount + on dir expand; the rest are click-only.
// listDir returns a tiny tree so we can assert expand-state survives a tab round-trip.
const listDir = mock((_sid: string, dir: string) => {
  if (dir === "") return Promise.resolve([{ name: "src", path: "src", isDir: true }]);
  if (dir === "src") return Promise.resolve([{ name: "a.ts", path: "src/a.ts", isDir: false }]);
  return Promise.resolve([]);
});

mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => ({
  SessionListDir: listDir,
  SessionReadFile: mock(() => Promise.resolve("")),
  SessionReadImage: mock(() => Promise.resolve({ dataUrl: "" })),
  SessionCreateFile: mock(() => Promise.resolve()),
  SessionCreateDir: mock(() => Promise.resolve()),
  SessionRenamePath: mock(() => Promise.resolve()),
  SessionDeletePath: mock(() => Promise.resolve()),
  RevealPath: mock(() => Promise.resolve()),
}));

// Dynamic import: mock.module() must register BEFORE SidePanel (and its FilePanel import)
// is evaluated, so the chatservice mock wins over the real binding.
const { default: SidePanel } = await import("./SidePanel.tsx");

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

const noop = () => Promise.resolve();
const baseProps = {
  sessionId: "s1",
  rootName: "proj",
  rootPath: "/tmp/proj",
  changes: [] as never[],
  status: "idle",
  isGitProject: true,
  branch: "main",
  baseRef: "main",
  mergeResult: null,
  mergeable: false,
  isGuest: false,
  onMerge: noop,
  onStage: noop,
  onUnstage: noop,
  onDiscard: noop,
  onAICommit: noop,
  onCommit: noop,
  onDiff: mock(() => Promise.resolve("diff")),
  busy: false,
};

// Click the side-tab whose label matches the given i18n key (mocked t() returns the key).
function clickTab(host: HTMLElement, key: string) {
  const btn = [...host.querySelectorAll("button.side-tab")].find((b) =>
    b.textContent?.includes(key)
  );
  if (!btn) throw new Error(`tab ${key} not found`);
  btn.dispatchEvent(click());
}

describe("SidePanel: tab switch keeps both panels mounted", () => {
  test("files<->scm round-trip never unmounts the inactive panel", async () => {
    const { host } = mount(<SidePanel {...baseProps} />);
    await flush();

    const filePanel = () => host.querySelector('[data-testid="file-panel"]');
    const gitPanel = () => host.querySelector('[data-testid="git-panel"]');
    const fileHidden = () => filePanel()?.closest(".side-view")?.classList.contains("side-hidden");
    const gitHidden = () => gitPanel()?.closest(".side-view")?.classList.contains("side-hidden");

    // initial state: files active, scm mounted-but-hidden
    expect(filePanel()).not.toBeNull();
    expect(gitPanel()).not.toBeNull();
    expect(fileHidden()).toBe(false);
    expect(gitHidden()).toBe(true);

    // switch to scm
    clickTab(host, "sidePanel.scm");
    await flush();
    // files panel must still be in the DOM (regression: bug version unmounts it)
    expect(filePanel()).not.toBeNull();
    expect(fileHidden()).toBe(true);
    expect(gitHidden()).toBe(false);

    // switch back to files
    clickTab(host, "sidePanel.files");
    await flush();
    expect(fileHidden()).toBe(false);
    expect(gitHidden()).toBe(true);
  });

  test("FilePanel expanded dir survives a scm round-trip", async () => {
    const { host } = mount(<SidePanel {...baseProps} />);
    await flush();

    // root lists one dir "src"; expand it -> child "a.ts" renders
    expect(host.textContent).toContain("src");
    const srcRow = [...host.querySelectorAll(".tree-row")].find((r) =>
      r.textContent?.includes("src")
    ) as HTMLElement;
    expect(srcRow).toBeTruthy();
    srcRow.dispatchEvent(click());
    await flush();
    expect(host.textContent).toContain("a.ts");

    // flip to scm and back
    clickTab(host, "sidePanel.scm");
    await flush();
    clickTab(host, "sidePanel.files");
    await flush();

    // expanded dir + its child survive (regression: bug version re-mounts FilePanel with
    // an empty expanded set, so "a.ts" disappears until the user re-expands "src")
    expect(host.textContent).toContain("a.ts");
  });
});

describe("SidePanel: session switch restores FilePanel state", () => {
  test("expanded dir + child survive switching to another session and back", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    // session s1: expand "src" -> "a.ts" renders
    root.render(<SidePanel {...baseProps} sessionId="s1" key="s1" />);
    await flush();
    expect(host.textContent).toContain("src");
    const srcRow = [...host.querySelectorAll(".tree-row")].find((r) =>
      r.textContent?.includes("src")
    ) as HTMLElement;
    expect(srcRow).toBeTruthy();
    srcRow.dispatchEvent(click());
    await flush();
    expect(host.textContent).toContain("a.ts");

    // switch to session s2 (key change -> FilePanel unmounts, snapshot saved to cache).
    // s2 starts fresh (no expanded dirs), so "a.ts" must be gone.
    root.render(<SidePanel {...baseProps} sessionId="s2" key="s2" />);
    await flush();
    expect(host.textContent).not.toContain("a.ts");

    // switch back to s1 (FilePanel remounts, state restored from the per-session cache).
    // Regression: without the cache, the remount starts empty and "a.ts" only reappears
    // after the user manually re-expands "src".
    root.render(<SidePanel {...baseProps} sessionId="s1" key="s1" />);
    await flush();
    expect(host.textContent).toContain("a.ts");

    root.unmount();
  });
});
