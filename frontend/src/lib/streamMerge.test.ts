// streamMerge.test.ts:回归流式合并的段边界行为(§5.3)。bun test 运行(bun 内置,无需装依赖)。
//
// 核心 bug:tool_call_update(omp async task 后台 onUpdate,见 §5.4 #10)在 agent 文本流中
// 反复到达时,旧实现把它当段边界 finalize 了正在流式的 agent 气泡 → 后续每个 chunk 新建
// 气泡,同一条 agent 消息被拆成「累积前缀」的多条(message-duplication bug)。

import { test, expect } from "bun:test";
import { applyEventToItems } from "./streamMerge";
import type { ChatItem, SessionEvent } from "../types";

const ev = (e: Partial<SessionEvent> & { kind: SessionEvent["kind"] }): SessionEvent =>
  ({ sessionId: "s", ...e }) as SessionEvent;

const agentBubbles = (items: ChatItem[]) =>
  items.filter((i) => i.type === "agent") as Extract<ChatItem, { type: "agent" }>[];

test("纯 agent message chunks 累积成单个流式气泡", () => {
  let items: ChatItem[] = [];
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "这个问题", seq: 1 }));
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "这个问题 这个问题值得我", seq: 2 }));
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "这个问题 这个问题值得我 这个问题值得我认真", seq: 3 }));
  const bubbles = agentBubbles(items);
  expect(bubbles.length).toBe(1);
  expect(bubbles[0].text).toBe("这个问题 这个问题值得我 这个问题值得我认真");
  expect(bubbles[0].streaming).toBe(true);
});

test("tool_call_update 穿插不得拆分正在流式的 agent 消息(回归 bug)", () => {
  // 真实 omp 场景:tool 先 tool_call 注册,async 后台 onUpdate(tool_call_update)在
  // agent 后续文本流中反复到达。旧实现会生成 4 个累积前缀气泡(用户报的「连续收到」)。
  let items: ChatItem[] = [];
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "这个问题", seq: 10 }));
  items = applyEventToItems(items, ev({ kind: "tool_call", toolCallId: "T1", toolTitle: "run", seq: 11 })); // 段边界
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "这个问题 这个问题值得我", seq: 12 }));
  items = applyEventToItems(items, ev({ kind: "tool_call_update", toolCallId: "T1", seq: 13 })); // 后台 onUpdate 穿插
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "这个问题 这个问题值得我 这个问题值得我认真", seq: 14 }));
  items = applyEventToItems(items, ev({ kind: "tool_call_update", toolCallId: "T1", seq: 15 }));
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "这个问题 这个问题值得我 这个问题值得我认真。结论", seq: 16 }));

  const bubbles = agentBubbles(items);
  // 2 个 agent 段:tool_call 之前的 "这个问题" + tool_call 之后的整段。不应是累积前缀的多条。
  expect(bubbles.length).toBe(2);
  expect(bubbles[0].text).toBe("这个问题");
  expect(bubbles[1].text).toBe("这个问题 这个问题值得我 这个问题值得我认真。结论");
  expect(bubbles[1].streaming).toBe(true);
  // 关键:tool_call_update 不应把正在流式的 agent 气泡打成 streaming:false
  expect(bubbles[1].streaming).toBe(true);
});

test("tool_call 仍是段边界(finalize 当前 agent 段)", () => {
  let items: ChatItem[] = [];
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "先说一句", seq: 1 }));
  items = applyEventToItems(items, ev({ kind: "tool_call", toolCallId: "T1", toolTitle: "read", toolStatus: "in_progress", seq: 2 }));
  const bubbles = agentBubbles(items);
  expect(bubbles.length).toBe(1);
  expect(bubbles[0].streaming).toBe(false); // tool_call 把 agent 段 finalize
  expect(items[items.length - 1].type).toBe("tool");
});

test("乱序 chunk(更小 seq)被忽略,不覆盖更新的累积文本", () => {
  let items: ChatItem[] = [];
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "AB", seq: 5 }));
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "ABC", seq: 6 }));
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "A", seq: 4 })); // 迟到
  expect(agentBubbles(items)[0].text).toBe("ABC");
});

test("thought→message 边界正确分两段", () => {
  let items: ChatItem[] = [];
  items = applyEventToItems(items, ev({ kind: "agent_thought_chunk", text: "想", seq: 1 }));
  items = applyEventToItems(items, ev({ kind: "agent_thought_chunk", text: "想想", seq: 2 }));
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "答", seq: 3 }));
  const thoughts = items.filter((i) => i.type === "thought");
  const agents = agentBubbles(items);
  expect(thoughts.length).toBe(1);
  expect((thoughts[0] as any).text).toBe("想想");
  expect(agents.length).toBe(1);
  expect(agents[0].text).toBe("答");
});

test("tool_call_update 更新已存在工具的字段", () => {
  let items: ChatItem[] = [];
  items = applyEventToItems(items, ev({ kind: "tool_call", toolCallId: "T1", toolTitle: "run", toolStatus: "in_progress", seq: 1 }));
  items = applyEventToItems(items, ev({ kind: "tool_call_update", toolCallId: "T1", toolStatus: "completed", rawOutput: "done", seq: 2 }));
  const tool = items[items.length - 1];
  expect(tool.type).toBe("tool");
  if (tool.type === "tool") {
    expect(tool.title).toBe("run");
    expect(tool.status).toBe("completed");
    expect(tool.rawOutput).toBe("done");
  }
});
