// streamMerge turn-scoping tests (#209): a harness that replays history after
// resume (codebuddy, production forensic 2026-09-09) re-emits tool_call /
// message events carrying the SAME toolCallId/messageId from an earlier turn.
// Raw ids as merge keys made the replay patch the OLD item in place (content
// in the wrong position) and produced duplicate React keys that corrupted the
// virtual list (wrong heights, jumbled layout). Keys must carry the turn.
import { describe, test, expect } from "bun:test";
import { applyEventToItems } from "./streamMerge";
import type { ChatItem, SessionEvent } from "../types";

const ev = (p: Partial<SessionEvent>): SessionEvent => ({
  kind: "tool_call",
  sessionId: "s1",
  ...p,
} as SessionEvent);

describe("turn-scoped tool identity (#209)", () => {
  test("same toolCallId in a different turn stays a separate row", () => {
    let items: ChatItem[] = [];
    items = applyEventToItems(items, ev({ kind: "tool_call", toolCallId: "t1", turnId: "turn-a", toolTitle: "first" }));
    items = applyEventToItems(items, ev({ kind: "tool_call", toolCallId: "t1", turnId: "turn-b", toolTitle: "replayed" }));
    const tools = items.filter((i) => i.type === "tool") as Extract<ChatItem, { type: "tool" }>[];
    expect(tools.length).toBe(2);
    expect(tools[0].id).not.toBe(tools[1].id);
    expect(tools[0].title).toBe("first");
    expect(tools[1].title).toBe("replayed");
  });

  test("update within the same turn patches the turn's own copy", () => {
    let items: ChatItem[] = [];
    items = applyEventToItems(items, ev({ kind: "tool_call", toolCallId: "t1", turnId: "turn-a", toolTitle: "orig" }));
    items = applyEventToItems(items, ev({ kind: "tool_call", toolCallId: "t1", turnId: "turn-b", toolTitle: "replay" }));
    items = applyEventToItems(items, ev({ kind: "tool_call_update", toolCallId: "t1", turnId: "turn-b", toolStatus: "completed" }));
    const tools = items.filter((i) => i.type === "tool") as Extract<ChatItem, { type: "tool" }>[];
    expect(tools.length).toBe(2); // replay never collapses onto the original
    expect(tools[1].status).toBe("completed");
    expect(tools[0].status).toBe("pending"); // untouched by the other turn's update
  });

  test("empty turnId falls back to the raw id (legacy/no-live-turn events)", () => {
    let items: ChatItem[] = [];
    items = applyEventToItems(items, ev({ kind: "tool_call", toolCallId: "t1" }));
    items = applyEventToItems(items, ev({ kind: "tool_call_update", toolCallId: "t1", toolStatus: "completed" }));
    const tools = items.filter((i) => i.type === "tool") as Extract<ChatItem, { type: "tool" }>[];
    expect(tools.length).toBe(1);
    expect(tools[0].id).toBe("t1");
    expect(tools[0].status).toBe("completed");
  });

  test("same-turn duplicate tool_call still patches in place (no duplicate rows)", () => {
    let items: ChatItem[] = [];
    items = applyEventToItems(items, ev({ kind: "tool_call", toolCallId: "t1", turnId: "turn-a", toolTitle: "v1" }));
    items = applyEventToItems(items, ev({ kind: "tool_call", toolCallId: "t1", turnId: "turn-a", toolTitle: "v2" }));
    const tools = items.filter((i) => i.type === "tool") as Extract<ChatItem, { type: "tool" }>[];
    expect(tools.length).toBe(1);
    expect(tools[0].title).toBe("v2");
  });
});
