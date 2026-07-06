// streamMerge.ts:把一条 SessionEvent 合并进某 session 的对话 items(纯函数)。
//
// 归并主键(对标 omp/opencode 的"对象归并"模型,§5.4 #11/#12):
//   - message: messageId(协议,优先)+ role 复合。同 messageId+role 的 chunk 替换当前气泡文本。
//     协议 messageId 是 UNSTABLE,harness 可能不发 → 回退:role 变化 / 被 tool 打断 = 新气泡。
//   - tool: toolCallId(协议必填)。tool_call 新建;update 就地 patch 已存在 tool。
//
// 关键不变量(见 streamMerge.test.ts):
//   - tool_call_update 按 toolCallId 只命中 tool entry,物理上碰不到 message 气泡
//     → #11(message-duplication)构造性消灭。
//   - items 是单一有序数组,按事件到达顺序排列 → 与后端 timeline 同构,#12 同源消灭。

import type { ChatItem, SessionEvent } from "../types";

// 归并主键:有 messageId 用 messageId+role;无则返回 undefined(调用方走"上一个同类型"回退)。
function messageKeyId(ev: SessionEvent): string | undefined {
  if (ev.messageId) return `msg:${ev.messageId}:${roleOf(ev)}`;
  return undefined;
}

function roleOf(ev: SessionEvent): "agent" | "thought" | "user" {
  if (ev.kind === "agent_thought_chunk") return "thought";
  if (ev.kind === "user_message_chunk") return "user";
  return "agent";
}

export function applyEventToItems(cur: ChatItem[], ev: SessionEvent): ChatItem[] {
  const next = [...cur];
  // 段边界:push 新段前,清除上一个 thought/agent 的 streaming 标志(否则 spinner 永不消失)。
  const finalizeLast = () => {
    const l = next[next.length - 1];
    if (l && (l.type === "thought" || l.type === "agent") && l.streaming) {
      next[next.length - 1] = { ...l, streaming: false };
    }
  };
  const last = next[next.length - 1];
  switch (ev.kind) {
    case "user_message_chunk": {
      // 主键归并:同 messageId+user 的 chunk 替换当前 user 气泡。
      const key = messageKeyId(ev);
      const idx = key ? next.findIndex((it) => it.type === "user" && it.messageId === ev.messageId) : -1;
      if (idx >= 0) {
        next[idx] = { ...next[idx], text: ev.text || "" } as Extract<ChatItem, { type: "user" }>;
        return next;
      }
      // 回退:已有 user(无 messageId 时去重)。
      if (!key && last && last.type === "user") return next;
      finalizeLast();
      next.push({ type: "user", id: `u-${Date.now()}`, text: ev.text || "", ts: Date.now(), messageId: ev.messageId });
      return next;
    }
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const role = roleOf(ev);
      const type = role === "thought" ? "thought" : "agent";
      // 主键归并:同 messageId+role 的 chunk 替换当前气泡文本(序号防乱序)。
      if (ev.messageId) {
        const idx = next.findIndex((it) => (it.type === "agent" || it.type === "thought") && it.messageId === ev.messageId && it.type === type);
        if (idx >= 0) {
          const existing = next[idx] as Extract<ChatItem, { type: "agent" } | { type: "thought" }>;
          if (ev.seq == null || existing.seq == null || ev.seq >= existing.seq) {
            next[idx] = { ...existing, text: ev.text || "", seq: ev.seq } as Extract<ChatItem, { type: "agent" } | { type: "thought" }>;
          }
          return next;
        }
        // messageId 存在但无对应气泡 → 新建。先 finalize 上一个 streaming agent/thought 气泡。
        // 关键不变量:reasoning(thought)的 delta 在协议上全部先于 text(同 messageId 的两 part
        // 顺序输出,非交错)。故 text 一旦开始,前一个 thought 必然结束 → 必须收口其 streaming,
        // 否则 spinner 一直转到整轮 idle(§5.4)。新 messageId 的 agent/thought 同样收口上一个。
        // 不合并气泡:findIndex 已按 type+messageId 区分,thought 与 text 仍各自独立。
        const prev = next[next.length - 1];
        if (prev && (prev.type === "agent" || prev.type === "thought") && prev.streaming) {
          next[next.length - 1] = { ...prev, streaming: false } as Extract<ChatItem, { type: "agent" } | { type: "thought" }>;
        }
        next.push({
          type, id: `${type[0]}-${ev.seq ?? Date.now()}`, text: ev.text || "",
          streaming: true, seq: ev.seq, ts: Date.now(), messageId: ev.messageId,
        } as ChatItem);
        return next;
      }
      // 回退(无 messageId):上一个同类型且流式 → 替换;否则 finalize 新建。
      if (last && last.type === type && last.streaming) {
        if (ev.seq == null || last.seq == null || ev.seq >= last.seq) {
          next[next.length - 1] = { ...last, text: ev.text || "", seq: ev.seq } as Extract<ChatItem, { type: "agent" } | { type: "thought" }>;
        }
      } else {
        finalizeLast();
        next.push({
          type, id: `${type[0]}-${ev.seq ?? Date.now()}`, text: ev.text || "",
          streaming: true, seq: ev.seq, ts: Date.now(),
        } as ChatItem);
      }
      return next;
    }
    case "tool_call": {
      // 新工具开始 = 段边界:finalize 当前 agent/thought 段,再登记 tool。
      finalizeLast();
      const id = ev.toolCallId || `tool-${Date.now()}`;
      const idx = next.findIndex((it) => it.type === "tool" && it.id === id);
      const existing = idx >= 0 ? (next[idx] as Extract<ChatItem, { type: "tool" }>) : null;
      const toolItem = {
        type: "tool" as const,
        id,
        title: ev.toolTitle || existing?.title || "",
        status: ev.toolStatus || existing?.status || "pending",
        kind: ev.toolKind || existing?.kind || "",
        rawInput: ev.rawInput ?? existing?.rawInput,
        rawOutput: ev.rawOutput ?? existing?.rawOutput,
      };
      if (idx >= 0) next[idx] = toolItem;
      else next.push(toolItem);
      return next;
    }
    case "tool_call_update": {
      // 仅更新已存在工具(omp 后台 onUpdate / 进度)。**不是段边界** —— 不调 finalize,
      // 不打断正在流式的 agent/thought。仅孤儿 update(无对应 tool_call)兜底建条。
      const id = ev.toolCallId || `tool-${Date.now()}`;
      const idx = next.findIndex((it) => it.type === "tool" && it.id === id);
      if (idx >= 0) {
        const existing = next[idx] as Extract<ChatItem, { type: "tool" }>;
        next[idx] = {
          ...existing,
          title: ev.toolTitle || existing.title,
          status: ev.toolStatus || existing.status,
          kind: ev.toolKind || existing.kind,
          rawOutput: ev.rawOutput ?? existing.rawOutput,
        };
      } else {
        finalizeLast();
        next.push({
          type: "tool" as const,
          id,
          title: ev.toolTitle || "",
          status: ev.toolStatus || "pending",
          kind: ev.toolKind || "",
          rawOutput: ev.rawOutput,
        });
      }
      return next;
    }
    case "session_info":
    default:
      return next;
  }
}
