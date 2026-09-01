// chatservice-mock.ts — one shared FULL-surface mock for the ChatService
// binding, for all mount tests (#172 Phase 3 review follow-up).
//
// Why: bun's mock.module() is a process-global replacement. Tests each
// hand-picked a PARTIAL function list; when several test files run in one
// bun process, the LAST registration wins for every other file — components
// importing a function missing from that file's mock crashed (McpChip →
// GetSessionMcpServers undefined killed ChatView.fork tests in batch runs).
//
// Fix: a complete surface where every exported function has a benign async
// default. Tests override individual functions via mockChatservice({...}).
// The function list is derived from the generated binding file, so a stale
// mock fails loudly ("X is not a function" on the binding surface) instead of
// silently dropping a method.
import * as Binding from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";

type BindingModule = typeof Binding;

// Bun's `mock.module` type comes from bun:test, which has no type
// declarations under this tsconfig (test files are excluded from checking);
// the injector shape is all this module needs.
export type ModuleMocker = (path: string, factory: () => unknown) => void;

// mockChatservice covers the FULL binding surface; every function not
// overridden resolves to undefined (mount-time effects only need the promise
// to settle). Unknown override names throw — a typo must fail loudly.
export function mockChatservice(overrides: Record<string, unknown> = {}): BindingModule {
  const surface: Record<string, unknown> = {};
  for (const name of Object.keys(Binding)) {
    surface[name] = overrides[name] ?? (async () => undefined);
  }
  for (const name of Object.keys(overrides)) {
    if (!(name in Binding)) {
      throw new Error(`mockChatservice: ${name} is not exported by the chatservice binding`);
    }
  }
  return surface as unknown as BindingModule;
}

// registerChatserviceMock wires the full-surface mock via the injected
// mock.module. Call BEFORE importing any component module (module-loading
// boundary, same rule as the per-file inline mocks it replaces).
export function registerChatserviceMock(mockModule: ModuleMocker, overrides: Record<string, unknown> = {}): void {
  mockModule("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => mockChatservice(overrides));
}
