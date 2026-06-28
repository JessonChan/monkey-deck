import type { QueueItem } from "../types";
import { Zap, Pencil, Trash2 } from "lucide-react";

interface Props {
  queue: QueueItem[];
  onInterrupt: (id: string) => void; // 立即发送:打断当前 turn,这条插队先发
  onRevoke: (id: string) => void;    // 撤回编辑:移出队列,文本回填输入框
}

// QueuePanel:turn 进行中时排队消息的列表面板。
// ACP 协议无 queue —— 这是前端 FIFO 缓冲,回合结束自动续发;每条可「立即发送」(打断)
// 或「撤回编辑」(回填输入框)。多条 FIFO,按序逐条自动发(每条 = 一个独立 turn)。
export default function QueuePanel({ queue, onInterrupt, onRevoke }: Props) {
  if (queue.length === 0) return null;
  return (
    <div className="queue-panel" data-testid="queue-panel">
      <div className="queue-header">
        <span className="queue-title">排队中 · {queue.length}</span>
        <span className="queue-hint">本轮结束后按序自动发送</span>
      </div>
      {queue.map((item, idx) => (
        <div className="queue-item" data-testid="queue-item" key={item.id}>
          <span className="queue-idx">{idx + 1}</span>
          <span className="queue-item-text">{item.text}</span>
          <div className="queue-item-actions">
            <button
              className="queue-btn interrupt"
              data-testid="queue-interrupt"
              onClick={() => onInterrupt(item.id)}
              title="立即发送:打断当前生成,这条先发(其余保留排队)"
            >
              <Zap size={13} /> 立即发送
            </button>
            <button
              className="queue-btn revoke"
              data-testid="queue-revoke"
              onClick={() => onRevoke(item.id)}
              title="撤回:移出队列并回填到输入框编辑"
            >
              {idx === queue.length - 1 ? <Pencil size={13} /> : <Trash2 size={13} />} 撤回
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
