import React, { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { Project, Session } from "../../bindings/github.com/jessonchan/monkey-deck/internal/store/models";
import type { ChatItem, ConfigOption, PermissionPrompt, StatusPayload, QueueItem, Mention, ImageAttachment, PlanEntry, LivePlan, Usage } from "../types";
import Composer from "./Composer";
import QueuePanel from "./QueuePanel";
import Collapsible from "./Collapsible";
import CollapsibleText from "./CollapsibleText";
import FilePreviewOverlay, { type PreviewTarget } from "./FilePreviewOverlay";
import MermaidRenderer from "./MermaidRenderer";
import PathLinkified from "./PathLinkified";
import { countDiffLines, diffLineCls } from "../lib/diff";
import { buildRows, computeLayout, computeWindow, anchorAt, restoreScroll, isAtBottom, HeightModel, TAIL_PRIOR, HEAD_PRIOR, type VRow, type Layout } from "../lib/virtualList";
import { SquareTerminal, Sparkles, Brain, Check, Copy, Wrench, ShieldAlert, ChevronRight, ChevronDown, ChevronUp, ArrowDown, Terminal, FilePen, FileText, Search, ListChecks, RefreshCw, Eye, MessageSquarePlus } from "lucide-react";

interface Props {
  project: Project | null;
  session: Session | null;
  items: ChatItem[];
  status: StatusPayload["status"] | "empty";
  statusDetail: string;
  usage: Usage;
  error: string | null;
  permission: PermissionPrompt | null;
  mergeResult: string | null;
  sessionDiff: string | null;
  onSend: (text: string, mentions: Mention[], images?: ImageAttachment[]) => void;
  onEnqueue: (text: string, mentions: Mention[], images?: ImageAttachment[]) => void;
  onStop: () => void;
  onContinue: () => void;
  onAction: (action: "clear" | "new" | "stop") => void;
  onRespondPermission: (optionId: string) => void;
  onToggleTerminal: () => void;
  onRefreshConfig: () => void;
  refreshingConfig: boolean;
  onMerge: () => void;
  queue: QueueItem[];
  onInterruptQueue: (id: string) => void;
  onRevokeQueue: (id: string) => void;
  onEditQueue: (id: string, text: string) => void;
  onScheduleQueue: (id: string, scheduledAt: number) => void;
  composerValue: string;
  onComposerChange: (v: string) => void;
  attachments: string[];
  onAttachmentsChange: (next: string[]) => void;
  mentions: Mention[];
  onMentionsChange: (next: Mention[]) => void;
  images: ImageAttachment[];
  onImagesChange: (next: ImageAttachment[]) => void;
  imageSupported: boolean;
  history: string[];
  sessionId: string;
  configOptions: ConfigOption[];
  // 当前 turn 的实时 plan(进行中的 turn 由 plan 事件流式刷新;turn 结束转为持久化
  // type:'plan' ChatItem 内联渲染在 items 里)。null = 当前无实时 plan。
  livePlan: LivePlan | null;
  onSetConfig: (configId: string, value: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  activity?: "thinking" | "executing" | "replying";
}
// 状态 → i18n key + 样式。label 在渲染处用 t() 解析(支持语言切换)。
const STATUS_MAP: Record<string, { key: string; cls: string }> = {
  idle: { key: "chat.status.idle", cls: "st-idle" },
  started: { key: "chat.status.ready", cls: "st-idle" },
  readonly: { key: "chat.status.readonly", cls: "st-readonly" },
  error: { key: "chat.status.error", cls: "st-error" },
  closed: { key: "chat.status.closed", cls: "st-closed" },
  empty: { key: "", cls: "" },
};
const statusInfo = (status: string, activity?: string): { key: string; cls: string } => {
  if (status === "prompting") {
    switch (activity) {
      case "executing": return { key: "chat.status.executing", cls: "st-executing" };
      case "replying": return { key: "chat.status.replying", cls: "st-replying" };
      case "thinking": return { key: "chat.status.thinking", cls: "st-thinking" };
      default: return { key: "chat.status.generating", cls: "st-busy" };
    }
  }
  return STATUS_MAP[status] || { key: "", cls: "" };
};
const TOOL_STATUS_MAP: Record<string, { key: string; cls: string }> = {
  pending: { key: "chat.toolStatus.pending", cls: "tc-pending" },
  in_progress: { key: "chat.toolStatus.in_progress", cls: "tc-running" },
  completed: { key: "chat.toolStatus.completed", cls: "tc-done" },
  failed: { key: "chat.toolStatus.failed", cls: "tc-fail" },
};
export interface ChatViewHandle {
  scrollToBottom: () => void;
}



export default forwardRef<ChatViewHandle, Props>(function ChatView(props: Props, ref) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  // 内容层:绝对定位行 + 尾部区的容器。高度 = 布局 total(显式撑开滚动条),行位置由模型单方面设定。
  const contentRef = useRef<HTMLDivElement>(null);
  const { items } = props;
  // 用户是否贴底:记最近一次滚动的「贴底」状态。新消息到来时只在贴底才自动滚,
  // 用户向上翻阅历史时不打断(避免每条新消息强制拽回底部)。
  const stickToBottomRef = useRef(true);
  // 按 session 记忆滚动位置:锚点 = 视口顶部行的 id + 条内偏移,stick = 是否贴底。
  // 切走时存、切回时恢复——用户读到哪里就从哪里继续;贴底的恢复到底部(看最新)。
  // 不记像素 scrollTop:高度模型先验→实测会收敛,像素坐标不稳定;行 id 才是稳定坐标(§5.3)。
  const scrollStateRef = useRef<Map<string, { iid: string; off: number; stick: boolean }>>(new Map());
  // sessionId 的实时镜像:onScroll 的 rAF 回调读它而不是闭包里的 props——
  // 否则切换瞬间挂起的 rAF 会把新 session 的几何信息记到旧 session 名下(触控板惯性滚动必现)。
  const sessionIdLiveRef = useRef("");
  sessionIdLiveRef.current = props.session?.id || "";
  // 虚拟化高度模型(唯一高度事实源,见 lib/virtualList.ts):实测 Map + 类型先验。
  // 按 session 切走 prune 防无界增长;切回重载后实测清空、由 RO 重测收敛。
  const modelRef = useRef(new HeightModel());
  // 布局缓存:每次 render 由 (rows, model, tailH) 重算并写入;onScroll 的 rAF 回调读它判贴底/锚点,
  // 不读 el.scrollHeight(虚拟化下 scrollHeight 恒 = 显式 total,读它无信息且触发强制布局)。
  const layoutRef = useRef<Layout>({ tops: [], heights: [], tailTop: 0, total: 0 });
  // 尾部区(加载更多/权限卡/实时 plan/打字指示)实测高度;未实测前用 TAIL_PRIOR。
  const tailHRef = useRef(TAIL_PRIOR);
  // 当前锚点(非贴底时):行 id + 条内偏移。锚点上方行变高 → 补偿 scrollTop 保持视觉位置(A 不变量)。
  const anchorRef = useRef<{ iid: string; off: number } | null>(null);
  const prevSessionIdRef = useRef<string>("");
  // prepend(加载更多)检测:记录上一轮的首条 id,首条变了 → 补偿新增行高度,保持视觉位置(P 不变量)。
  const prevFirstIdRef = useRef<string>("");
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  // onScroll 的 rAF 句柄:一帧内多个 scroll 事件合并处理一次,杜绝布局抖动。
  const scrollRafRef = useRef(0);
  // Floating scroll-to-bottom button visibility: true = show FAB (user is reading history).
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  // 文件预览覆盖层(Task #15084):对话/工具卡片里的路径点击 → 弹此覆盖层。
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);
  // plan 展开/折叠偏好:按 session 持久化(localStorage)(Task #21298)。
  // 同一 session 内所有 plan(当前 turn 实时 + 历史 turn 静态)共用一个偏好,用户折叠/展开
  // 一次后整 session 遵循,重开会话也能恢复。默认展开(不再按条数折叠)。
  const [planOpen, setPlanOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem(`md:plan-open:${props.sessionId}`);
    return saved === null ? true : saved === "1";
  });
  // ChatView 不随 session 切换重挂载(用 ref 检测):切到别的 session 时,从 localStorage 重读
  // 该 session 的偏好,避免沿用上一 session 的内存状态。
  useEffect(() => {
    const saved = localStorage.getItem(`md:plan-open:${props.sessionId}`);
    setPlanOpen(saved === null ? true : saved === "1");
  }, [props.sessionId]);
  const onTogglePlanOpen = useCallback(() => {
    setPlanOpen((prev) => {
      const next = !prev;
      localStorage.setItem(`md:plan-open:${props.sessionId}`, next ? "1" : "0");
      return next;
    });
  }, [props.sessionId]);
  const openFilePreview = useCallback((path: string, line?: number) => {
    setPreviewTarget({ path, line });
  }, []);
  const closeFilePreview = useCallback(() => setPreviewTarget(null), []);
  // ─── 虚拟化:状态 / 派生数据 / 助手 ───
  // 窗口 [start, end):只有这些行进入 DOM。区间变化才 setState(W 不变量)。
  const [win, setWin] = useState({ start: 0, end: 0 });
  // 模型版本号:实测高度写入即 bump → 触发布局重算 + 重渲染。
  const [modelVersion, setModelVersion] = useState(0);
  // 头部区(顶部留白/加载更多/占位)实测高度;未实测前用 HEAD_PRIOR。
  const headHRef = useRef(HEAD_PRIOR);
  // rows 最新镜像:rAF/RO 回调读它,不读闭包。
  const rowsRef = useRef<VRow[]>([]);
  // 共享 ResizeObserver + 已观察元素集合(随窗口/items 变化与 DOM 同步)。
  const roRef = useRef<ResizeObserver | null>(null);
  const observedRef = useRef<Set<Element>>(new Set());
  // pendingScrollRef:切走丢弃后切回的 session 要从 DB 异步重载,切换瞬间 items 仍为空。
  // 若此时定位会落到错位(空容器下值无意义);等 items 到达时切换分支已不再触发 → 卡在错位。
  // 故 items 为空时推迟定位,记下待定 session,items 首次非空时补做(见 useLayoutEffect)。
  const pendingScrollRef = useRef<string | null>(null);

  // rows = 把 items 折叠成渲染行(连续 tool 成组);layout = 前缀和几何(唯一坐标事实,含 headPad 与 scrollTop 同系)。
  const rows = useMemo(() => buildRows(items), [items]);
  // 每个回合的起止时间,供 TurnDivider 显示本轮持续时间。
  // turn start = user 消息 ts(发送时刻落库);turn end = 该回合最后一条消息的 ts
  // —— persistTurn 在回合结束时统一写库,最后一条 createdAt ≈ 回合结束时刻(§5.3 尊重数据源)。
  // 仅「已结束」回合算出 end:有后续 user 消息(下回合已开)必为结束;最后一回合在非 prompting
  // (idle/error/…)时视为结束。进行中(prompting)的回合不显示时长(无结束时刻)。
  const turnBounds = useMemo(() => {
    const m = new Map<number, { start?: number; end?: number }>();
    const userIdx: number[] = [];
    for (let i = 0; i < items.length; i++) if (items[i].type === "user") userIdx.push(i);
    for (let k = 0; k < userIdx.length; k++) {
      const start = userIdx[k];
      const startTs = items[start].ts;
      const isLast = k === userIdx.length - 1;
      const endIdx = isLast ? items.length - 1 : userIdx[k + 1] - 1;
      const complete = !isLast || props.status !== "prompting";
      m.set(start, { start: startTs, end: complete ? items[endIdx]?.ts : undefined });
    }
    return m;
  }, [items, props.status]);
  const layout = useMemo(
    () => computeLayout(rows, modelRef.current, tailHRef.current, headHRef.current),
    // modelRef/tailHRef/headHRef 是 ref:modelVersion bump 是重算信号(RO 回调写入时保证同步 bump)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, modelVersion]
  );
  // render 期写镜像:rAF/RO 回调读最新值(不读 el.scrollHeight,虚拟化下它恒 = 显式 total)。
  layoutRef.current = layout;
  rowsRef.current = rows;

  // 窗口计算(W):overscan 取 600px 与一屏的较大者。
  const computeWinFor = useCallback((lay: Layout, scrollTop: number) => {
    const viewport = scrollRef.current?.clientHeight ?? 0;
    return computeWindow(lay, scrollTop, viewport, Math.max(600, viewport));
  }, []);

  // 窗口区间真正变化才 setState(滚动在同一窗口内逐帧不重渲染)。
  const setWinIfChanged = useCallback((next: { start: number; end: number }) => {
    setWin((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, []);

  // 把 RO 观察集合与当前 DOM 同步:观察新挂载的 .cv-item/.cv-head/.cv-tail,取消已移除的。
  const syncObserved = useCallback(() => {
    const ro = roRef.current;
    const contentEl = contentRef.current;
    if (!ro || !contentEl) return;
    const observed = observedRef.current;
    const current = new Set<Element>();
    contentEl.querySelectorAll<HTMLElement>(".cv-item, .cv-head, .cv-tail").forEach((el) => current.add(el));
    for (const el of current) if (!observed.has(el)) { ro.observe(el); observed.add(el); }
    for (const el of observed) if (!current.has(el)) { ro.unobserve(el); observed.delete(el); }
  }, []);

  // Expose imperative scrollToBottom to parent (used right after user sends a message).
  useImperativeHandle(ref, () => ({
    scrollToBottom: () => {
      const el = scrollRef.current;
      if (!el) return;
      anchorRef.current = null; // 明确要到底 → 清除锚点
      stickToBottomRef.current = true;
      const bottom = Math.max(0, layoutRef.current.total - el.clientHeight);
      el.scrollTop = bottom;
      setShowScrollBtn(false);
      // 立即按底部 scrollTop 重算窗口(不等 scroll 事件回环)。
      setWinIfChanged(computeWinFor(layoutRef.current, bottom));
    },
  }), [computeWinFor, setWinIfChanged]);

  const onScroll = () => {
    // rAF 合批:同一帧内多个 scroll 事件只处理一次,避免与浏览器绘制竞争造成掉帧。
    if (scrollRafRef.current) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      const el = scrollRef.current;
      if (!el) return;
      const lay = layoutRef.current;
      const nearBottom = isAtBottom(lay.total, el.scrollTop, el.clientHeight);
      stickToBottomRef.current = nearBottom;
      // 仅在状态真正翻转时 setState(避免每帧无谓的 setter 调用)。
      setShowScrollBtn((prev) => (prev === !nearBottom ? prev : !nearBottom));
      // 锚点(A 不变量):视口顶部命中的行 + 条内偏移;贴底则清除。
      // sessionId 读实时镜像(见 sessionIdLiveRef),不用本闭包的 props.session。
      const a = anchorAt(lay, el.scrollTop);
      if (nearBottom || !a) {
        anchorRef.current = null;
        scrollStateRef.current.set(sessionIdLiveRef.current, { iid: "", off: 0, stick: true });
      } else {
        const iid = rowsRef.current[a.index]?.id ?? "";
        anchorRef.current = iid ? { iid, off: a.off } : null;
        scrollStateRef.current.set(sessionIdLiveRef.current, { iid, off: a.off, stick: false });
      }
      // 窗口重算(W 不变量)。
      setWinIfChanged(computeWinFor(lay, el.scrollTop));
    });
  };

  // 切换/重载后的一次性定位:有锚点记忆且非贴底 → 恢复到该条目原位;否则贴底(看最新)。
  // 此刻高度仍是先验估算:锚点恢复自洽(估算位即当前位置);贴底则是「估算底部」,
  // 之后由 ResizeObserver 随真实渲染持续收敛到真底部。
  const applyInitialPosition = (el: HTMLDivElement, sessionId: string) => {
    const saved = scrollStateRef.current.get(sessionId);
    const lay = layoutRef.current;
    const restored = saved && !saved.stick && saved.iid
      ? restoreScroll(lay, rowsRef.current, saved.iid, saved.off)
      : null;
    if (restored !== null && saved) {
      stickToBottomRef.current = false;
      anchorRef.current = { iid: saved.iid, off: saved.off };
      setShowScrollBtn(true);
      el.scrollTop = restored;
      setWinIfChanged(computeWinFor(lay, restored));
    } else {
      stickToBottomRef.current = true;
      anchorRef.current = null;
      setShowScrollBtn(false);
      const bottom = Math.max(0, lay.total - el.clientHeight);
      el.scrollTop = bottom;
      setWinIfChanged(computeWinFor(lay, bottom));
    }
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sessionId = props.session?.id || "";
    // 切 session:瞬间定位(不动画,避免「乱滚」)。有记忆且不在底部 → 恢复原位;否则贴底(看最新)。
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId;
      // 实测高度剪枝到当前行集(防 Map 无界增长)。
      modelRef.current.prune(new Set(rows.map((r) => r.id)));
      if (items.length > 0) {
        pendingScrollRef.current = null;
        applyInitialPosition(el, sessionId);
      } else {
        // items 还没到(切走丢弃重载中 / 首次加载中):推迟定位,等 items 到来再补做,否则错位。
        pendingScrollRef.current = sessionId;
        anchorRef.current = null; // 旧 session 的锚点不带过切换
      }
      prevFirstIdRef.current = items.length > 0 ? items[0].id : "";
      return; // 切换瞬间一次性定位,不走下面的逻辑。
    }
    // 待定位 session 的 items 到达(DB 重载完成 / 首次加载完成):补做定位。
    if (pendingScrollRef.current === sessionId && items.length > 0) {
      pendingScrollRef.current = null;
      applyInitialPosition(el, sessionId);
      prevFirstIdRef.current = items[0].id;
      return;
    }
    // 加载更多(prepend):首条 id 变了 → 补偿插入行的高度,保持用户视觉位置不动(P 不变量)。
    const firstId = items.length > 0 ? items[0].id : "";
    if (firstId !== prevFirstIdRef.current && prevFirstIdRef.current !== "" && firstId) {
      const idx = rows.findIndex((r) => r.id === prevFirstIdRef.current);
      if (idx > 0) {
        // 旧首行新 top - 头部区高度(头区不变) = 插入行的高度。
        el.scrollTop += layout.tops[idx] - headHRef.current;
      }
      stickToBottomRef.current = isAtBottom(layout.total, el.scrollTop, el.clientHeight);
      setShowScrollBtn(!stickToBottomRef.current);
      prevFirstIdRef.current = firstId;
      setWinIfChanged(computeWinFor(layout, el.scrollTop));
      return;
    }
    // 同一 session 内 items 变化(流式输出 / 历史加载完成):仅在贴底时跟随(S 不变量)。
    if (stickToBottomRef.current) {
      const bottom = Math.max(0, layout.total - el.clientHeight);
      el.scrollTop = bottom;
      setWinIfChanged(computeWinFor(layout, bottom));
    } else {
      setWinIfChanged(computeWinFor(layout, el.scrollTop));
    }
    prevFirstIdRef.current = firstId;
  }, [items, props.session?.id, props.permission, rows, layout, computeWinFor, setWinIfChanged]);

  // ResizeObserver:唯一测量入口(M 不变量)。观察容器(视口变化)+ 头/尾区 + 窗口内行。
  // 行高变化 → 写 HeightModel → 重算布局 → A 不变量补偿(锚点上方行)/ S 不变量贴底 → 窗口重算。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const model = modelRef.current;
      const rs = rowsRef.current;
      const idxById = new Map<string, number>();
      rs.forEach((r, i) => idxById.set(r.id, i));
      const anchorIid = anchorRef.current?.iid ?? null;
      const anchorIdx = anchorIid ? idxById.get(anchorIid) ?? -1 : -1;
      let modelChanged = false;
      let viewportChanged = false;
      let delta = 0; // A 不变量:锚点上方行的高度变化累计
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        if (target === el) { viewportChanged = true; continue; }
        const iid = target.dataset.iid;
        const h = target.offsetHeight;
        if (iid === "__head__") {
          if (h > 0 && headHRef.current !== h) { headHRef.current = h; modelChanged = true; }
        } else if (iid === "__tail__") {
          if (h > 0 && tailHRef.current !== h) { tailHRef.current = h; modelChanged = true; }
        } else if (iid) {
          const idx = idxById.get(iid) ?? -1;
          const prevH = idx >= 0 ? model.h(rs[idx]) : 0;
          if (model.set(iid, h)) {
            modelChanged = true;
            if (!stickToBottomRef.current && anchorIdx >= 0 && idx >= 0 && idx < anchorIdx) {
              delta += h - prevH;
            }
          }
        }
      }
      if (!modelChanged && !viewportChanged && delta === 0) return;
      const newLay = computeLayout(rs, model, tailHRef.current, headHRef.current);
      layoutRef.current = newLay;
      if (delta !== 0) el.scrollTop += delta; // A 不变量:锚点上方行变高 → 下推保持视觉位置
      if (stickToBottomRef.current) el.scrollTop = Math.max(0, newLay.total - el.clientHeight); // S 不变量
      setWinIfChanged(computeWinFor(newLay, el.scrollTop));
      if (modelChanged) setModelVersion((v) => v + 1);
    });
    roRef.current = ro;
    observedRef.current = new Set(); // session 切换(.chat-body 按 key 重挂载)清空旧观察集
    ro.observe(el);
    return () => { ro.disconnect(); roRef.current = null; };
  }, [props.sessionId, computeWinFor, setWinIfChanged]);

  // 把 RO 观察集合与当前 DOM 同步(窗口/items 变化后)。
  useEffect(() => {
    syncObserved();
  }, [props.sessionId, win.start, win.end, items, syncObserved]);

  // 卸载时取消未派发的 scroll rAF,避免回调在组件已卸载后操作失效 ref。
  useEffect(() => () => { if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current); }, []);

  // IntersectionObserver:「加载更多」按钮进入容器视口时自动触发(原生 API,零依赖)。
  // 与 prepend-scroll 补偿/useLayoutEffect 独立协作,后者负责保持视觉位置。
  useEffect(() => {
    const btn = loadMoreRef.current;
    if (!btn) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && props.hasMore && !props.loadingMore) props.onLoadMore();
      },
      { root: scrollRef.current, threshold: 0.1 }
    );
    io.observe(btn);
    return () => io.disconnect();
  }, [props.hasMore, props.loadingMore, props.onLoadMore]);

  const s = statusInfo(props.status, props.activity);

  const onTitleDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, input, a")) return;
    void ChatService.ToggleMaximise();
  };

  return (
    <div className="chat-view">
      <header className="chat-header" onDoubleClick={onTitleDoubleClick}>
        <div className="chat-header-info">
          <span className="chat-project" title={props.project?.path || ""}>{props.project?.name || ""}</span>
          <span className="chat-sep">/</span>
          <span className="chat-session-title">{props.session?.title || t("chat.newSessionTitle")}</span>
          {props.session?.model && <span className="chat-model">{props.session.model}</span>}
        </div>
        <div className="chat-header-actions">
          {s.key && <span className={`status-badge ${s.cls}`}>{t(s.key)}</span>}
          <button
            className="icon-btn small"
            onClick={props.onRefreshConfig}
            disabled={props.refreshingConfig}
            data-tooltip-id="md-tip"
            data-tooltip-content={props.refreshingConfig ? t("chat.refreshingConfig") : t("chat.refreshConfigTip")}
            data-tooltip-place="bottom"
            aria-label={t("chat.refreshConfigTip")}
            data-testid="refresh-config-btn"
          >
            <RefreshCw size={15} className={props.refreshingConfig ? "spin" : undefined} />
          </button>
          <button className="icon-btn small" onClick={props.onToggleTerminal} data-tooltip-id="md-tip" data-tooltip-content={t("chat.toggleTerminalTip")} aria-label={t("chat.toggleTerminal")}>
            <SquareTerminal size={15} />
          </button>
        </div>
      </header>

      {props.status === "readonly" && (
        <div className="readonly-banner" data-testid="readonly-banner">
          <span className="readonly-banner-text">
            <Eye size={14} />
            {t("chat.readonlyHint")}
          </span>
          <button
            className="readonly-continue-btn"
            onClick={props.onContinue}
            data-tooltip-id="md-tip"
            data-tooltip-content={t("chat.continueSessionTip")}
            data-testid="continue-session-btn"
          >
            <MessageSquarePlus size={14} />
            {t("chat.continueSession")}
          </button>
        </div>
      )}

      <div className="chat-body" key={props.sessionId} ref={scrollRef} onScroll={onScroll} data-testid="chat-body">
        {/* 内容层:显式高度 = 布局 total(撑开滚动条),行绝对定位(top = layout.tops,与 scrollTop 同系)。 */}
        <div className="chat-content" ref={contentRef} style={{ height: layout.total }}>
          {/* 头部区:顶部留白 + 加载更多 + 占位。实测高度 headHRef(data-iid=__head__)。 */}
          <div className="cv-head" data-iid="__head__" style={{ top: 0 }}>
            {items.length === 0 && <div className="chat-placeholder">{t("chat.placeholder")}</div>}
            {props.hasMore && (
              <button ref={loadMoreRef} className="load-more-btn" onClick={props.onLoadMore} disabled={props.loadingMore} data-testid="load-more">
                {props.loadingMore ? t("common.loading") : t("chat.loadMore")}
              </button>
            )}
          </div>
          {/* 窗口化行:只有 [win.start, win.end) 的行进入 DOM(W 不变量)。 */}
          {rows.slice(win.start, win.end).map((row, wi) => {
            const index = win.start + wi;
            let content: React.ReactNode;
            if (row.kind === "tool") {
              // 连续 tool 折叠:2 个以上渲染为 ToolGroup,单个仍用 ToolCard。
              const group = items.slice(row.first, row.last) as Extract<ChatItem, { type: "tool" }>[];
              content = group.length >= 2
                ? <ToolGroup tools={group} onOpenFilePreview={openFilePreview} />
                : <ToolCard item={group[0]} onOpenFilePreview={openFilePreview} />;
            } else if (row.kind === "plan") {
              // 历史 turn 的 plan(静态展示,无 spinner —— turn 已结束,plan 是定格快照)。
              content = <PlanTimeline entries={(items[row.first] as Extract<ChatItem, { type: "plan" }>).entries} prompting={false} isOpen={planOpen} onToggle={onTogglePlanOpen} />;
            } else {
              const userItem = row.kind === "user" ? (items[row.first] as Extract<ChatItem, { type: "user" }>) : undefined;
              const tb = userItem ? turnBounds.get(row.first) : undefined;
              const durationMs = tb?.start && tb?.end && tb.end > tb.start ? tb.end - tb.start : undefined;
              content = (
                <>
                  {/* 回合分隔:每条用户消息(首条除外)前插一条带时间的分隔线,让多轮对话边界清晰。 */}
                  {userItem && row.first > 0 && <TurnDivider ts={userItem.ts} durationMs={durationMs} />}
                  <ChatRow item={items[row.first]} sessionId={props.sessionId} onOpenFilePreview={openFilePreview} />
                </>
              );
            }
            return (
              <div className="cv-item" data-iid={row.id} key={row.id} style={{ top: layout.tops[index] }}>
                {content}
              </div>
            );
          })}
          {/* 尾部区:权限卡 + 实时 plan + 打字指示。实测高度 tailHRef(data-iid=__tail__)。 */}
          <div className="cv-tail" data-iid="__tail__" style={{ top: layout.tailTop }}>
            {props.permission && <PermissionCard prompt={props.permission} onRespond={props.onRespondPermission} />}
            {/* 当前 turn 的实时 plan(进行中,带 spinner)。turn 结束后由 App.tsx 转为持久化
                type:'plan' ChatItem 内联渲染在 items 里(无 spinner 的静态展示)。 */}
            {props.livePlan && props.livePlan.entries.length > 0 && (
              <PlanTimeline entries={props.livePlan.entries} prompting={props.status === "prompting"} isOpen={planOpen} onToggle={onTogglePlanOpen} />
            )}
            {props.status === "prompting" && items.length > 0 && (
              <div className="typing-indicator"><span /> <span /> <span /></div>
            )}
          </div>
        </div>
        {/* Floating scroll-to-bottom FAB: sticky 粘在 chat-body 底部,不破坏 flex/overflow 滚动布局。 */}
        {showScrollBtn && (
          <div className="scroll-bottom-wrap">
            <button
              className="scroll-bottom-btn"
              onClick={() => {
                const el = scrollRef.current;
                if (!el) return;
                anchorRef.current = null; // 用户明确回到底部 → 清除锚点
                stickToBottomRef.current = true;
                const bottom = Math.max(0, layoutRef.current.total - el.clientHeight);
                el.scrollTop = bottom;
                setShowScrollBtn(false);
                setWinIfChanged(computeWinFor(layoutRef.current, bottom));
              }}
              data-tooltip-id="md-tip"
              data-tooltip-content={t("chat.scrollToBottom")}
              data-testid="scroll-bottom-btn"
            >
              <ArrowDown size={16} />
            </button>
          </div>
        )}
      </div>
      {props.error && <div className="error-bar">⚠ {props.error}</div>}
      {props.mergeResult && <div className={`merge-result ${props.mergeResult.startsWith("✅") ? "ok" : "fail"}`}>{props.mergeResult}</div>}
      <FilePreviewOverlay sessionId={props.sessionId} target={previewTarget} onClose={closeFilePreview} />
      <footer className="chat-footer">
        <QueuePanel
          queue={props.queue}
          onInterrupt={props.onInterruptQueue}
          onRevoke={props.onRevokeQueue}
          onEdit={props.onEditQueue}
          onSchedule={props.onScheduleQueue}
        />
        <Composer
          value={props.composerValue}
          onChange={props.onComposerChange}
          attachments={props.attachments}
          onAttachmentsChange={props.onAttachmentsChange}
          mentions={props.mentions}
          onMentionsChange={props.onMentionsChange}
          images={props.images}
          onImagesChange={props.onImagesChange}
          imageSupported={props.imageSupported}
          usage={props.usage}
          disabled={!props.session}
          prompting={props.status === "prompting"}
          configOptions={props.configOptions}
          onSetConfig={props.onSetConfig}
          onSend={props.onSend}
          onEnqueue={props.onEnqueue}
          onStop={props.onStop}
          onAction={props.onAction}
          history={props.history}
          sessionId={props.sessionId}
        />
      </footer>
    </div>
  );
});


const ChatRow = memo(function ChatRow({ item, sessionId, onOpenFilePreview }: { item: ChatItem; sessionId: string; onOpenFilePreview: (path: string, line?: number) => void }) {
  if (item.type === "user") {
    return (
      <div className="row row-user" data-testid="msg-user">
        <div className="bubble-user-wrap">
          <MessageActions text={item.text} className="user-msg-actions" testId="copy-user-msg" />
          <UserBubble text={item.text} onOpenFilePreview={onOpenFilePreview} />
        </div>
      </div>
    );
  }
  if (item.type === "agent") {
    return (
      <div className="row row-agent" data-testid="msg-agent">
        <div className="avatar"><Sparkles size={15} /></div>
        <div className="bubble-agent-wrap">
          <div className="bubble-agent">
            <AgentMarkdown text={item.text + (item.streaming ? " ▋" : "")} onOpenFilePreview={onOpenFilePreview} streaming={item.streaming} />
          </div>
          <div className="msg-meta">
            {item.ts && <span className="msg-time">{formatTime(item.ts)}</span>}
            {!item.streaming && item.text && <MessageActions text={item.text} />}
          </div>
        </div>
      </div>
    );
  }
  if (item.type === "thought") {
    return <ThoughtBlock item={item} sessionId={sessionId} onOpenFilePreview={onOpenFilePreview} />;
  }
  if (item.type === "plan") {
    // plan 由 items.map 顶层分支渲染为 PlanTimeline,ChatRow 不应收到 plan item。
    // 防御性返回 null(TS 收窄:剩余类型只剩 tool,但 union 里仍有 plan,显式处理)。
    return null;
  }
  return <ToolCard item={item} onOpenFilePreview={onOpenFilePreview} />;
});

// ─── 用户消息气泡 ───
// 长文本(日志/代码/大段文本)默认折叠(首尾若干行 + 中间省略),展开后限高可滚动;
// 区分内容类型:含 ``` 围栏 → ReactMarkdown(复用 CodeBox 等宽代码块,即「现成方案」);
// 无围栏但具备代码/日志特征 → 等宽 + 可读换行(避免无差别 <pre> 横向溢出,§4.4);
// 普通散文 → 可读换行。展开/收起交互 + 折叠预览与 Composer 长文本折叠形态一致。
const USER_LONG_LINES = 8;        // 行数阈值:超过即判定为长文本
const USER_LONG_CHARS = 480;      // 字符阈值:单/双行长文本兜底
const USER_HEAD_LINES = 4;        // 折叠预览展示前 N 行
const USER_TAIL_LINES = 2;        // 折叠预览展示后 M 行

function UserBubble({ text, onOpenFilePreview }: { text: string; onOpenFilePreview: (path: string, line?: number) => void }) {
  const { t } = useTranslation();
  const lines = useMemo(() => text.split("\n"), [text]);
  const isLong = lines.length > USER_LONG_LINES || text.length > USER_LONG_CHARS;
  const hasCodeFence = text.includes("```");
  // 内容类型:markdown(有围栏)/ mono(代码或日志特征)/ prose(普通散文)。
  const renderKind: "markdown" | "mono" | "prose" = hasCodeFence
    ? "markdown"
    : looksLikeCodeOrLog(lines)
      ? "mono"
      : "prose";
  // 长文本默认折叠;短文本无折叠态。
  const [collapsed, setCollapsed] = useState(isLong);

  // 折叠预览:行多 → 首尾若干行 + 中间省略条;行少但字符超长 → 全部行(逐行截断)+ 字符提示。
  const preview = useMemo(() => {
    if (!isLong) return null;
    if (lines.length > USER_HEAD_LINES + USER_TAIL_LINES) {
      return {
        head: lines.slice(0, USER_HEAD_LINES),
        tail: lines.slice(lines.length - USER_TAIL_LINES),
        note: t("composer.linesFolded", { count: lines.length - USER_HEAD_LINES - USER_TAIL_LINES }),
      };
    }
    return { head: lines, tail: [], note: t("composer.longLineTruncated", { count: text.length }) };
  }, [isLong, lines, text.length, t]);

  const expand = () => setCollapsed(false);

  return (
    <div
      className={`bubble-user${isLong ? " bubble-user-long" : ""}${isLong ? (collapsed ? " is-collapsed" : " is-expanded") : ""}`}
    >
      {isLong && (
        <div className="bubble-user-meta" data-testid="user-msg-meta">
          <span className="bubble-user-count">{t("composer.lineCharCount", { lines: lines.length, chars: text.length })}</span>
          <button
            className="bubble-user-toggle"
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            data-tooltip-id="md-tip"
            data-tooltip-content={collapsed ? t("collapsibleText.expandFull") : t("common.collapse")}
            data-testid="user-msg-toggle"
          >
            {collapsed ? <><ChevronDown size={12} /> {t("common.expand")}</> : <><ChevronUp size={12} /> {t("common.collapse")}</>}
          </button>
        </div>
      )}

      {isLong && collapsed && preview ? (
        <div
          className="bubble-user-preview"
          data-testid="user-msg-preview"
          onClick={expand}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); expand(); } }}
        >
          <pre className="bubble-user-preview-pre">
            {preview.head.map((l, i) => <div key={i} className="bubble-user-preview-line">{l || " "}</div>)}
          </pre>
          <button
            className="bubble-user-preview-divider"
            type="button"
            onClick={(e) => { e.stopPropagation(); expand(); }}
          >
            {t("composer.collapsePreviewDivider", { note: preview.note })}
          </button>
          {preview.tail.length > 0 && (
            <pre className="bubble-user-preview-pre">
              {preview.tail.map((l, i) => <div key={i} className="bubble-user-preview-line">{l || " "}</div>)}
            </pre>
          )}
        </div>
      ) : (
        <div className={`bubble-user-body bubble-user-${renderKind}`}>
          {renderKind === "markdown" ? (
            <AgentMarkdown text={text} onOpenFilePreview={onOpenFilePreview} />
          ) : renderKind === "mono" ? (
            <pre className="bubble-user-mono">
              <PathLinkified text={text} onOpen={onOpenFilePreview} />
            </pre>
          ) : (
            <PathLinkified text={text} onOpen={onOpenFilePreview} />
          )}
        </div>
      )}
    </div>
  );
}

// 代码/日志特征启发式:非空行中缩进行 / 日志时间戳行 / 代码关键字行 / 超长无标点行 占比 ≥ 40% 判为技术文本。
// 用于决定是否用等宽字体呈现;判定错也无害(仅字体差异),偏保守(行 < 4 直接 false)。
function looksLikeCodeOrLog(lines: string[]): boolean {
  if (lines.length < 4) return false;
  let tech = 0;
  let counted = 0;
  for (const l of lines) {
    if (/^\s*$/.test(l)) continue;
    counted++;
    if (/^\s{2,}\S/.test(l)) tech++;                                                        // 缩进行(代码)
    else if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}[T ]\d{1,2}:\d{2}/.test(l)) tech++;                // 日志时间戳
    else if (/[{}();]/.test(l) && /\b(if|for|def|func|fn|const|let|var|return|import|from|class|export|async|await|case|switch|echo|Error|WARN)\b/.test(l)) tech++;
    else if (l.length > 120 && !/[。！？.!?,;:]/.test(l)) tech++;                            // 超长无标点(日志行)
  }
  return counted > 0 && tech / counted >= 0.4;
}

// ThoughtBlock:思考块默认折叠(含流式中),summary 显示转圈 spinner;用户展开后记住偏好,
// 后续新思考块也默认展开;底部「收起」按钮方便长文本尾部直接收回(不用滚回顶部)。
function ThoughtBlock({ item, sessionId, onOpenFilePreview }: { item: Extract<ChatItem, { type: "thought" }>; sessionId: string; onOpenFilePreview: (path: string, line?: number) => void }) {
  const { t } = useTranslation();
  // 展开状态:per-item(按 item.id),不跨 thought 共享。
  // 旧实现按 sessionId 共享 localStorage 键 → 同 session 多个 thought 互相干扰,
  // 且 id 变化重挂载时新实例从共享键读 open,覆盖用户当前点击 → 「点不开」。
  // 现在:每个 thought 独立 useState(默认折叠),用户点击只影响该 thought。
  // session 级「展开过则后续默认展开」偏好单独存 ref(见 ThoughtPrefsProvider)。
  const [open, setOpen] = useState(false);
  const everOpenedRef = useRef(open);
  if (open) everOpenedRef.current = true;
  const toggle = () => setOpen((prev) => !prev);
  const textRef = useRef<HTMLDivElement>(null);
  // streaming 时展开内容自动滚到底(限高滚动容器内),让用户能看到最新思考。
  // 非流式或折叠时不动作;依赖 text/streaming/open,文本增长或展开瞬间都会触发。
  useEffect(() => {
    if (!open || !item.streaming) return;
    const el = textRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, item.streaming, item.text]);
  return (
    <div className="thought-block">
      <button className={`thought-summary ${open ? "open" : ""}`} onClick={toggle} type="button">
        {item.streaming ? <span className="thought-spinner" /> : <Brain size={13} />}
        <span className="thought-summary-label">{item.streaming ? t("chat.thinkingLive") : t("chat.thought")}</span>
        <ChevronRight size={13} className="thought-chevron" />
      </button>
      <div className={`collapse-body ${open ? "open" : ""}`}>
        <div className="collapse-body-inner">
          {everOpenedRef.current && (
            <>
              <div className="thought-text" ref={textRef}>
                <PathLinkified text={item.text} onOpen={onOpenFilePreview} />
              </div>
              <button className="thought-collapse-btn" onClick={toggle}>{t("chat.collapseThought")}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageActions({ text, className = "", testId = "copy-msg" }: { text: string; className?: string; testId?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* noop */ }
  };
  return (
    <div className={`msg-actions${className ? ` ${className}` : ""}`}>
      <button
        className="msg-action-btn"
        type="button"
        onClick={copy}
        data-testid={testId}
        data-tooltip-id="md-tip"
        data-tooltip-content={copied ? t("chat.messageCopiedTip") : t("chat.copyMessageTip")}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? t("common.copied") : t("common.copy")}
      </button>
    </div>
  );
}

// 连续工具调用折叠组:2 个以上连续 tool 包进一个 Collapsible,summary 显示数量 + 执行状态。
// 展开后内部各 tool 仍是独立 ToolCard(各自可再展开看 I/O)。
function ToolGroup({ tools, onOpenFilePreview }: { tools: Extract<ChatItem, { type: "tool" }>[]; onOpenFilePreview: (path: string, line?: number) => void }) {
  const { t } = useTranslation();
  const anyRunning = tools.some(tc => tc.status === "pending" || tc.status === "in_progress");
  return (
    <Collapsible
      className="tool-group"
      open={false}
      summaryClassName="tool-group-summary"
      summary={<>
        {anyRunning ? <span className="thought-spinner" /> : <Wrench size={13} />}
        <span className="tool-group-count">{t("chat.groupToolsCount", { count: tools.length })}</span>
        <span className={`tool-group-status ${anyRunning ? "tg-running" : "tg-done"}`}>
          {anyRunning ? t("chat.groupRunning") : t("chat.groupDone")}
        </span>
      </>}
    >
      {tools.map(tc => <ToolCard key={tc.id} item={tc} onOpenFilePreview={onOpenFilePreview} />)}
    </Collapsible>
  );
}

function ToolCard({ item, onOpenFilePreview }: { item: Extract<ChatItem, { type: "tool" }>; onOpenFilePreview: (path: string, line?: number) => void }) {
  // 按 ACP ToolKind 分派到专用卡片(execute→bash、edit→文件编辑、read→文件读取、search→检索),
  // 复用 J1 的卡片框架(Collapsible 头 + 折叠 toggle)+ CollapsibleText 折叠体。未覆盖的 kind 走通用卡。
  // 分派层不持有 hook,避免子分支 hook 顺序不一致(React Rules of Hooks)。
  switch (item.kind) {
    case "execute": return <BashToolCard item={item} onOpenFilePreview={onOpenFilePreview} />;
    case "edit": return <EditToolCard item={item} onOpenFilePreview={onOpenFilePreview} />;
    case "read": return <ReadToolCard item={item} onOpenFilePreview={onOpenFilePreview} />;
    case "search": return <SearchToolCard item={item} onOpenFilePreview={onOpenFilePreview} />;
    default: return <GenericToolCard item={item} onOpenFilePreview={onOpenFilePreview} />;
  }
}

// edit / 文件编辑卡片(edit/apply_patch/write_file 等 kind=edit 工具):
// 头(FilePen + 标题 + 状态)+ 体(目标文件 + 改动片段)。改动以 +/- diff 呈现(增删行高亮),
// 长内容复用 CollapsibleText 折叠(短/展开/折叠预览三态均按行染色)。
//   - old_string/new_string 都有 → 拼 -/+ diff;
//   - 只有 content/newText(write_file 新写)→ 纯内容、标「写入内容」;
//   - patch(apply_patch)→ 原样按 unified diff 染色;
//   - 都没有 → 回退 extractToolText。
// 失败时额外展示 output(通常含错误信息)。
function EditToolCard({ item, onOpenFilePreview }: { item: Extract<ChatItem, { type: "tool" }>; onOpenFilePreview: (path: string, line?: number) => void }) {
  const { t } = useTranslation();
  const stInfo = TOOL_STATUS_MAP[item.status] || { key: null, cls: "tc-unknown" };
  const stLabel = stInfo.key ? t(stInfo.key) : (item.status || t("chat.toolStatus.unknown"));
  const running = item.status === "pending" || item.status === "in_progress";
  const path = extractFilePath(item.rawInput);
  const parts = extractEditParts(item.rawInput);
  const diffText = parts.diff; // 非 undefined 时按 diff 染色
  const plainText = parts.plain; // 非 diff 的纯内容
  const outputR = item.status === "failed" && item.rawOutput != null ? extractToolText(item.rawOutput) : null;

  const renderTarget = (label: string, p: string) => (
    <div className="file-target" data-testid="edit-target">
      <span className="file-target-label">{label}</span>
      <span className="file-target-path" title={p}>{p}</span>
    </div>
  );

  return (
    <Collapsible
      className="tool-card file-tool-card edit-tool-card"
      open={false}
      summaryClassName="tool-summary file-tool-summary"
      summary={<>
        {running ? <span className="thought-spinner" /> : <FilePen size={13} />}
        <span className="tool-title">{item.title || t("chat.toolTitle.edit")}</span>
        {path && <span className="tool-badge" title={path}>{shortPath(path)}</span>}
        <span className={`tool-status ${stInfo.cls}`}>{stLabel}</span>
      </>}
    >
      {path && renderTarget(t("chat.targetFile"), path)}
      {diffText && (
        <div className="file-section">
          <div className="file-section-head">
            <span className="file-section-label">{parts.kind === "patch" ? t("chat.changesPatch") : t("chat.changes")}</span>
            <span className="file-section-meta">
              <span className="diff-stat diff-stat-add">+{parts.added}</span>
              <span className="diff-stat diff-stat-del">−{parts.removed}</span>
            </span>
          </div>
          <CollapsibleText
            text={diffText}
            className="diff-ctext"
            preClassName="diff-pre"
            previewClassName="diff-preview"
            lineUnit={t("collapsibleText.lineUnit")}
            testId="edit-diff"
            lineClassName={diffLineCls}
            onPath={onOpenFilePreview}
          />
        </div>
      )}
      {!diffText && plainText && (
        <div className="file-section">
          <div className="file-section-head"><span className="file-section-label">{t("chat.writeContent")}</span></div>
          <CollapsibleText
            text={plainText}
            preClassName="file-content-pre"
            lineUnit={t("collapsibleText.lineUnit")}
            testId="edit-content"
            onPath={onOpenFilePreview}
          />
        </div>
      )}
      {outputR && outputR.text && (
        <div className="file-section">
          <div className="file-section-head"><span className="file-section-label">{t("chat.output")}</span></div>
          <CollapsibleText text={outputR.text} preClassName="file-content-pre" lineUnit={t("collapsibleText.lineUnit")} testId="edit-output" copyable onPath={onOpenFilePreview} />
        </div>
      )}
    </Collapsible>
  );
}

// read / 文件读取卡片(read_file 等 kind=read 工具):
// 头(FileText + 标题 + 状态 + 路径徽章)+ 体(目标文件 + 内容片段,长内容折叠)。
// 内容来自 rawOutput(文件正文);输入仅给路径。
function ReadToolCard({ item, onOpenFilePreview }: { item: Extract<ChatItem, { type: "tool" }>; onOpenFilePreview: (path: string, line?: number) => void }) {
  const { t } = useTranslation();
  const stInfo = TOOL_STATUS_MAP[item.status] || { key: null, cls: "tc-unknown" };
  const stLabel = stInfo.key ? t(stInfo.key) : (item.status || t("chat.toolStatus.unknown"));
  const running = item.status === "pending" || item.status === "in_progress";
  const path = extractFilePath(item.rawInput) || extractFilePath(item.rawOutput);
  const outputR = item.rawOutput != null ? extractToolText(item.rawOutput) : null;

  return (
    <Collapsible
      className="tool-card file-tool-card read-tool-card"
      open={false}
      summaryClassName="tool-summary file-tool-summary"
      summary={<>
        {running ? <span className="thought-spinner" /> : <FileText size={13} />}
        <span className="tool-title">{item.title || t("chat.toolTitle.read")}</span>
        {path && <span className="tool-badge" title={path}>{shortPath(path)}</span>}
        <span className={`tool-status ${stInfo.cls}`}>{stLabel}</span>
      </>}
    >
      {path && (
        <div className="file-target" data-testid="read-target">
          <span className="file-target-label">{t("chat.targetFile")}</span>
          <span className="file-target-path" title={path}>{path}</span>
        </div>
      )}
      {outputR && outputR.text ? (
        <div className="file-section">
          <div className="file-section-head">
            <span className="file-section-label">{t("chat.content")}</span>
            {outputR.truncated && <span className="file-section-meta">{t("chat.truncated")}</span>}
          </div>
          <CollapsibleText
            text={outputR.text}
            preClassName="file-content-pre"
            previewClassName="file-content-preview"
            lineUnit={t("collapsibleText.lineUnit")}
            testId="read-content"
            onPath={onOpenFilePreview}
          />
        </div>
      ) : (
        <div className="file-empty">{t("chat.noContent")}</div>
      )}
    </Collapsible>
  );
}

// search / 检索卡片(grep / glob 等 kind=search 工具):
// 头(Search + 标题 + 状态 + pattern 徽章)+ 体(检索范围 + 结果列表)。
// 结果来自 rawOutput(grep 多为「路径:行:内容」、glob 多为路径列表),长列表复用 CollapsibleText 折叠。
function SearchToolCard({ item, onOpenFilePreview }: { item: Extract<ChatItem, { type: "tool" }>; onOpenFilePreview: (path: string, line?: number) => void }) {
  const { t } = useTranslation();
  const stInfo = TOOL_STATUS_MAP[item.status] || { key: null, cls: "tc-unknown" };
  const stLabel = stInfo.key ? t(stInfo.key) : (item.status || t("chat.toolStatus.unknown"));
  const running = item.status === "pending" || item.status === "in_progress";
  const pattern = extractSearchPattern(item.rawInput);
  const scope = extractFilePath(item.rawInput);
  const outputR = item.rawOutput != null ? extractToolText(item.rawOutput) : null;
  const matchCount = outputR?.text ? countNonEmpty(outputR.text) : 0;

  return (
    <Collapsible
      className="tool-card file-tool-card search-tool-card"
      open={false}
      summaryClassName="tool-summary file-tool-summary"
      summary={<>
        {running ? <span className="thought-spinner" /> : <Search size={13} />}
        <span className="tool-title">{item.title || t("chat.toolTitle.search")}</span>
        {pattern && <span className="tool-badge tool-badge-pattern" title={pattern}>{pattern}</span>}
        {!running && matchCount > 0 && <span className="tool-badge tool-badge-count">{t("chat.resultsCount", { count: matchCount })}</span>}
        <span className={`tool-status ${stInfo.cls}`}>{stLabel}</span>
      </>}
    >
      {pattern && (
        <div className="file-target" data-testid="search-pattern-row">
          <span className="file-target-label">{t("chat.pattern")}</span>
          <span className="file-target-path search-pattern-text" title={pattern}>{pattern}</span>
        </div>
      )}
      {scope && (
        <div className="file-target">
          <span className="file-target-label">{t("chat.scope")}</span>
          <span className="file-target-path" title={scope}>{scope}</span>
        </div>
      )}
      {outputR && outputR.text ? (
        <div className="file-section">
          <div className="file-section-head">
            <span className="file-section-label">{t("chat.results")}</span>
            <span className="file-section-meta">{t("chat.resultsCount", { count: matchCount })}</span>
          </div>
          <CollapsibleText
            text={outputR.text}
            preClassName="search-results-pre"
            previewClassName="search-results-preview"
            lineUnit={t("collapsibleText.lineUnit")}
            testId="search-results"
            onPath={onOpenFilePreview}
          />
        </div>
      ) : (
        <div className="file-empty">{running ? t("chat.searching") : t("chat.noMatch")}</div>
      )}
    </Collapsible>
  );
}

function GenericToolCard({ item, onOpenFilePreview }: { item: Extract<ChatItem, { type: "tool" }>; onOpenFilePreview: (path: string, line?: number) => void }) {
  const { t } = useTranslation();
  const stInfo = TOOL_STATUS_MAP[item.status] || { key: null, cls: "tc-unknown" };
  const stLabel = stInfo.key ? t(stInfo.key) : (item.status || t("chat.toolStatus.unknown"));
  const [copiedIn, setCopiedIn] = useState(false);
  const [copiedOut, setCopiedOut] = useState(false);
  const inputR = item.rawInput != null ? extractToolText(item.rawInput) : null;
  const outputR = item.rawOutput != null ? extractToolText(item.rawOutput) : null;
  const copyIn = async () => { try { await navigator.clipboard.writeText(inputR?.text || ""); setCopiedIn(true); setTimeout(() => setCopiedIn(false), 1200); } catch { /* noop */ } };
  const copyOut = async () => { try { await navigator.clipboard.writeText(outputR?.text || ""); setCopiedOut(true); setTimeout(() => setCopiedOut(false), 1200); } catch { /* noop */ } };
  return (
    <Collapsible
      className="tool-card"
      open={false}
      summaryClassName="tool-summary"
      summary={<>
        <Wrench size={13} />
        <span className="tool-title">{item.title || t("chat.toolTitle.generic")}</span>
        {item.kind && <span className="tool-kind">{item.kind}</span>}
        <span className={`tool-status ${stInfo.cls}`}>{stLabel}</span>
      </>}
    >
      {inputR && (
        <div className="tool-section">
          <div className="tool-section-head">
            <span className="tool-section-label">{t("chat.input")}</span>
            <button className="msg-action-btn" onClick={copyIn}>{copiedIn ? <Check size={11} /> : <Copy size={11} />}</button>
          </div>
          <pre className={inputR.fallback ? "tool-pre" : "tool-pre tool-term"}>
            <PathLinkified text={inputR.text} onOpen={onOpenFilePreview} />
          </pre>
        </div>
      )}
      {outputR && (
        <div className="tool-section">
          <div className="tool-section-head">
            <span className="tool-section-label">
              {t("chat.output")}{outputR.exit != null ? t("chat.exitSuffix", { code: outputR.exit }) : ""}{outputR.truncated ? t("chat.truncatedSuffix") : ""}
            </span>
            <button className="msg-action-btn" onClick={copyOut}>{copiedOut ? <Check size={11} /> : <Copy size={11} />}</button>
          </div>
          <pre className={outputR.fallback ? "tool-pre" : "tool-pre tool-term"}>
            <PathLinkified text={outputR.text} onOpen={onOpenFilePreview} />
          </pre>
        </div>
      )}
    </Collapsible>
  );
}

// bash / 命令执行卡片:头(终端图标 + 名 + 状态/exit + 折叠 toggle)+ 体(命令行 + 输出区)。
// 命令行/输出等宽、保留换行、横向滚动不撑破布局;长输出超阈值默认折叠(首尾+省略),可展开。
// 输出区复用可折叠组件 CollapsibleText(后续 grep/glob/edit 等可共用)。
function BashToolCard({ item, onOpenFilePreview }: { item: Extract<ChatItem, { type: "tool" }>; onOpenFilePreview: (path: string, line?: number) => void }) {
  const { t } = useTranslation();
  const stInfo = TOOL_STATUS_MAP[item.status] || { key: null, cls: "tc-unknown" };
  const stLabel = stInfo.key ? t(stInfo.key) : (item.status || t("chat.toolStatus.unknown"));
  const running = item.status === "pending" || item.status === "in_progress";
  const command = extractBashCommand(item.rawInput);
  const outputR = item.rawOutput != null ? extractToolText(item.rawOutput) : null;
  const [copiedCmd, setCopiedCmd] = useState(false);
  const copyCmd = async () => {
    try { await navigator.clipboard.writeText(command || ""); setCopiedCmd(true); setTimeout(() => setCopiedCmd(false), 1200); } catch { /* noop */ }
  };
  return (
    <Collapsible
      className="tool-card bash-tool-card"
      open={false}
      summaryClassName="tool-summary bash-tool-summary"
      summary={<>
        {running ? <span className="thought-spinner" /> : <Terminal size={13} />}
        <span className="tool-title">{item.title || t("chat.toolTitle.bash")}</span>
        {outputR?.exit != null && <span className={`bash-exit ${exitCls(outputR.exit)}`}>exit {outputR.exit}</span>}
        <span className={`tool-status ${stInfo.cls}`}>{stLabel}</span>
      </>}
    >
      {command && (
        <div className="bash-cmd">
          <div className="bash-cmd-head">
            <span className="bash-cmd-prompt">$</span>
            <span className="bash-cmd-label">{t("chat.command")}</span>
            <button
              className="msg-action-btn"
              type="button"
              onClick={copyCmd}
              data-tooltip-id="md-tip"
              data-tooltip-content={copiedCmd ? t("common.copied") : t("chat.copyCommandTip")}
              data-testid="bash-copy-cmd"
            >
              {copiedCmd ? <Check size={11} /> : <Copy size={11} />}
            </button>
          </div>
          <pre className="bash-cmd-pre" data-testid="bash-cmd-pre">{command}</pre>
        </div>
      )}
      {outputR && outputR.text && (
        <div className="bash-out">
          <CollapsibleText
            text={outputR.text}
            className="bash-out-ctext"
            preClassName="bash-out-pre"
            previewClassName="bash-out-preview"
            lineUnit={t("collapsibleText.lineUnit")}
            testId="bash-output"
            onPath={onOpenFilePreview}
          />
          {outputR.truncated && <div className="bash-out-note">{t("chat.outputTruncated")}</div>}
        </div>
      )}
    </Collapsible>
  );
}

// exit 状态色:0=成功(绿);非 0=失败(红);仅用于头部小徽章。
function exitCls(exit: number): string {
  return exit === 0 ? "bash-exit-ok" : "bash-exit-fail";
}

// 从 bash 工具的 rawInput 抽出命令文本(等宽呈现,绝不把 {…} JSON 抛给用户,§4.4)。
// opencode bash 输入形如 {command: "..."};命令可能在 command/cmd/line 等键。找不到回退空。
function extractBashCommand(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!isRecord(raw)) return "";
  for (const k of ["command", "cmd", "line"]) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  // 兜兜:有 command 数组(部分 harness 把命令拆成 argv)→ 用空格拼回单行。
  const argv = raw.argv;
  if (Array.isArray(argv) && argv.length > 0) {
    return argv.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
  }
  return "";
}

// 从工具 rawInput/rawOutput 抽出文件路径(兼容各 harness 的字段命名,§4.4 不裸露 JSON)。
// 仅处理对象(record);字符串可能是文件正文(read_file 的 rawOutput),对它跑正则会误匹配,
// 故字符串一律返回空(路径徽章缺失不影响 diff/内容展示)。
// 优先级:path / file / filepath / fileName / filePath / dir。第一个非空字符串胜出。
function extractFilePath(raw: unknown): string {
  if (!isRecord(raw)) return "";
  for (const k of ["path", "file", "filepath", "filePath", "fileName", "filename", "dir", "directory", "cwd"]) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

// 从检索工具 rawInput 抽出检索模式(grep 的 pattern/regex、glob 的 pattern/glob/include)。
function extractSearchPattern(raw: unknown): string {
  if (!isRecord(raw)) return "";
  for (const k of ["pattern", "regex", "query", "glob", "include", "search", "q"]) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

// 从编辑工具 rawInput 抽出改动内容,归一成「带 +/- 染色的 diff 文本」或「纯内容」。
// 覆盖:edit(old_string/new_string)、write_file(content/newText/text)、apply_patch(patch)。
// 返回 { diff?, plain?, kind, added, removed }:diff 非空则按行染色;否则 plain 兜底。
function extractEditParts(raw: unknown): { diff?: string; plain?: string; kind: "diff" | "patch" | "content" | "none"; added: number; removed: number } {
  const empty = { kind: "none" as const, added: 0, removed: 0 };
  if (!isRecord(raw)) return empty;
  const oldStr = pickStr(raw, ["old_string", "oldString", "old_str", "old_text", "oldText", "search", "find"]);
  const newStr = pickStr(raw, ["new_string", "newString", "new_str", "new_text", "newText", "replace", "replacement"]);
  const patch = pickStr(raw, ["patch"]);
  const content = pickStr(raw, ["content", "newText", "text", "file_text", "fileText"]);
  // apply_patch:unified diff 原样染色(它自带 +/-/@@ 格式)。
  if (patch) {
    const { added, removed } = countDiffLines(patch);
    return { diff: patch, kind: "patch", added, removed };
  }
  // edit(old→new):自构 -/+ diff(删除行在前、新增行在后,清晰呈现增删)。
  if (oldStr && newStr) {
    const diff = buildPlusMinusDiff(oldStr, newStr);
    const { added, removed } = countDiffLines(diff);
    return { diff, kind: "diff", added, removed };
  }
  // write_file / 新建文件:只有内容 → 纯内容展示,不强加全绿底(大文件视觉过重)。
  if (content) return { plain: content, kind: "content", added: 0, removed: 0 };
  return empty;
}

// 从 raw 中按候选键取首个非空字符串值。
function pickStr(raw: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

// 由 old/new 两段文本构造简单 -/+ diff:旧文本行前缀「-」、新文本行前缀「+」,各自成段。
// 不是最小化 diff(不做行对齐),但诚实地呈现「删了什么 / 加了什么」,且与 unified patch 的
// +/- 前缀约定一致,可复用同一套染色规则。
function buildPlusMinusDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const parts: string[] = [];
  for (const l of oldLines) parts.push(`-${l}`);
  for (const l of newLines) parts.push(`+${l}`);
  return parts.join("\n");
}

// 统计 diff 增删行数 + 行染色规则已抽到 lib/diff.ts(供 GitPanel diff 阅读器复用)。

// 把绝对路径截短成「…/<basename>」便于在徽章里展示(避免长路径撑爆头部)。
function shortPath(p: string): string {
  if (p.length <= 40) return p;
  const slash = p.lastIndexOf("/");
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  const dir = slash >= 0 ? p.slice(0, slash) : "";
  if (!dir) return base;
  return `…/${base}`;
}

// 统计文本中非空行数(用于 grep/glob 结果项数)。
function countNonEmpty(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) if (line.trim()) n++;
  return n;
}

function PermissionCard({ prompt, onRespond }: { prompt: PermissionPrompt; onRespond: (id: string) => void }) {
  const { t } = useTranslation();
  const actionLabel =
    prompt.actionType === "read"
      ? t("chat.permActionRead")
      : prompt.actionType === "write"
        ? t("chat.permActionWrite")
        : prompt.actionType === "exec"
          ? t("chat.permActionExec")
          : prompt.actionType === "other"
            ? t("chat.permActionOther")
            : "";
  return (
    <div className="permission-card" data-testid="permission-card">
      <div className="permission-head">
        <ShieldAlert size={18} />
        <div>
          <div className="permission-title">{prompt.title || t("chat.permissionTitleFallback")}</div>
          <div className="permission-sub">
            {actionLabel && <span className="permission-action" data-testid="perm-action">{actionLabel}</span>}
            {prompt.toolName && <span className="permission-tool">{prompt.toolName}</span>}
          </div>
        </div>
      </div>
      {(prompt.command || (prompt.locations && prompt.locations.length > 0)) && (
        <div className="permission-context" data-testid="perm-context">
          {prompt.command && (
            <div className="permission-row">
              <span className="permission-label">{t("chat.permCommandLabel")}</span>
              <code className="permission-command" data-testid="perm-command">{prompt.command}</code>
            </div>
          )}
          {prompt.locations && prompt.locations.length > 0 && (
            <div className="permission-row">
              <span className="permission-label">{t("chat.permPathsLabel")}</span>
              <span className="permission-paths" data-testid="perm-paths">{prompt.locations.join("\n")}</span>
            </div>
          )}
        </div>
      )}
      <div className="permission-actions">
        <button className="perm-btn perm-allow" data-testid="perm-once" onClick={() => onRespond("once")}>{t("chat.permAllowOnce")}</button>
        <button className="perm-btn perm-allow" data-testid="perm-session" onClick={() => onRespond("session")}>{t("chat.permAllowSession")}</button>
        <button className="perm-btn perm-allow" data-testid="perm-project" onClick={() => onRespond("project")}>{t("chat.permAllowProject")}</button>
        <button className="perm-btn perm-allow" data-testid="perm-global" onClick={() => onRespond("global")}>{t("chat.permAllowGlobal")}</button>
        <button className="perm-btn perm-deny" data-testid="perm-deny" onClick={() => onRespond("deny")}>{t("chat.permDeny")}</button>
      </div>
    </div>
  );
}

// 执行计划时间线(ACP plan_update):agent 发整表替换的 plan entries,前端渲染为可折叠卡片。
// 每项一行(状态图标 + 内容),头部带进度条 + 已完成/总数。进行中高亮、完成打勾、新增/变化即时反映。
// plan 是 session 级实时状态(非消息项),回合开始清空,由 agent 的 plan_update 整表刷新。
const PLAN_STATUS_ICON = {
  completed: { cls: "pe-done", key: "chat.planStatus.completed" },
  in_progress: { cls: "pe-running", key: "chat.planStatus.in_progress" },
  pending: { cls: "pe-pending", key: "chat.planStatus.pending" },
} as const;

function PlanTimeline({ entries, prompting, isOpen, onToggle }: { entries: PlanEntry[]; prompting: boolean; isOpen: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const total = entries.length;
  const done = entries.filter((e) => e.status === "completed").length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const anyRunning = prompting && entries.some((e) => e.status === "in_progress" || e.status === "pending");
  // 展开/折叠偏好由父级 ChatView 持有并按 session 持久化(localStorage),默认展开(Task #21298)。
  const allDone = total > 0 && done === total;
  return (
    <div className="plan-timeline" data-testid="plan-timeline">
      <button className="plan-summary" onClick={onToggle} type="button" aria-expanded={isOpen}>
        {anyRunning ? <span className="thought-spinner" /> : allDone ? <Check size={13} /> : <ListChecks size={13} />}
        <span className="plan-summary-label">{t("chat.planTitle")}</span>
        <span className="plan-summary-count">{done}/{total}</span>
        <span className="plan-progress" aria-label={t("chat.planProgressAria", { pct })}>
          <span className="plan-progress-fill" style={{ width: `${pct}%` }} />
        </span>
        <span className="plan-summary-pct">{pct}%</span>
        <ChevronRight size={13} className={`plan-chevron ${isOpen ? "open" : ""}`} />
      </button>
      <div className={`collapse-body ${isOpen ? "open" : ""}`}>
        <div className="collapse-body-inner">
          {isOpen && (
            <ol className="plan-entries" data-testid="plan-entries">
              {entries.map((e, i) => {
                const st = PLAN_STATUS_ICON[e.status as keyof typeof PLAN_STATUS_ICON] || PLAN_STATUS_ICON.pending;
                const running = e.status === "in_progress";
                return (
                  <li key={i} className={`plan-entry ${st.cls}`} data-testid="plan-entry">
                    <span className="plan-entry-icon">
                      {e.status === "completed" ? <Check size={12} /> : running ? <span className="thought-spinner" /> : <span className="plan-entry-dot" />}
                    </span>
                    <span className="plan-entry-content">{e.content}</span>
                    {e.priority === "high" && <span className="plan-entry-prio pe-prio-high">{t("chat.planPriorityHigh")}</span>}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

// PreRenderer:ReactMarkdown 的 <pre> 渲染器。代码块 → CodeBox;
// ```mermaid 围栏 → MermaidRenderer(Task #21289)。
// streaming=true 时 MermaidRenderer 内部会跳过渲染、先显示源码,避免不完整语法反复渲染失败。
function PreRenderer(props: ComponentPropsWithoutRef<"pre"> & { streaming?: boolean }) {
  const codeEl = extractCodeChild(props.children);
  const language = codeEl?.language || "code";
  const raw = codeEl?.text || "";
  if (isMermaidLanguage(language)) {
    return <MermaidRenderer code={raw} streaming={props.streaming} />;
  }
  return <CodeBox language={language} raw={raw} />;
}

// 同时识别 mermaid 官方语言名与常见变体(mmd / flowchart 等),宽容匹配。
function isMermaidLanguage(lang: string): boolean {
  const l = lang.trim().toLowerCase();
  return l === "mermaid" || l === "mmd";
}

// 对话外链拦截(Task #15668):markdown 里的 http/https 链接点击 → 调后端 OpenURL
// 用系统默认浏览器打开(Wails3 webview 不承担浏览器导航)。mailto/tel/相对路径/锚点放行默认行为。
function AnchorRenderer(props: ComponentPropsWithoutRef<"a">) {
  const { href, children, ...rest } = props;
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (href && /^https?:\/\//i.test(href)) {
      e.preventDefault();
      void ChatService.OpenURL(href);
    }
  };
  return <a href={href} onClick={onClick} target="_blank" rel="noopener noreferrer" {...rest}>{children}</a>;
}

// Agent / user-markdown 渲染器(Task #15084):在 ReactMarkdown 的 p / li / td 文本节点里
// 把文件路径识别成可点击 .path-link。code / pre / a 等保持原样(不破坏代码语义)。
// streaming(Task #21289):仅 agent 消息流式期间为 true,透传到 PreRenderer → MermaidRenderer,
// 让 mermaid 代码块在消息写完后再渲染。
function AgentMarkdown({ text, onOpenFilePreview, streaming = false }: { text: string; onOpenFilePreview: (path: string, line?: number) => void; streaming?: boolean }) {
  const components = useMemo(
    () => ({
      code: CodeRenderer,
      pre: (props: ComponentPropsWithoutRef<"pre">) => <PreRenderer {...props} streaming={streaming} />,
      a: AnchorRenderer,
      p: makeTextLinkifyRenderer("p", onOpenFilePreview),
      li: makeTextLinkifyRenderer("li", onOpenFilePreview),
      td: makeTextLinkifyRenderer("td", onOpenFilePreview),
    }),
    [onOpenFilePreview, streaming]
  );
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
}

// ReactMarkdown 文本节点(p / li / td)路径链接化工厂(Task #15084)。
// 这些节点的 children 通常是字符串/数组,把其中纯字符串片段用 PathLinkified 包起来。
// 行内 code / 链接等子元素保持原样(不识别其中的路径,避免破坏代码语义)。
function makeTextLinkifyRenderer(
  tag: "p" | "li" | "td",
  onOpenFilePreview: (path: string, line?: number) => void
) {
  const Comp = (props: ComponentPropsWithoutRef<typeof tag>) => {
    const { children, ...rest } = props;
    return React.createElement(tag, rest as Record<string, unknown>, linkifyReactChildren(children, onOpenFilePreview));
  };
  return Comp;
}

// 把 React children 中的纯字符串节点用 PathLinkified 包起来;其他节点(元素/数组)递归处理或保留。
function linkifyReactChildren(children: React.ReactNode, onOpenFilePreview: (path: string, line?: number) => void): React.ReactNode {
  if (children == null || children === false) return children;
  if (typeof children === "string") {
    return <PathLinkified text={children} onOpen={onOpenFilePreview} />;
  }
  if (Array.isArray(children)) {
    let any = false;
    const out = children.map((c, i) => {
      if (typeof c === "string") { any = true; return <PathLinkified key={i} text={c} onOpen={onOpenFilePreview} />; }
      return c;
    });
    return any ? out : children;
  }
  return children;
}

function CodeRenderer(props: ComponentPropsWithoutRef<"code">) {
  const { className, children, ...rest } = props;
  const isBlock = Boolean(className?.includes("language-")) || String(children ?? "").includes("\n");
  if (isBlock) return <code className={className} data-block {...rest}>{children}</code>;
  return <code className="code-inline" {...rest}>{children}</code>;
}

function CodeBox({ language, raw }: { language: string; raw: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(raw); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* noop */ }
  };
  return (
    <div className="code-box">
      <div className="code-box-head">
        <span className="code-lang">{language}</span>
        <button className="msg-action-btn" onClick={copy} data-testid="copy-code">
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? t("common.copied") : t("common.copy")}
        </button>
      </div>
      <pre className="code-box-pre"><code>{raw}</code></pre>
    </div>
  );
}

function extractCodeChild(children: ComponentPropsWithoutRef<"pre">["children"]): { language: string; text: string } | null {
  const node = Array.isArray(children) ? children[0] : children;
  if (!node || typeof node !== "object" || !("props" in node)) return null;
  const props = (node as { props: { className?: string; children?: unknown } }).props;
  const cls = props.className || "";
  const lang = /language-(\w[\w+-]*)/.exec(cls)?.[1] || "";
  const text = typeof props.children === "string" ? props.children : String(props.children ?? "");
  return { language: lang || "code", text: text.replace(/\n$/, "") };
}

// 回合分隔:发丝线 + 时间 + 本轮持续时间,清晰划分每一轮对话(用户消息前的锚点)。
function TurnDivider({ ts, durationMs }: { ts?: number; durationMs?: number }) {
  const dur = formatDuration(durationMs);
  return (
    <div className="turn-divider">
      <span className="turn-divider-line" />
      {ts && (
        <span className="turn-divider-time">
          {formatTime(ts)}{dur && <span className="turn-divider-dur"> · {dur}</span>}
        </span>
      )}
      <span className="turn-divider-line" />
    </div>
  );
}

// 时长格式化:<60s → "Ns";<60m → "Mm SSs"(SS 零填充);≥60m → "Hh MMm"。不足 1s 返回空。
function formatDuration(ms?: number): string {
  if (!ms || ms < 1000) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${pad2(rs)}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${pad2(rm)}m` : `${h}h`;
}

// 时间格式化:今天显示 HH:mm;跨天显示 MM-DD HH:mm;无 ts 返回空。
function formatTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
}
function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }
// 把结构化数据转成人可读文本,绝不把 {…} / JSON 原样给用户(AGENTS.md §4.4)。
// string 原样;record 渲染成「键: 值」逐行;数组逐项;嵌套对象/数组用紧凑单行兜底。
function formatHuman(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(formatHuman).filter(Boolean).join("\n");
  if (isRecord(v)) {
    const lines: string[] = [];
    for (const [k, val] of Object.entries(v)) {
      if (val == null || val === "") continue;
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") lines.push(`${k}: ${val}`);
      else lines.push(`${k}: ${formatInline(val)}`);
    }
    return lines.join("\n");
  }
  return String(v);
}
function formatInline(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(formatInline).join(", ");
  try { return JSON.stringify(v); } catch { return String(v); }
}

function isRecord(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object"; }

// 从工具的 input/output 提取「人类可读的主要文本」+ exit/truncated 元信息。
// opencode 的工具结果常是 {output, metadata:{exit,output,truncated}} 或 {command/content/...},
// 直接 JSON 不直观;这里抽出主文本干净展示,找不到才回退 JSON。
function extractToolText(raw: unknown): { text: string; exit?: number; truncated?: boolean; fallback: boolean } {
  if (typeof raw === "string") return { text: raw, fallback: false };
  if (!isRecord(raw)) return { text: formatHuman(raw), fallback: true };
  const meta = isRecord(raw.metadata) ? raw.metadata : undefined;
  const exit = typeof meta?.exit === "number" ? meta.exit : (typeof raw.exit === "number" ? raw.exit : undefined);
  const truncated = Boolean(meta?.truncated ?? raw.truncated);
  for (const k of ["output", "stdout", "stderr", "content", "command", "prompt", "message", "text"]) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) return { text: v, exit, truncated, fallback: false };
  }
  if (typeof meta?.output === "string" && meta.output.trim()) return { text: meta.output, exit, truncated, fallback: false };
  return { text: formatHuman(raw), exit, truncated, fallback: true };
}
