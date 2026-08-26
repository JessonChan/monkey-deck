import { useEffect, useRef, useState } from "react";
import type { QueueItem } from "../types";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Zap, Pencil, Trash2, Check, X, Clock, GripVertical, ChevronUp, ChevronDown, Repeat } from "lucide-react";

interface Props {
  queue: QueueItem[];
  onInterrupt: (id: string) => void; // 立即发送:打断当前 turn,这条插队先发
  onRevoke: (id: string) => void;    // 撤回编辑:移出队列,文本回填输入框
  onEdit: (id: string, text: string) => void; // inline 编辑:改队列里这条的文本,保留在队列
  onSchedule: (id: string, scheduledAt: number) => void; // 定时发送:设/清这条的 scheduledAt(0/Date.now()=立即)
  onReorder: (activeId: string, overId: string) => void; // 拖拽重排:把 activeId 这条移到 overId 这条的位置
  // 循环发送(#111):设/改/清(0)这条的 repeatEveryMs(1min~24h)。可选仅为兼容
  // 既有 mount 测试的最小 props;App 侧始终接线(ChatService.SetQueueItemRepeat)。
  onSetRepeat?: (id: string, repeatEveryMs: number) => void;
}

// QueuePanel:turn 进行中时排队消息的列表面板。
// ACP has no queue — this renders the SERVER-side FIFO buffer (#126A: the queue
// moved to the backend + SQLite persistence); the backend's drainQueue
// auto-continues at turn end. Each item can be "send now" (interrupt),
// "revoke to edit" (refill the composer) or inline-edited (write back to the
// queue). Multiple items go FIFO, one item = one independent turn.
// 本组件只渲染 queue props(chat:queue 事件镜像),不持有队列真相。
//
// Drag reorder: each row's ⠿ grip is draggable (HTML5 drag-drop), the whole row
// is the drop target; on drop the panel calls onReorder(activeId, overId) and the
// parent forwards it to the backend's ReorderQueueItem (#126A: the queue lives on
// the server, which drains in the new order).
//
// Narrow screens (≤768px, issue #126B): HTML5 drag is unreachable on touch, so CSS
// hides the grip and the actions row gains explicit up/down buttons — both reuse
// onReorder (adjacent swap = move onto the neighbor's slot); Props stay unchanged.
// Two-row layout (text row + wrapped actions row) + ≥40px tap targets all live in
// index.css inside the ≤768px breakpoint; desktop (>768px) rendering is untouched
// (the buttons default to display:none).
//
// 编辑态 textarea 用非受控(defaultValue)+ ref:保存时直接读 DOM 当前值,既避开受控组件在
// 事件流上的边角问题,也杜绝「state 尚未同步就读值」的 stale 风险。
// 定时发送:同模式用 datetime-local(非受控 defaultValue + ref)。
//
// 循环发送(#111):schedule 编辑行加循环档 select(不重复/每5min/每30min/每1h/自定义分钟数,
// 预设档选中即提交、自定义走 1~1440 分钟门 + Apply/Enter),调 onSetRepeat → 后端
// SetQueueItemRepeat(1min~24h 硬校验)。循环项行内徽标(间隔人话 + 已发 N 次,与 #97 倒计时
// 并存),徽标上的 ✕ 一键取消循环。≤768px 触控沿用 #126B(actions 行 wrap + 40px 按钮)。
export default function QueuePanel({ queue, onInterrupt, onRevoke, onEdit, onSchedule, onReorder, onSetRepeat }: Props) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [schedulingId, setSchedulingId] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null); // 定时提交复验过期提示
  // Staged schedule time while the schedule row is open (issue #130): preset
  // clicks stack on it, Save is what commits via onSchedule. null = not staged.
  const [pendingAt, setPendingAt] = useState<number | null>(null);
  // Set when preset stacking was clamped by the 24h cap (issue #130).
  const [scheduleCapped, setScheduleCapped] = useState(false);
  // Repeat tier (#111): the schedule row's recurrence select commits preset
  // tiers immediately; "custom" reveals a minutes input (1~1440) committed by
  // Apply/Enter. repeatError is the custom-input validation notice. The custom
  // input is UNCONTROLLED (defaultValue + ref, same pattern as the edit
  // textarea / datetime-local pickers: read the DOM value at commit — dodges
  // the React 19 + happy-dom onChange edge documented in the schedule row).
  const [repeatError, setRepeatError] = useState<string | null>(null);
  const repeatCustomRef = useRef<HTMLInputElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);   // 正被拖拽的条目 id
  const [overId, setOverId] = useState<string | null>(null);   // 拖拽悬停的目标条目 id
  const editRef = useRef<HTMLTextAreaElement>(null);
  const scheduleRef = useRef<HTMLInputElement>(null);
  // IME 合成追踪:compositionStart/End 手动记录,配合 isComposing + keyCode===229 三重保险,
  // 彻底防中文输入法选词确认的 Enter 被误判为保存(部分 macOS IME 下 isComposing 不可靠)。仿 Composer。
  const composingRef = useRef(false);

  // Live countdown for scheduled (future) items (Task #24245 / issue #97): re-render once per
  // second so the "time remaining" badge ticks down. Armed only while at least one pending item
  // exists — idle panels with no scheduled items pay zero timer cost (§5.3 Less is More). The
  // interval drives `now`; all pending checks below read `now` so the whole panel stays coherent.
  const [now, setNow] = useState(() => Date.now());
  const hasPending = queue.some((q) => q.scheduledAt > now);
  // Also tick while the schedule row is open with a staged future time, so the
  // staged chip counts down live (issue #130).
  const staging = schedulingId !== null && pendingAt !== null && pendingAt > now;
  useEffect(() => {
    if (!hasPending && !staging) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasPending, staging]);

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
    // 中文输入法(IME)composing 中:Enter 用于选词,不保存/不取消。
    // 三重检查:手动 ref 追踪(最可靠)+ isComposing(标准)+ keyCode 229(已废弃但兜底)。
    if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  // Opening the schedule row seeds the staged time from the item's existing
  // schedule (editing a pending schedule stacks on top of it); due/unscheduled
  // → null (presets start from "now"). Per-session staging state resets here.
  // The repeat tier's custom input seeds itself from the item's interval via
  // defaultValue on mount (#111) — an odd legacy interval selects "custom"
  // with the minutes filled in.
  const startSchedule = (item: QueueItem) => {
    setSchedulingId(item.id);
    setEditingId(null);
    setScheduleError(null);
    setPendingAt(item.scheduledAt > Date.now() ? item.scheduledAt : null);
    setScheduleCapped(false);
    setRepeatError(null);
  };
  // Closing the schedule row fully drops the staging state (issue #130 wrap-up):
  // pendingAt/scheduleCapped must not survive cancel/save/clear — startSchedule
  // reseeds anyway, but no staging may leak out of a closed row. Same for the
  // repeat tier's custom input + notice (#111).
  const resetStaging = () => {
    setPendingAt(null);
    setScheduleCapped(false);
    setRepeatError(null);
  };
  const cancelSchedule = () => { setSchedulingId(null); setScheduleError(null); resetStaging(); };
  // ✕ on the staged chip (issue #130 wrap-up 2): drop the staging IN PLACE —
  // same visible outcome as cancel + reopen, without closing the row. The
  // input snaps back to the default pick, notices clear, presets re-base on now.
  const resetStagedTime = () => {
    resetStaging();
    setScheduleError(null);
    // Programmatic value writes do not fire onChange — no feedback loop.
    if (scheduleRef.current) scheduleRef.current.value = defaultLocalInput();
  };
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
    // 24h cap final gate (issue #130 wrap-up): a typed over-cap value can slip
    // past the onChange rejection in edge engines — re-verify at submit, right
    // next to the expiry re-check above.
    if (ts > Date.now() + SCHEDULE_CAP_MS) {
      // The cap verdict supersedes any stale expiry error (same "latest
      // verdict wins" rule as the preset/onChange rejections).
      setScheduleCapped(true);
      setScheduleError(null);
      return;
    }
    onSchedule(schedulingId, ts > 0 ? ts : Date.now());
    setSchedulingId(null);
    setScheduleError(null);
    resetStaging();
  };
  const clearSchedule = () => {
    if (!schedulingId) return;
    onSchedule(schedulingId, Date.now());
    setSchedulingId(null);
    setScheduleError(null);
    resetStaging();
  };
  // Presets are ACCUMULATIVE (issue #130): each click stacks mins on top of the
  // staged time (or now when nothing is staged), the row STAYS OPEN for more
  // clicks / datetime fine-tuning, and only Save commits via onSchedule.
  const SCHEDULE_CAP_MS = 24 * 60 * 60_000;
  // Over the now+24h cap the click is REJECTED (issue #130 wrap-up): the staged
  // time does not move and a cap notice shows. A clamp would be wrong twice —
  // it hides how much was dropped, and on an over-cap base (legacy schedule
  // seeded beyond 24h) it would jump the staged time BACKWARD.
  const presetSchedule = (mins: number) => {
    if (!schedulingId) return;
    const base = pendingAt !== null && pendingAt > Date.now() ? pendingAt : Date.now();
    const at = base + mins * 60_000;
    if (at > Date.now() + SCHEDULE_CAP_MS) {
      setScheduleCapped(true);
      setScheduleError(null);
      return;
    }
    setPendingAt(at);
    setScheduleCapped(false);
    setScheduleError(null);
    // Keep the uncontrolled datetime-local in sync with the staged value
    // (programmatic value writes do not fire onChange — no feedback loop).
    if (scheduleRef.current) scheduleRef.current.value = toLocalInput(at);
  };
  const SCHEDULE_PRESETS = [5, 10, 30] as const;

  // ─── repeat tier (#111) ───────────────────────────────────────────────────
  // Preset tiers commit immediately on select ("不重复" clears); "自定义" only
  // reveals the minutes input, whose value commits via Apply / Enter after the
  // 1~1440min gate (mirrors the backend's 1min~24h hard validation — the gate
  // here keeps the notice instant instead of a binding round-trip rejection).
  const REPEAT_TIERS = [5, 30, 60] as const; // minutes
  const repeatTierOf = (ms: number): string => {
    if (ms <= 0) return "0";
    if ((REPEAT_TIERS as readonly number[]).includes(ms / 60_000)) return String(ms);
    return "custom";
  };
  const applyRepeatTier = (v: string) => {
    if (!schedulingId || !onSetRepeat) return;
    if (v === "custom") return; // reveals the input; commits via applyRepeatCustom
    onSetRepeat(schedulingId, Number(v));
    setRepeatError(null);
  };
  const applyRepeatCustom = () => {
    if (!schedulingId || !onSetRepeat) return;
    const mins = Number.parseInt(repeatCustomRef.current?.value ?? "", 10);
    if (!Number.isFinite(mins) || mins < 1 || mins > 1440) {
      setRepeatError(t("queue.repeatCustomInvalid"));
      return;
    }
    onSetRepeat(schedulingId, mins * 60_000);
    setRepeatError(null);
  };
  const cancelRepeat = (id: string) => onSetRepeat?.(id, 0);

  return (
    <div className="queue-panel" data-testid="queue-panel">
      <div className="queue-header">
        <span className="queue-title">{t("queue.title", { count: queue.length })}</span>
        <span className="queue-hint">{t("queue.hint")}</span>
        {hasPending && (
          <span
            className="queue-header-clock"
            data-testid="queue-header-clock"
            data-tooltip-id="md-tip"
            data-tooltip-content={t("queue.hasScheduled")}
          >
            <Clock size={12} />
          </span>
        )}
      </div>
      {queue.map((item, idx) => {
        const pending = item.scheduledAt > now;
        const remaining = pending ? item.scheduledAt - now : 0;
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
                onCompositionStart={() => { composingRef.current = true; }}
                onCompositionEnd={() => { composingRef.current = false; }}
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
                max={toLocalInput(Date.now() + SCHEDULE_CAP_MS)}
                defaultValue={pending ? toLocalInput(item.scheduledAt) : defaultLocalInput()}
                ref={scheduleRef}
                // Manual datetime pick overrides the staged value (two-way link
                // with pendingAt, issue #130) and clears stale notices. Picks
                // beyond now+24h are REJECTED (issue #130 wrap-up): pendingAt
                // keeps the staged value, the input snaps back to it, and the
                // cap notice explains why (Save re-verifies as final gate).
                onChange={(e) => {
                  const ts = fromLocalInput(e.target.value);
                  if (ts > Date.now() + SCHEDULE_CAP_MS) {
                    setScheduleCapped(true);
                    setScheduleError(null);
                    // Programmatic value writes do not fire onChange — no loop.
                    if (scheduleRef.current) {
                      scheduleRef.current.value = pendingAt !== null && pendingAt > Date.now()
                        ? toLocalInput(pendingAt)
                        : defaultLocalInput();
                    }
                    return;
                  }
                  setPendingAt(ts > 0 ? ts : null);
                  setScheduleCapped(false);
                  setScheduleError(null);
                }}
                autoFocus
              />
              <div className="queue-item-actions">
                {SCHEDULE_PRESETS.map((mins) => (
                  <button
                    key={mins}
                    className="queue-btn preset"
                    data-testid={`queue-schedule-preset-${mins}`}
                    onClick={() => presetSchedule(mins)}
                    title={t("queue.schedulePresetTip", { mins })}
                  >
                    {t("queue.schedulePreset", { mins })}
                  </button>
                ))}
                {/* Staged-time chip (issue #130): live "+mins → clock" readout
                    of what the stacked presets / manual pick have staged. Its ✕
                    resets the staging in place (issue #130 wrap-up 2) — row stays
                    open, presets re-base on now, input snaps back to the default. */}
                {pendingAt !== null && pendingAt > now && (
                  <span
                    className="queue-schedule-pending"
                    data-testid="queue-schedule-pending"
                    data-tooltip-id="md-tip"
                    data-tooltip-content={t("queue.schedulePendingTip")}
                  >
                    <Clock size={11} />
                    {" "}
                    {t("queue.schedulePending", { mins: Math.round((pendingAt - now) / 60_000), time: formatClock(pendingAt) })}
                    <button
                      className="queue-schedule-reset"
                      data-testid="queue-schedule-pending-reset"
                      data-tooltip-id="md-tip"
                      data-tooltip-content={t("queue.scheduleResetTip")}
                      aria-label={t("queue.scheduleResetTip")}
                      onClick={resetStagedTime}
                    >
                      <X size={10} />
                    </button>
                  </span>
                )}
                {scheduleCapped && (
                  <span className="queue-schedule-cap" data-testid="queue-schedule-cap">
                    {t("queue.scheduleCap")}
                  </span>
                )}
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
              {/* Repeat tier (#111): recurrence select in the schedule edit row.
                  Presets (incl. 不重复) commit immediately; 自定义 reveals the
                  minutes input (1~1440, Apply/Enter commits). Independent of
                  Save — the tier edits recurrence, not the next-due time. */}
              <span
                className="queue-repeat-tier"
                data-testid="queue-repeat-tier"
                data-tooltip-id="md-tip"
                data-tooltip-content={t("queue.repeatTip")}
              >
                <Repeat size={11} />
                <select
                  className="queue-repeat-select"
                  data-testid="queue-repeat-select"
                  value={repeatTierOf(item.repeatEveryMs ?? 0)}
                  disabled={!onSetRepeat}
                  onChange={(e) => applyRepeatTier(e.target.value)}
                >
                  <option value="0">{t("queue.repeatNone")}</option>
                  {REPEAT_TIERS.map((m) => (
                    <option key={m} value={m * 60_000}>
                      {t("queue.repeatEvery", { interval: formatRepeatInterval(m * 60_000, t) })}
                    </option>
                  ))}
                  <option value="custom">{t("queue.repeatCustom")}</option>
                </select>
                {repeatTierOf(item.repeatEveryMs ?? 0) === "custom" && (
                  <>
                    <input
                      className="queue-repeat-custom"
                      data-testid="queue-repeat-custom"
                      type="number"
                      min={1}
                      max={1440}
                      placeholder={t("queue.repeatCustomUnit")}
                      defaultValue={(item.repeatEveryMs ?? 0) > 0 ? String(Math.round(item.repeatEveryMs! / 60_000)) : ""}
                      ref={repeatCustomRef}
                      onKeyDown={(e) => {
                        if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
                        if (e.key === "Enter") {
                          e.preventDefault();
                          applyRepeatCustom();
                        }
                      }}
                    />
                    <button
                      className="queue-btn save"
                      data-testid="queue-repeat-apply"
                      onClick={applyRepeatCustom}
                      title={t("queue.repeatApplyTip")}
                    >
                      <Check size={13} /> {t("queue.repeatApply")}
                    </button>
                  </>
                )}
                {repeatError && (
                  <span className="queue-schedule-error" data-testid="queue-repeat-error">
                    {repeatError}
                  </span>
                )}
              </span>
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
                  {remaining > 0 && (
                    <span className="queue-countdown" data-testid="queue-countdown">
                      {" "}{t("queue.inRemaining", { remaining: formatRemaining(remaining, t) })}
                    </span>
                  )}
                </span>
              ) : item.scheduledAt > 0 ? (
                <span className="queue-scheduled" data-testid="queue-scheduled">
                  {t("queue.scheduled", { time: formatClock(item.scheduledAt) })}
                </span>
              ) : null}
              {/* Recurring badge (#111): interval in human terms + "sent N×"
                  odometer. Coexists with the #97 countdown above (a recurring
                  item has BOTH a next-due time and an interval). The inline ✕
                  is the one-click cancel — no need to open the schedule row. */}
              {(item.repeatEveryMs ?? 0) > 0 && (
                <span
                  className="queue-repeat-badge"
                  data-testid="queue-repeat-badge"
                  data-tooltip-id="md-tip"
                  data-tooltip-content={t("queue.repeatBadgeTip")}
                >
                  <Repeat size={11} /> {t("queue.repeatEvery", { interval: formatRepeatInterval(item.repeatEveryMs!, t) })}
                  {(item.sentCount ?? 0) > 0 && (
                    <span className="queue-repeat-sent" data-testid="queue-repeat-sent">
                      {" "}{t("queue.repeatSent", { count: item.sentCount })}
                    </span>
                  )}
                  <button
                    className="queue-repeat-reset"
                    data-testid="queue-repeat-cancel"
                    data-tooltip-id="md-tip"
                    data-tooltip-content={t("queue.repeatCancelTip")}
                    aria-label={t("queue.repeatCancelTip")}
                    onClick={() => cancelRepeat(item.id)}
                  >
                    <X size={10} />
                  </button>
                </span>
              )}
              <div className="queue-item-actions">
                {/* Mobile reorder (issue #126B): HTML5 drag is unreachable on touch, so the
                    actions row gains explicit up/down buttons hidden on desktop (CSS). They
                    reuse onReorder with the adjacent item as target — splice-based semantics
                    make that an exact adjacent swap; disabled at list edges. */}
                <button
                  className="queue-btn move"
                  data-testid="queue-move-up"
                  disabled={idx === 0}
                  data-tooltip-id="md-tip"
                  data-tooltip-content={t("queue.moveUpTip")}
                  aria-label={t("queue.moveUpTip")}
                  onClick={() => onReorder(item.id, queue[idx - 1].id)}
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  className="queue-btn move"
                  data-testid="queue-move-down"
                  disabled={idx === queue.length - 1}
                  data-tooltip-id="md-tip"
                  data-tooltip-content={t("queue.moveDownTip")}
                  aria-label={t("queue.moveDownTip")}
                  onClick={() => onReorder(item.id, queue[idx + 1].id)}
                >
                  <ChevronDown size={14} />
                </button>
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

// Format milliseconds remaining into a localized compact countdown for the live badge
// (Task #24245 / issue #97). Picks the coarsest non-zero bucket: h/m/s, m/s, or s only.
// e.g. 3905_000ms → "1h 5m 5s" / "1时5分5秒"; 305_000ms → "5m 5s"; 45_000ms → "45s".
function formatRemaining(ms: number, t: TFunction): string {
  if (ms <= 0) return "";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return t("queue.countdownHms", { h, m, s });
  if (m > 0) return t("queue.countdownMs", { m, s });
  return t("queue.countdownS", { s });
}

// Format a repeat interval (ms) into a localized compact form (#111):
// whole hours → "1小时"/"1h"; otherwise minutes → "5分钟"/"5m". Used by both
// the tier select options and the recurring badge.
function formatRepeatInterval(ms: number, t: TFunction): string {
  const mins = Math.round(ms / 60_000);
  if (mins % 60 === 0) return t("queue.repeatH", { h: mins / 60 });
  return t("queue.repeatM", { m: mins });
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
