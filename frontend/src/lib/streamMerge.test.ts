// streamMerge.test.ts:回归流式合并的主键归并行为(§5.3)。bun test 运行。

import { test, expect } from "bun:test";
import { applyEventToItems } from "./streamMerge";
import type { ChatItem, SessionEvent } from "../types";

const ev = (e: Partial<SessionEvent> & { kind: SessionEvent["kind"] }): SessionEvent =>
  ({ sessionId: "s", ...e }) as SessionEvent;

const agentBubbles = (items: ChatItem[]) =>
  items.filter((i) => i.type === "agent") as Extract<ChatItem, { type: "agent" }>[];

test("同 messageId 的 agent chunks 归并成单个流式气泡(主键归并)", () => {
  let items: ChatItem[] = [];
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "这个问题", messageId: "mA", seq: 1 }));
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "这个问题 这个问题值得我", messageId: "mA", seq: 2 }));
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "这个问题 这个问题值得我 这个问题值得我认真", messageId: "mA", seq: 3 }));
  const bubbles = agentBubbles(items);
  expect(bubbles.length).toBe(1);
  expect(bubbles[0].text).toBe("这个问题 这个问题值得我 这个问题值得我认真");
  expect(bubbles[0].messageId).toBe("mA");
});

test("messageId 变化 = 新消息(新气泡)", () => {
  let items: ChatItem[] = [];
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "第一段", messageId: "mA", seq: 1 }));
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "第二段", messageId: "mB", seq: 2 }));
  const bubbles = agentBubbles(items);
  expect(bubbles.length).toBe(2);
  expect(bubbles[0].text).toBe("第一段");
  expect(bubbles[1].text).toBe("第二段");
});

test("同 messageId 的 thought+agent 共存为两个气泡(协议:同逻辑消息的两种 part)", () => {
  let items: ChatItem[] = [];
  items = applyEventToItems(items, ev({ kind: "agent_thought_chunk", text: "想", messageId: "mA", seq: 1 }));
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "答", messageId: "mA", seq: 2 }));
  const thoughts = items.filter((i) => i.type === "thought");
  const agents = agentBubbles(items);
  expect(thoughts.length).toBe(1);
  expect(agents.length).toBe(1);
  expect((thoughts[0] as Extract<ChatItem, { type: "thought" }>).messageId).toBe("mA");
  expect(agents[0].messageId).toBe("mA");
});

test("tool_call_update 穿插不得拆分同 messageId 的 agent 消息(§5.4 #11 回归)", () => {
  let items: ChatItem[] = [];
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "这个问题", messageId: "mA", seq: 10 }));
  items = applyEventToItems(items, ev({ kind: "tool_call", toolCallId: "T1", toolTitle: "run", seq: 11 }));
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "这个问题 这个问题值得我", messageId: "mA", seq: 12 }));
  items = applyEventToItems(items, ev({ kind: "tool_call_update", toolCallId: "T1", seq: 13 }));
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "这个问题 这个问题值得我 这个问题值得我认真", messageId: "mA", seq: 14 }));

  const bubbles = agentBubbles(items).filter((b) => b.messageId === "mA");
  expect(bubbles.length).toBe(1); // 关键:update 穿插不拆分
  expect(bubbles[0].text).toBe("这个问题 这个问题值得我 这个问题值得我认真");
});

test("无 messageId 回退:role 变化 = 新气泡(启发式降级路径)", () => {
  let items: ChatItem[] = [];
  items = applyEventToItems(items, ev({ kind: "agent_thought_chunk", text: "想", seq: 1 }));
  items = applyEventToItems(items, ev({ kind: "agent_thought_chunk", text: "想想", seq: 2 }));
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "答", seq: 3 }));
  const thoughts = items.filter((i) => i.type === "thought");
  const agents = agentBubbles(items);
  expect(thoughts.length).toBe(1);
  expect((thoughts[0] as Extract<ChatItem, { type: "thought" }>).text).toBe("想想");
  expect(agents.length).toBe(1);
  expect(agents[0].text).toBe("答");
});

test("无 messageId 回退:纯 agent chunks 累积成单气泡", () => {
  let items: ChatItem[] = [];
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "这个问题", seq: 1 }));
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "这个问题 这个问题值得我", seq: 2 }));
  const bubbles = agentBubbles(items);
  expect(bubbles.length).toBe(1);
  expect(bubbles[0].text).toBe("这个问题 这个问题值得我");
});

test("无 messageId 回退:tool_call_update 穿插不打断流式 agent", () => {
  let items: ChatItem[] = [];
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "这个问题", seq: 10 }));
  items = applyEventToItems(items, ev({ kind: "tool_call", toolCallId: "T1", toolTitle: "run", seq: 11 }));
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "这个问题 这个问题值得我", seq: 12 }));
  items = applyEventToItems(items, ev({ kind: "tool_call_update", toolCallId: "T1", seq: 13 }));
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "这个问题 这个问题值得我 这个问题值得我认真", seq: 14 }));
  // tool_call 后的 agent 是新气泡(tool 是段边界),但 update 穿插不拆它。
  const newBubbles = agentBubbles(items).filter((b) => !b.messageId);
  expect(newBubbles.length).toBe(2); // tool_call 前1个 + tool_call 后1个(update 不拆)
  expect(newBubbles[1].text).toBe("这个问题 这个问题值得我 这个问题值得我认真");
});

test("乱序 chunk(更小 seq)被忽略", () => {
  let items: ChatItem[] = [];
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "AB", messageId: "mA", seq: 5 }));
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "ABC", messageId: "mA", seq: 6 }));
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "A", messageId: "mA", seq: 4 })); // 迟到
  expect(agentBubbles(items)[0].text).toBe("ABC");
});

test("tool_call 仍是段边界(finalize 当前 agent 段)", () => {
  let items: ChatItem[] = [];
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "先说一句", messageId: "mA", seq: 1 }));
  items = applyEventToItems(items, ev({ kind: "tool_call", toolCallId: "T1", toolTitle: "read", toolStatus: "in_progress", seq: 2 }));
  const bubbles = agentBubbles(items);
  expect(bubbles.length).toBe(1);
  expect(bubbles[0].streaming).toBe(false); // tool_call 把 agent 段 finalize
  expect(items[items.length - 1].type).toBe("tool");
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

test("messageId 变化时 finalize 上一个气泡(不留多个 loading)", () => {
  // thought(mA) → agent(mB):mA 应被 finalize,不能两个都 streaming=true
  let items: ChatItem[] = [];
  items = applyEventToItems(items, ev({ kind: "agent_thought_chunk", text: "想", messageId: "mA", seq: 1 }));
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "答", messageId: "mB", seq: 2 }));
  const thoughts = items.filter((i) => i.type === "thought") as Extract<ChatItem, { type: "thought" }>[];
  const agents = agentBubbles(items);
  expect(thoughts[0].streaming).toBe(false); // mA 被 finalize
  expect(agents[0].streaming).toBe(true);    // mB 仍在流式
});

test("同 messageId 的 thought 在 text 开始时收口 streaming(reasoning 先于 text)", () => {
  // ACP 协议:一条 message 的 reasoning part delta 全部先于 text part delta。
  // 故 agent_message_chunk 到达 = reasoning 结束 → thought 必须收口 streaming,
  // 否则 spinner 一直转到整轮 idle(回归:思考结束后 loading 不停)。
  let items: ChatItem[] = [];
  items = applyEventToItems(items, ev({ kind: "agent_thought_chunk", text: "想", messageId: "mA", seq: 1 }));
  items = applyEventToItems(items, ev({ kind: "agent_thought_chunk", text: "想想", messageId: "mA", seq: 2 }));
  items = applyEventToItems(items, ev({ kind: "agent_message_chunk", text: "答", messageId: "mA", seq: 3 }));
  const thoughts = items.filter((i) => i.type === "thought") as Extract<ChatItem, { type: "thought" }>[];
  const agents = agentBubbles(items);
  expect(thoughts.length).toBe(1);
  expect(thoughts[0].streaming).toBe(false); // 关键:text 开始 → thought 收口
  expect(thoughts[0].text).toBe("想想");
  expect(agents.length).toBe(1);
  expect(agents[0].streaming).toBe(true);
  expect(agents[0].text).toBe("答");
});
test("thought id 基于 messageId(同 messageId 归并后 id 稳定)", () => {
  // id 用 messageId 而非 seq → 同 messageId 的 chunk 即使首次未归并命中,
  // 后续 id 也一致(React key 稳定,不重挂载 → 不「反复创建」/「点不开」)。
  let items: ChatItem[] = [];
  items = applyEventToItems(items, ev({ kind: "agent_thought_chunk", text: "想", messageId: "m1", seq: 1 }));
  const id1 = (items[0] as Extract<ChatItem, { type: "thought" }>).id;
  items = applyEventToItems(items, ev({ kind: "agent_thought_chunk", text: "想想", messageId: "m1", seq: 2 }));
  const id2 = (items[0] as Extract<ChatItem, { type: "thought" }>).id;
  expect(id1).toBe(id2); // 同 messageId → id 稳定
  expect(id1).toContain("m1"); // id 基于 messageId
});

test("无 messageId 回退:同类连续归并(不因中间异类新建)", () => {
  // 无 messageId 的同类连续 chunk 归并到最后同类型 streaming item。
  let items: ChatItem[] = [];
  items = applyEventToItems(items, ev({ kind: "agent_thought_chunk", text: "想1", seq: 1 }));
  items = applyEventToItems(items, ev({ kind: "agent_thought_chunk", text: "想12", seq: 2 }));
  items = applyEventToItems(items, ev({ kind: "agent_thought_chunk", text: "想123", seq: 3 }));
  const thoughts = items.filter((i) => i.type === "thought");
  expect(thoughts.length).toBe(1);
  expect((thoughts[0] as Extract<ChatItem, { type: "thought" }>).text).toBe("想123");
});
