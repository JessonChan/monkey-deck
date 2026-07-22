import { useRef, useState } from "react";
import type { QueueItem } from "../types";
import { useTranslation } from "react-i18next";
import { Zap, Pencil, Trash2, Check, X } from "lucide-react";

interface Props {
  queue: QueueItem[];
  onInterrupt: (id: string) => void; // 立即发送:打断当前 turn,这条插队先发
  onRevoke: (id: string) => void;    // 撤回编辑:移出队列,文本回填输入框
  onEdit: (id: string, text: string) => void; // inline 编辑:改队列里这条的文本,保留在队列
}

// QueuePanel:turn 进行中时排队消息的列表面板。
// ACP 协议无 queue —— 这是前端 FIFO 缓冲,回合结束自动续发;每条可「立即发送」(打断)
// 或「撤回编辑」(回填输入框),也可「inline 编辑」(点编辑变 input,保存写回队列)。多条 FIFO,
// 按序逐条自动发(每条 = 一个独立 turn)。
//
// 编辑态 textarea 用非受控(defaultValue)+ ref:保存时直接读 DOM 当前值,既避开受控组件在
// 事件流上的边角问题,也杜绝「state 尚未同步就读值」的 stale 风险。
export default function QueuePanel({ queue, onInterrupt, onRevoke, onEdit }: Props) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);

  if (queue.length === 0) return null;

  const startEdit = (item: QueueItem) => setEditingId(item.id);
  const cancelEdit = () => setEditingId(null);
  const saveEdit = () => {
    if (!editingId) return;
    const text = editRef.current?.value.trim();
    if (text) onEdit(editingId, text);
    setEditingId(null);
  };
  // 编辑态键盘:Enter 保存(无 Shift)、Esc 取消(AGENTS §4.2 弹窗可 Esc 关闭约束延伸)。
  const onEditKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  return (
    <div className="queue-panel" data-testid="queue-panel">
      <div className="queue-header">
        <span className="queue-title">{t("queue.title", { count: queue.length })}</span>
        <span className="queue-hint">{t("queue.hint")}</span>
      </div>
      {queue.map((item, idx) => (
        <div className="queue-item" data-testid="queue-item" key={item.id}>
          <span className="queue-idx">{idx + 1}</span>
          {editingId === item.id ? (
            <div className="queue-item-edit" data-testid="queue-edit-row">
              <textarea
                className="queue-edit-input"
                data-testid="queue-edit-input"
                defaultValue={item.text}
                ref={editRef}
                onKeyDown={onEditKey}
                rows={2}
                autoFocus
              />
              <div className="queue-item-actions">
                <button
                  className="queue-btn save"
                  data-testid="queue-edit-save"
                  onClick={saveEdit}
                  title={t("queue.saveTip")}
                >
                  <Check size={13} /> {t("queue.save")}
                </button>
                <button
                  className="queue-btn cancel"
                  data-testid="queue-edit-cancel"
                  onClick={cancelEdit}
                  title={t("queue.cancelTip")}
                >
                  <X size={13} /> {t("queue.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <>
              <span className="queue-item-text">{item.text}</span>
              {item.scheduledAt > 0 && (
                <span className="queue-scheduled" data-testid="queue-scheduled">
                  {t("queue.scheduled", { time: formatClock(item.scheduledAt) })}
                </span>
              )}
              <div className="queue-item-actions">
                <button
                  className="queue-btn edit"
                  data-testid="queue-edit"
                  onClick={() => startEdit(item)}
                  title={t("queue.editTip")}
                >
                  <Pencil size={13} /> {t("queue.edit")}
                </button>
                <button
                  className="queue-btn interrupt"
                  data-testid="queue-interrupt"
                  onClick={() => onInterrupt(item.id)}
                  title={t("queue.interruptTip")}
                >
                  <Zap size={13} /> {t("queue.interrupt")}
                </button>
                <button
                  className="queue-btn revoke"
                  data-testid="queue-revoke"
                  onClick={() => onRevoke(item.id)}
                  title={t("queue.revokeTip")}
                >
                  <Trash2 size={13} /> {t("queue.revoke")}
                </button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

// 入队时刻格式化为 HH:mm(本地时区)。跨天不额外标日期——排队只看近期。
function formatClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
