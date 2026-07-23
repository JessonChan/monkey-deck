import { useRef, useState } from "react";
import type { QueueItem } from "../types";
import { useTranslation } from "react-i18next";
import { Zap, Pencil, Trash2, Check, X, Clock, GripVertical } from "lucide-react";

interface Props {
  queue: QueueItem[];
  onInterrupt: (id: string) => void; // 立即发送:打断当前 turn,这条插队先发
  onRevoke: (id: string) => void;    // 撤回编辑:移出队列,文本回填输入框
  onEdit: (id: string, text: string) => void; // inline 编辑:改队列里这条的文本,保留在队列
  onSchedule: (id: string, scheduledAt: number) => void; // 定时发送:设/清这条的 scheduledAt(0/Date.now()=立即)
  onReorder: (activeId: string, overId: string) => void; // 拖拽重排:把 activeId 这条移到 overId 这条的位置
}

// QueuePanel:turn 进行中时排队消息的列表面板。
// ACP 协议无 queue —— 这是前端 FIFO 缓冲,回合结束自动续发;每条可「立即发送」(打断)
// 或「撤回编辑」(回填输入框),也可「inline 编辑」(点编辑变 input,保存写回队列)。多条 FIFO,
// 按序逐条自动发(每条 = 一个独立 turn)。
//
// 拖拽重排:每条左侧的 ⠿ 手柄 draggable(HTML5 drag-drop),整行作 drop target;松手时调
// onReorder(activeId, overId),父层把 activeId 这条移到 overId 位置,drainSession 按新顺序发。
//
// 编辑态 textarea 用非受控(defaultValue)+ ref:保存时直接读 DOM 当前值,既避开受控组件在
// 事件流上的边角问题,也杜绝「state 尚未同步就读值」的 stale 风险。
// 定时发送:同模式用 datetime-local(非受控 defaultValue + ref)。
export default function QueuePanel({ queue, onInterrupt, onRevoke, onEdit, onSchedule, onReorder }: Props) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [schedulingId, setSchedulingId] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null); // 定时提交复验过期提示
  const [dragId, setDragId] = useState<string | null>(null);   // 正被拖拽的条目 id
  const [overId, setOverId] = useState<string | null>(null);   // 拖拽悬停的目标条目 id
  const editRef = useRef<HTMLTextAreaElement>(null);
  const scheduleRef = useRef<HTMLInputElement>(null);

  if (queue.length === 0) return null;

  const startEdit = (item: QueueItem) => { setEditingId(item.id); setSchedulingId(null); };
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

  const startSchedule = (item: QueueItem) => { setSchedulingId(item.id); setEditingId(null); setScheduleError(null); };
  const cancelSchedule = () => { setSchedulingId(null); setScheduleError(null); };
  const saveSchedule = () => {
    if (!schedulingId) return;
    const v = scheduleRef.current?.value;
    const ts = v ? fromLocalInput(v) : 0;
    // 提交时复验过期:min=now 只是 UX 第一道防线(用户可手动键入过去时刻,或开着选择器
    // 停留过久使原本合法的时刻变成过去)。此处再判一次,过期则拦截并提示,不调 onSchedule。
    if (ts > 0 && ts <= Date.now()) {
      setScheduleError(t("queue.scheduleExpired"));
      return;
    }
    onSchedule(schedulingId, ts > 0 ? ts : Date.now());
    setSchedulingId(null);
    setScheduleError(null);
  };
  const clearSchedule = () => {
    if (!schedulingId) return;
    onSchedule(schedulingId, Date.now());
    setSchedulingId(null);
    setScheduleError(null);
  };

  return (
    <div className="queue-panel" data-testid="queue-panel">
      <div className="queue-header">
        <span className="queue-title">{t("queue.title", { count: queue.length })}</span>
        <span className="queue-hint">{t("queue.hint")}</span>
      </div>
      {queue.map((item, idx) => {
        const pending = item.scheduledAt > Date.now();
        return (
        <div
          className={`queue-item${overId === item.id ? " drag-over" : ""}`}
          data-testid="queue-item"
          data-id={item.id}
          key={item.id}
          onDragOver={(e) => {
            if (!dragId) return;
            e.preventDefault();
            if (overId !== item.id) setOverId(item.id);
          }}
          onDragLeave={() => { if (overId === item.id) setOverId(null); }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragId && dragId !== item.id) onReorder(dragId, item.id);
            setDragId(null);
            setOverId(null);
          }}
        >
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
          ) : schedulingId === item.id ? (
            <div className="queue-item-edit" data-testid="queue-schedule-row">
              <input
                className="queue-schedule-input"
                data-testid="queue-schedule-input"
                type="datetime-local"
                min={toLocalInput(Date.now())}
                defaultValue={pending ? toLocalInput(item.scheduledAt) : defaultLocalInput()}
                ref={scheduleRef}
                autoFocus
              />
              <div className="queue-item-actions">
                <button
                  className="queue-btn save"
                  data-testid="queue-schedule-save"
                  onClick={saveSchedule}
                  title={t("queue.saveTip")}
                >
                  <Check size={13} /> {t("queue.save")}
                </button>
                <button
                  className="queue-btn cancel"
                  data-testid="queue-schedule-cancel"
                  onClick={cancelSchedule}
                  title={t("queue.cancelTip")}
                >
                  <X size={13} /> {t("queue.cancel")}
                </button>
                {pending && (
                  <button
                    className="queue-btn clear"
                    data-testid="queue-schedule-clear"
                    onClick={clearSchedule}
                    title={t("queue.clearScheduleTip")}
                  >
                    {t("queue.clearSchedule")}
                  </button>
                )}
              </div>
              {scheduleError && (
                <span className="queue-schedule-error" data-testid="queue-schedule-error">
                  {scheduleError}
                </span>
              )}
            </div>
          ) : (
            <>
              <span
                className="queue-grip"
                data-testid="queue-grip"
                data-tooltip-id="md-tip"
                data-tooltip-content={t("queue.reorderTip")}
                draggable
                onDragStart={(e) => {
                  setDragId(item.id);
                  try {
                    e.dataTransfer.setData("text/plain", item.id);
                    e.dataTransfer.effectAllowed = "move";
                  } catch { /* dataTransfer 在测试环境可能缺失,忽略 */ }
                }}
                onDragEnd={() => { setDragId(null); setOverId(null); }}
              >
                <GripVertical size={13} />
              </span>
              <span className="queue-item-text">{item.text}</span>
              {pending ? (
                <span className="queue-scheduled future" data-testid="queue-scheduled-send" title={t("queue.scheduledSendTip")}>
                  <Clock size={11} /> {t("queue.scheduledSend", { time: formatClock(item.scheduledAt) })}
                </span>
              ) : item.scheduledAt > 0 ? (
                <span className="queue-scheduled" data-testid="queue-scheduled">
                  {t("queue.scheduled", { time: formatClock(item.scheduledAt) })}
                </span>
              ) : null}
              <div className="queue-item-actions">
                <button
                  className="queue-btn schedule"
                  data-testid="queue-schedule"
                  onClick={() => startSchedule(item)}
                  title={t("queue.scheduleTip")}
                >
                  <Clock size={13} /> {t("queue.schedule")}
                </button>
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
        );
      })}
    </div>
  );
}

// 入队/定时时刻格式化为 HH:mm(本地时区)。跨天不额外标日期——排队只看近期。
function formatClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// datetime-local 用本地时区 "YYYY-MM-DDTHH:mm"(无时区后缀)。
function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// 默认(datetime-local 空值时):用「现在」+1 分钟作为默认建议时刻。
function defaultLocalInput(): string {
  return toLocalInput(Date.now() + 60_000);
}
// "YYYY-MM-DDTHH:mm" → epoch ms(本地时区解析)。
function fromLocalInput(v: string): number {
  const ts = Date.parse(v);
  return Number.isNaN(ts) ? 0 : ts;
}
