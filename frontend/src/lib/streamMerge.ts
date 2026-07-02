// streamMerge.ts:把一条 SessionEvent 合并进某 session 的对话 items(纯函数)。
//
// 从 App.tsx 抽出,便于单测复现流式合并的边界行为(§5.3)。agent/thought 按「累积全文 +
// 单调序号」替换(非追加),事件乱序也不乱码(§4.3)。
//
// 关键不变量(见 streamMerge.test.ts):
//   - tool_call(新工具开始)是段边界,会 finalize 当前 agent/thought 的 streaming。
//   - tool_call_update(仅更新已存在工具,**不是**段边界)不得打断正在流式的 agent/thought。
//     否则 omp async task 的后台 onUpdate(在 execute() 返回后才发的 tool_call_update,
//     §5.4 #10)会在 agent 文本流中反复 finalize 当前 agent 气泡 → 后续每个 chunk 新建
//     气泡 → 同一条 agent 消息被拆成「累积前缀」的多条(message-duplication bug)。

import type { ChatItem, SessionEvent } from "../types";

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
    case "user_message_chunk":
      if (last && last.type === "user") return next; // 已有 user,不重复
      finalizeLast();
      next.push({ type: "user", id: `u-${Date.now()}`, text: ev.text || "", ts: Date.now() });
      return next;
    case "agent_message_chunk":
      if (last && last.type === "agent" && last.streaming) {
        // 累积全文 + 序号:序号更小(乱序迟到)则忽略,否则替换(非追加,防乱码)
        if (ev.seq == null || last.seq == null || ev.seq >= last.seq) {
          next[next.length - 1] = { ...last, text: ev.text || "", seq: ev.seq };
        }
      } else {
        finalizeLast();
        next.push({ type: "agent", id: `a-${ev.seq ?? Date.now()}`, text: ev.text || "", streaming: true, seq: ev.seq, ts: Date.now() });
      }
      return next;
    case "agent_thought_chunk":
      if (last && last.type === "thought" && last.streaming) {
        if (ev.seq == null || last.seq == null || ev.seq >= last.seq) {
          next[next.length - 1] = { ...last, text: ev.text || "", seq: ev.seq };
        }
      } else {
        finalizeLast();
        next.push({ type: "thought", id: `t-${ev.seq ?? Date.now()}`, text: ev.text || "", streaming: true, seq: ev.seq, ts: Date.now() });
      }
      return next;
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
      // 仅更新已存在工具(omp 后台 onUpdate / 进度)。**不是段边界** —— 不得 finalize
      // 正在流式的 agent/thought,否则会把同一条 agent 消息拆成多条累积前缀气泡(bug)。
      // 仅当出现「无对应 tool_call 的孤儿 update」(异常乱序)时,才作段边界兜底建条。
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
