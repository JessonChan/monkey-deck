// RemoteSettingsPane devices section: paired-device list rendering + kick.
// Mount-test per the repo's happy-dom convention (no shared util — each mount
// test carries its own minimal setup, cf. ChatView.virtual.mount.test).
import { describe, expect, mock, test, beforeEach } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";

// ---- happy-dom setup ----
const win = new Window();
globalThis.window = win;
globalThis.document = win.document;
globalThis.navigator = win.navigator;

// Real export names from the generated bindings (keeps the mock complete —
// same-process mock.module registry pollution guard, see 2026-08-23 editor
// worklog).
import * as realBindings from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";

const listSessions = mock(async () => [
  { ID: "abc123", Label: "iPhone · Safari", CreatedAt: "2026-08-23 16:05", LastSeen: "just now" },
  { ID: "def456", Label: "Android · Chrome", CreatedAt: "2026-08-23 16:07", LastSeen: "2m ago" },
]);
const revokeSession = mock(async () => true);
const getInfo = mock(async () => ({
  Enabled: true, Running: true, Port: 9260, Token: "verylongsecrettoken1234",
  URLs: ["http://192.168.1.5:9260"], Attached: true,
}));

const overrides: Record<string, unknown> = {
  GetRemoteInfo: getInfo,
  RemoteListSessions: listSessions,
  RemoteRevokeSession: revokeSession,
  SetRemoteEnabled: mock(async () => {}),
  SetRemotePort: mock(async () => {}),
  RegenerateRemoteToken: mock(async () => "newtok"),
  GenerateRemotePairingCode: mock(async () => ["123456", new Date(Date.now() + 600000).toISOString()]),
};
for (const [k, v] of Object.entries(realBindings)) {
  if (!(k in overrides)) overrides[k] = mock(async () => undefined);
}
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => overrides);

// Mocks BEFORE the dynamic import — static import would bind the real
// modules before the mocks exist (mock-ordering exception). react-i18next
// has no provider in happy-dom; stub the hook to identity keys.
mock.module("react-i18next", () => ({
  useTranslation: () => ({
    // Identity keys with {{var}} interpolation so meta assertions can see
    // the interpolated timestamps.
    t: (k: string, opts?: Record<string, unknown>) =>
      k === "settings.center.remote.deviceMeta"
        ? `paired ${opts?.paired} · seen ${opts?.seen}`
        : k,
  }),
}));
const { default: RemoteSettingsPane } = await import("./RemoteSettingsPane");

// Macro-task tick for React 19 commits + promise resolution in happy-dom.
const tick = async () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  await promise;
};

async function mount() {
  const rootEl = document.createElement("div");
  document.body.appendChild(rootEl);
  const root = createRoot(rootEl);
  root.render(React.createElement(RemoteSettingsPane));
  // Poll for the async pane data (info → devices) with a deadline instead of
  // a fixed tick count — happy-dom scheduling varies between runs.
  for (let i = 0; i < 50; i++) {
    await tick();
    if (rootEl.querySelectorAll('[data-testid="remote-device-row"]').length > 0) break;
  }
  return { root, rootEl };
}

describe("RemoteSettingsPane devices", () => {
  beforeEach(() => {
    listSessions.mockClear();
    revokeSession.mockClear();
  });

  test("renders one row per paired device with label/meta/kick", async () => {
    const { rootEl } = await mount();
    const rows = rootEl.querySelectorAll('[data-testid="remote-device-row"]');
    expect(rows.length).toBe(2);
    const labels = [...rootEl.querySelectorAll('[data-testid="remote-device-label"]')].map((e) => e.textContent);
    expect(labels).toContain("iPhone · Safari");
    expect(labels).toContain("Android · Chrome");
    expect(rootEl.querySelector(".remote-device-meta")?.textContent).toContain("2026-08-23 16:05");
    expect(rows[0].querySelector("button")).toBeTruthy();
  });

  test("kick calls RemoteRevokeSession with the session id and refreshes", async () => {
    const { rootEl } = await mount();
    const callsBefore = listSessions.mock.calls.length;
    const btn = rootEl.querySelectorAll('[data-testid^="remote-device-kick-"]')[0];
    btn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    for (let i = 0; i < 6; i++) await tick();
    expect(revokeSession.mock.calls.length).toBe(1);
    expect(revokeSession.mock.calls[0][0]).toBe("abc123");
    expect(listSessions.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
