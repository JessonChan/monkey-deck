import { useState, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { Project, Session } from "../../bindings/github.com/jessonchan/monkey-deck/internal/store/models";
import type { Harness } from "../../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";
import { Plus, ChevronDown, Folder, Copy, FolderOpen, Trash2, Search, X, Pin, PinOff, Settings, SquareTerminal, ExternalLink, Pencil, FileText, Braces } from "lucide-react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { timeAgo, formatDateTime, sanitizeFileName } from "../utils";
import { copyTextQuiet } from "../lib/clipboard";
import { downloadText } from "../lib/download";
import HarnessIcon from "./HarnessIcon";

interface Props {
  projects: Project[];
  selectedProjectId: string | null;
  sessionsByProject: Record<string, Session[]>;
  selectedSessionId: string | null;
  onSelectProject: (id: string) => void;
  onSelectSession: (sessionId: string, projectId: string) => void;
  onCreateSession: (projectId: string) => void;
  onAddProject: () => void;
  onRemoveProject: (id: string) => void;
  onRemoveSession: (sessionId: string) => void;
  onTogglePin: (sessionId: string, pinned: boolean) => void;
  // 用户右键重命名(0016):写 custom_title(空串=清除,回退到 auto title)。后端落库后乐观更新本地。
  onRenameSession: (sessionId: string, customTitle: string) => void;
  statusBySession: Record<string, string>;
  activityBySession: Record<string, "thinking" | "executing" | "replying">;
  unreadBySession: Record<string, boolean>;
  permPendingBySession: Record<string, boolean>;
  draftBySession?: Record<string, string>;
  hasTermBySession?: Record<string, boolean>;
  // 已知 harness 列表(供 session 行 harness 图标的 tooltip 用 ID → 显示名查表;
  // session.harness 仅 ID,显示名「Oh My Pi / OpenCode」更友好)。
  harnesses?: Harness[];
  onReorderProjects: (ids: string[]) => void;
  onOpenSettings: () => void;
  // 有 harness 新版时,齿轮入口亮红点(§设置入口/harness 菜单红点)。
  harnessUpdateAvailable?: boolean;
  // 已弹出到独立窗口的 session 集合:这些 session 行显示「独立窗口」角标,
  // 点击改为 focus popout 窗口(而非就地选中);右键菜单「移回主窗口」可关闭 popout。
  poppedSessionIds?: Set<string>;
  onPopoutSession?: (sessionId: string) => void;   // 弹出到独立窗口(主窗口打包快照 + 调 OpenSessionWindow)
  onFocusPopout?: (sessionId: string) => void;     // 聚焦已弹出的窗口
  onClosePopout?: (sessionId: string) => void;     // 关闭 popout(移回主窗口)
}

// 可拖拽项目行(0007):折叠态整行可拖,展开态 disabled(不可主动拖,但仍可被其他项挤动)。
// listeners+attributes 展开到外层 wrap;PointerSensor distance 约束让子按钮(caret/搜索/新对话)点击不误触发拖动。
// isDragging 时加 dragging class 去 sticky(见 index.css),规避 transform 与 position:sticky 在 WebKit 的冲突。
function SortableProjectRow({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      className={`project-item-wrap${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}

type Ctx =
  | { kind: "project"; x: number; y: number; project: Project }
  | { kind: "session"; x: number; y: number; session: Session };

type ConfirmTarget =
  | { kind: "project"; project: Project }
  | { kind: "session"; session: Session };

// 侧栏 session 列表分片渲染每页大小:本地 SQLite 全量已加载(查询本来就快),
// 这里只控制渲染的 DOM 节点数,避免单项目几百个 session 一次性撑爆。
const SESSION_PAGE = 25;

export default function Sidebar(props: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
  // inline 重命名(0016):renamingId 标记哪个 session 进入编辑态;renameValue 是输入框值。
  // 进入时用 customTitle || title 初始化;Enter 提交(空串=清除 custom_title 回退 auto),Esc 取消。
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Enter commit unmounts the input, which fires blur and re-runs commitRename;
  // committedRef guards idempotency (backend is already idempotent, but this avoids
  // redundant requests + future footguns if onRenameSession gains side effects).
  const committedRef = useRef(false);
  // IME composition tracking: manually record compositionStart/End, combined with
  // isComposing + keyCode===229 triple guard, to stop IME candidate-confirm Enter
  // from being misread as submit (isComposing is unreliable on some macOS IMEs).
  // Mirrors Composer/QueuePanel.
  const composingRef = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  // session 列表分片渲染:每个项目默认 SESSION_PAGE 个,「加载更多」每次 +SESSION_PAGE。
  const [sessionLimit, setSessionLimit] = useState<Record<string, number>>({});
  // 会话搜索:searchProj 标记哪个项目展开了搜索框。标题本地即时过滤,
  // 内容命中经 SearchSessionContent(后端 LIKE)异步回流,与标题做并集(§4.1)。
  const [searchProj, setSearchProj] = useState<string | null>(null);
  const [searchQ, setSearchQ] = useState("");
  const [contentHits, setContentHits] = useState<string[] | null>(null); // null=未发起内容搜索
  const [contentLoading, setContentLoading] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 拖拽时自动折叠所有项目:展开项虽 disabled 仍占满高度(含 session 列表),拖动需跨越整段 → 距离过长 + 碰撞失准。
  // 开始时记录并全折叠,结束/取消时恢复原展开态,不打断用户原本在看的项目。
  const expandedBeforeDrag = useRef<Set<string>>(new Set());

  // Sidebar session keyboard navigation (#101): kbdSelectIdx is the keyboard cursor index into
  // the SELECTED project's rendered session list (same `list` the user sees). Scoped to the
  // selected project because clicking a session selects its project, so focus is in practice
  // always within the selected project's list — matches the ⌘1-9 "selected project's sessions"
  // model. null = no keyboard cursor (mouse-only / idle).
  const [kbdSelectIdx, setKbdSelectIdx] = useState<number | null>(null);
  const kbdActiveRef = useRef<HTMLDivElement>(null);

  // harness ID → 显示名 查表(供 session 行 harness 图标 tooltip 用);缺省回退到 ID 本身。
  const harnessNameById = (id: string): string =>
    props.harnesses?.find((h) => h.id === id)?.name || id;

  // 拖拽排序(0007):distance=6 区分点击/拖动,避免点子按钮误触发拖。
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const handleDragStart = () => {
    expandedBeforeDrag.current = new Set(expanded);
    setExpanded(new Set());
  };
  const handleDragEnd = (e: DragEndEvent) => {
    setExpanded(expandedBeforeDrag.current); // 恢复原展开态(无论是否实际重排)
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = props.projects.map((p) => p.id);
    const from = ids.indexOf(active.id as string);
    const to = ids.indexOf(over.id as string);
    if (from < 0 || to < 0) return;
    props.onReorderProjects(arrayMove(ids, from, to));
  };
  const handleDragCancel = () => setExpanded(expandedBeforeDrag.current);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        // 折叠:清掉该项目的 session 分片(下次展开回到默认 SESSION_PAGE)。
        next.delete(id);
        setSessionLimit((lim) => { const c = { ...lim }; delete c[id]; return c; });
      } else {
        next.add(id);
      }
      return next;
    });

  const handleProject = async (p: Project) => {
    const isSelected = props.selectedProjectId === p.id;
    if (isSelected) {
      // 已选中项目:点击切换展开/折叠,不触发 selectProject 重新加载
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(p.id)) next.delete(p.id);
        else next.add(p.id);
        return next;
      });
    } else {
      await props.onSelectProject(p.id);
      setExpanded((prev) => new Set(prev).add(p.id));
    }
  };

  const onTitleDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, input, a")) return;
    void ChatService.ToggleMaximise();
  };

  // 右键菜单:统一用鼠标坐标作为起点(VS Code 风格),简单可靠。
  // 视口 clamp 在 useLayoutEffect 里做(渲染后量菜单尺寸再修正)。
  const openProjectMenu = (e: React.MouseEvent, p: Project) => {
    e.preventDefault();
    setCtx({ kind: "project", x: e.clientX, y: e.clientY, project: p });
  };
  const openSessionMenu = (e: React.MouseEvent, s: Session) => {
    e.preventDefault();
    setCtx({ kind: "session", x: e.clientX, y: e.clientY, session: s });
  };
  const menuRef = useRef<HTMLDivElement>(null);

  const closeCtx = () => { setCtx(null); setConfirm(null); setDeleteErr(null); };
  // 提交重命名:trim 后写库(空串=清除 custom_title,回退 auto title)。renamingId 清掉退出编辑态。
  const commitRename = () => {
    if (renamingId == null) return;
    if (committedRef.current) return; // Enter already committed; blur re-trigger is a no-op (idempotent guard)
    committedRef.current = true;
    props.onRenameSession(renamingId, renameValue.trim());
    setRenamingId(null);
    setRenameValue("");
  };
  const cancelRename = () => { setRenamingId(null); setRenameValue(""); };
  // 确认删除:调 onRemove*(async),失败时弹窗内联报错、不关弹窗;成功才关。
  // 关键:全局 window mousedown 监听会把 mousedown 冒泡当「外部点击」关掉弹窗,
  // 故弹窗容器必须 onMouseDown stopPropagation,否则按钮 click 永远拿不到。
  const onConfirmRemoveProject = async (id: string) => {
    setDeleting(true); setDeleteErr(null);
    try { await props.onRemoveProject(id); setConfirm(null); }
    catch (e) { setDeleteErr(String(e)); }
    finally { setDeleting(false); }
  };
  const onConfirmRemoveSession = async (id: string) => {
    setDeleting(true); setDeleteErr(null);
    try { await props.onRemoveSession(id); setConfirm(null); }
    catch (e) { setDeleteErr(String(e)); }
    finally { setDeleting(false); }
  };

  // Export the full session conversation as text/jsonl and trigger a Blob download.
  // File name: <title or "session">-<idPrefix>.<ext>; failures surface as a brief alert.
  const onExportSession = async (sessionId: string, title: string, format: "txt" | "jsonl") => {
    const idPref = sessionId.slice(0, 8);
    const base = sanitizeFileName(title) || "session";
    const ext = format === "jsonl" ? "jsonl" : "txt";
    const mime = format === "jsonl" ? "application/x-ndjson;charset=utf-8" : "text/plain;charset=utf-8";
    try {
      const content = await ChatService.ExportSession(sessionId, format);
      downloadText(content, `${base}-${idPref}.${ext}`, mime);
    } catch (e) {
      alert(`${t("sidebar.exportFailed")}: ${e}`);
    }
  };

  // 点项目行搜索按钮切换:开则展开项目并聚焦输入框,关则清空(只允许一个项目同时搜索)。
  const toggleSearch = (pId: string) => {
    if (searchProj === pId) {
      setSearchProj(null); setSearchQ(""); setContentHits(null); setContentLoading(false);
      return;
    }
    if (!expanded.has(pId)) setExpanded((prev) => new Set(prev).add(pId));
    setSearchProj(pId); setSearchQ(""); setContentHits(null); setContentLoading(false);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  // 单个 session 是否命中:空 query 全过;标题子串(本地即时)∪ 内容命中(后端回流)。
  const matchSession = (s: Session) => {
    const q = searchQ.trim().toLowerCase();
    if (!q) return true;
    if ((s.customTitle || s.title || "").toLowerCase().includes(q)) return true;
    if (contentHits && contentHits.includes(s.id)) return true;
    return false;
  };

  // 菜单关闭:Esc、外部点击、窗口 resize。任一 ctx / confirm 存在即注册监听。
  useEffect(() => {
    if (!ctx && !confirm) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeCtx(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", closeCtx);
    window.addEventListener("resize", closeCtx);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", closeCtx);
      window.removeEventListener("resize", closeCtx);
    };
  }, [ctx, confirm]);
  // 视口 clamp:渲染后量菜单尺寸,推入 [left,top] 防溢出。
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !ctx) return;
    const pad = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = ctx.x;
    let top = ctx.y;
    if (left + w > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - w - pad);
    if (top + h > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - h - pad);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [ctx]);

  // 进入重命名态时聚焦输入框并全选(便于整体覆盖编辑)。
  useEffect(() => {
    if (renamingId == null) return;
    const el = renameInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [renamingId]);

  // 内容搜索:query≥2 字符时去抖 200ms 调后端 LIKE(桌面 SQLite 毫秒级),回填命中 session id。
  // 标题命中是本地即时过滤,不在此 effect 内;切项目/清空立即重置。
  useEffect(() => {
    if (searchProj == null) return;
    const q = searchQ.trim();
    if (q.length < 2) { setContentHits(null); setContentLoading(false); return; }
    setContentLoading(true);
    const h = setTimeout(() => {
      ChatService.SearchSessionContent(searchProj, q)
        .then((ids) => { setContentHits(ids ?? []); })
        .catch(() => { setContentHits([]); })
        .finally(() => setContentLoading(false));
    }, 200);
    return () => clearTimeout(h);
  }, [searchProj, searchQ]);

  // Keyboard-nav scope: the rendered session list of the currently-selected project, computed
  // identically to the per-project `list` in the render loop (visible slice, or search-filtered).
  // kbdSelectIdx indexes into this array.
  const selProjId = props.selectedProjectId;
  const selProjExpanded = selProjId ? expanded.has(selProjId) : false;
  const kbdList: Session[] = (() => {
    if (!selProjId || !selProjExpanded) return [];
    const projSessions = props.sessionsByProject[selProjId] ?? [];
    const sessLimit = sessionLimit[selProjId] ?? SESSION_PAGE;
    const visibleSessions = projSessions.slice(0, sessLimit);
    const searching = searchProj === selProjId && searchQ.trim() !== "";
    return searching ? projSessions.filter(matchSession) : visibleSessions;
  })();

  // Reset the keyboard cursor when it can no longer be valid: switching the selected project
  // (kbdSelectIdx is meaningful only within the selected project's list) or when the list
  // shrinks below the index. State is discarded on Sidebar unmount, so the cursor never leaks
  // across mounts (popout mode hides the Sidebar) — the "clear on teardown" requirement.
  useEffect(() => { setKbdSelectIdx(null); }, [selProjId]);
  useEffect(() => {
    if (kbdSelectIdx != null && kbdSelectIdx >= kbdList.length) setKbdSelectIdx(null);
  }, [kbdList.length]);

  // Keep the keyboard-cursor row visible (e.g. when arrowing past the viewport edge / past the
  // paginated slice boundary). `block: "nearest"` avoids unnecessary scrolling.
  useEffect(() => {
    if (kbdSelectIdx == null) return;
    kbdActiveRef.current?.scrollIntoView({ block: "nearest" });
  }, [kbdSelectIdx]);

  // ↑/↓ + Tab drive the keyboard cursor; Enter activates the cursor row. Attached to <aside> so
  // it only fires while focus is within the sidebar (no global hijack of Arrow/Tab/Enter while
  // the user is in the composer). Tab/Enter are intercepted ONLY once navigation is active
  // (kbdSelectIdx != null) so we never trap focus or steal native Enter before the user starts
  // keyboard navigation; Arrow keys may start it. Inputs (search/rename), modifier combos and
  // open ctx/confirm overlays are skipped so their own key handling is untouched.
  const onSidebarKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (ctx || confirm) return;
    const list = kbdList;
    if (list.length === 0) return;

    const key = e.key;
    const isDown = key === "ArrowDown" || (key === "Tab" && !e.shiftKey);
    const isUp = key === "ArrowUp" || (key === "Tab" && e.shiftKey);
    if (!isDown && !isUp && key !== "Enter") return;
    if ((key === "Tab" || key === "Enter") && kbdSelectIdx == null) return;

    e.preventDefault();
    const len = list.length;

    if (key === "Enter") {
      const idx = kbdSelectIdx;
      if (idx == null || idx >= len) return;
      const s = list[idx];
      if (props.poppedSessionIds?.has(s.id) && props.onFocusPopout) props.onFocusPopout(s.id);
      else props.onSelectSession(s.id, selProjId!);
      return;
    }

    setKbdSelectIdx((prev) => {
      if (prev == null) {
        // Start from the active session when possible, so ↑/↓ step from the current position
        // instead of jumping to the list edge.
        const cur = props.selectedSessionId ? list.findIndex((s) => s.id === props.selectedSessionId) : -1;
        if (isDown) return cur >= 0 ? Math.min(cur + 1, len - 1) : 0;
        return cur >= 0 ? Math.max(cur - 1, 0) : len - 1;
      }
      return isDown ? Math.min(prev + 1, len - 1) : Math.max(prev - 1, 0);
    });
  };

  return (
    <aside className="sidebar" data-testid="sidebar" onKeyDown={onSidebarKeyDown}>
      <div className="sidebar-header" onDoubleClick={onTitleDoubleClick}>
        <span className="sidebar-title">{t("app.brand")}</span>
        <span className="sidebar-header-acts">
          <button className="icon-btn has-update-dot" data-testid="open-settings" onClick={props.onOpenSettings} data-tooltip-id="md-tip" data-tooltip-content={props.harnessUpdateAvailable ? t("settings.center.openTipUpdate") : t("settings.center.openTip")} data-tooltip-place="bottom">
            <Settings size={16} />
            {props.harnessUpdateAvailable && <span className="update-dot" />}
          </button>
          <button className="icon-btn" data-testid="add-project" onClick={props.onAddProject} data-tooltip-id="md-tip" data-tooltip-content={t("sidebar.addProject")} data-tooltip-place="bottom">
            <Plus size={17} />
          </button>
        </span>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={handleDragCancel}>
      <SortableContext items={props.projects.map((p) => p.id)} strategy={verticalListSortingStrategy}>
      <div className="project-list">
        {props.projects.length === 0 && (
          <div className="sidebar-empty">{t("sidebar.noProjects")}</div>
        )}
        {props.projects.map((p) => {
          const isOpen = expanded.has(p.id);
          const projSessions = props.sessionsByProject[p.id] ?? [];
          const sessLimit = sessionLimit[p.id] ?? SESSION_PAGE;
          const visibleSessions = projSessions.slice(0, sessLimit);
          const hiddenCount = projSessions.length - visibleSessions.length;
          const searching = searchProj === p.id && searchQ.trim() !== "";
          const list = searching ? projSessions.filter(matchSession) : visibleSessions;
          // 项目行活跃信号:折叠时显示左竖条(running=慢呼吸 / unread=静态)。展开时 session 行已有 dot/spinner,无需重复。
          const projRunning = projSessions.some((s) => props.statusBySession[s.id] === "prompting");
          const projUnread = projSessions.some((s) => props.statusBySession[s.id] !== "prompting" && props.unreadBySession[s.id]);
          const barCls = !isOpen && projRunning ? "has-running" : !isOpen && projUnread ? "has-unread" : "";
          return (
            <SortableProjectRow key={p.id} id={p.id} disabled={isOpen}>
              <div
                className={`project-item ${props.selectedProjectId === p.id ? "active" : ""} ${barCls}`}
                onContextMenu={(e) => openProjectMenu(e, p)}
              >
                <button className={`caret ${isOpen ? "open" : ""}`} onClick={() => toggle(p.id)}>
                  <ChevronDown size={13} style={{ transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s" }} />
                </button>
                <button className="project-main" data-testid={`project-${p.id}`} onClick={() => handleProject(p)}>
                  <Folder size={15} />
                  <span className="project-name" data-tooltip-id="md-tip" data-tooltip-content={p.path}>{p.name}</span>
                </button>
                <button className="icon-btn small" onClick={() => toggleSearch(p.id)} data-tooltip-id="md-tip" data-tooltip-content={searchProj === p.id ? t("sidebar.searchOn") : t("sidebar.searchOff")} data-tooltip-place="bottom" data-testid={`search-sessions-${p.id}`}>
                  <Search size={12} />
                </button>
                <button className="icon-btn small" onClick={() => props.onCreateSession(p.id)} data-tooltip-id="md-tip" data-tooltip-content={t("sidebar.newSession")} data-testid={`new-session-${p.id}`}>
                  <Plus size={13} />
                </button>
              </div>
              {isOpen && (
                <div className="session-list">
                  {searchProj === p.id && (
                    <div className="session-search-row">
                      <Search size={12} />
                      <input
                        ref={searchInputRef}
                        className="session-search-input"
                        data-testid={`session-search-${p.id}`}
                        placeholder={t("sidebar.searchPlaceholder")}
                        value={searchQ}
                        onChange={(e) => setSearchQ(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Escape") toggleSearch(p.id); }}
                      />
                      {contentLoading && <span className="search-spinner" data-tooltip-id="md-tip" data-tooltip-content={t("sidebar.searchingContent")} />}
                      {searchQ && (
                        <button className="icon-btn small" data-tooltip-id="md-tip" data-tooltip-content={t("common.clear")} onClick={() => setSearchQ("")}>
                          <X size={11} />
                        </button>
                      )}
                    </div>
                  )}
                  {list.map((s, i) => {
                    const st = props.statusBySession[s.id];
                    const active = st === "prompting";
                    const act = props.activityBySession[s.id];
                    const cls = st === "error" ? "error" : active ? act ?? "running" : st === "reconnecting" ? "reconnecting" : "";
                    const dotTip = st === "error" ? t("sidebar.status.error")
                      : active ? ({ thinking: t("sidebar.status.thinking"), executing: t("sidebar.status.executing"), replying: t("sidebar.status.replying") } as Record<string, string>)[act ?? ""] ?? t("sidebar.status.generating")
                      : st === "reconnecting" ? t("sidebar.status.reconnecting")
                      : t("sidebar.status.idle");
                    const unread = !active && props.unreadBySession[s.id];
                    // 显示标题:custom_title 优先(用户重命名),回退 auto title,再回退兜底文案(0016)。
                    const displayTitle = s.customTitle || s.title || t("sidebar.sessionDraftFallback");
                    // Keyboard cursor lands only on the selected project's rows (kbdSelectIdx indexes
                    // that project's list). Visualised as an inset accent ring layered over the row.
                    const kbdActive = p.id === selProjId && i === kbdSelectIdx;
                    // 重命名态:整行换成输入框(Enter 提交 / Esc 取消 / blur 提交)。mousedown 阻止冒泡到
                    // 全局 ctx 关闭监听(虽此处 ctx 已关,但防其它 window mousedown 副作用)。
                    if (renamingId === s.id) {
                      return (
                        <div
                          key={s.id}
                          ref={kbdActive ? kbdActiveRef : undefined}
                          className={`session-item-row ${props.selectedSessionId === s.id ? "active" : ""}${kbdActive ? " kbd-active" : ""}`}
                          data-testid={`session-${s.id}`}
                        >
                          <input
                            ref={renameInputRef}
                            className="session-rename-input"
                            data-testid={`rename-input-${s.id}`}
                            aria-label={t("sidebar.rename")}
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              // During IME composition Enter selects a candidate — do not submit (triple guard per Composer/QueuePanel).
                              if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
                              if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                              else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                            }}
                            onCompositionStart={() => { composingRef.current = true; }}
                            onCompositionEnd={() => { composingRef.current = false; }}
                            onBlur={commitRename}
                            onMouseDown={(e) => e.stopPropagation()}
                          />
                        </div>
                      );
                    }
                    // 设了 custom_title 且原 title 非空:tooltip 揭示原标题,避免重命名后丢失出处。
                    // tooltip props spread conditionally: only attach data-tooltip-id when labelTip is set,
                    // otherwise react-tooltip renders an empty frame for an anchor with empty/missing content
                    // (affects every non-renamed session).
                    const labelTip = s.customTitle && s.title ? t("sidebar.originalTitleTip", { title: s.title }) : undefined;
                    const labelTipProps = labelTip ? { "data-tooltip-id": "md-tip", "data-tooltip-content": labelTip } : {};
                    return (
                      <div
                        key={s.id}
                        ref={kbdActive ? kbdActiveRef : undefined}
                        className={`session-item-row ${props.selectedSessionId === s.id ? "active" : ""}${kbdActive ? " kbd-active" : ""}`}
                        data-testid={`session-${s.id}`}
                        onContextMenu={(e) => openSessionMenu(e, s)}
                      >
                        <button
                          className="session-item-main"
                          onClick={() => {
                            if (props.poppedSessionIds?.has(s.id) && props.onFocusPopout) props.onFocusPopout(s.id);
                            else props.onSelectSession(s.id, p.id);
                          }}
                        >
                          <span className={`session-dot ${cls}`} data-tooltip-id="md-tip" data-tooltip-content={dotTip} />
                          <span className="session-label" {...labelTipProps}>{displayTitle}</span>
                          {props.poppedSessionIds?.has(s.id) && (
                            <span className="session-popout-mark" data-tooltip-id="md-tip" data-tooltip-content={t("sidebar.popoutTip")} data-testid={`popout-${s.id}`}>
                              <ExternalLink size={11} />
                            </span>
                          )}
                          <HarnessIcon harnessId={s.harness} size={12} className="session-harness-icon" tooltip={t("sidebar.harnessTip", { name: harnessNameById(s.harness) })} />
                          {s.pinned && (
                            <span className="session-pin" data-tooltip-id="md-tip" data-tooltip-content={t("sidebar.pinnedTip")} data-testid={`pin-${s.id}`}>
                              <Pin size={11} />
                            </span>
                          )}
                          {props.hasTermBySession?.[s.id] && (
                            <span className="session-terminal-mark" data-tooltip-id="md-tip" data-tooltip-content={t("sidebar.terminalOpenTip")} data-testid={`term-open-${s.id}`}>
                              <SquareTerminal size={12} />
                            </span>
                          )}
                          {props.permPendingBySession[s.id] ? (
                            <span className="perm-dot" data-tooltip-id="md-tip" data-tooltip-content={t("sidebar.permPendingTip")} data-testid={`perm-dot-${s.id}`} />
                          ) : active ? (
                            <span className="tail-spinner" data-tooltip-id="md-tip" data-tooltip-content={t("sidebar.generatingTip")} />
                          ) : unread ? (
                            <span className="unread-dot" data-tooltip-id="md-tip" data-tooltip-content={t("sidebar.unreadTip")} />
                          ) : (() => {
                            const dh = props.draftBySession?.[s.id];
                            return dh && dh.trim() ? (
                              <span className="draft-indicator" data-tooltip-id="md-tip" data-tooltip-content={t("sidebar.draftTip", { text: dh.trim() })} data-testid={`draft-${s.id}`}><Pencil /></span>
                            ) : <span className="session-time" data-tooltip-id="md-tip" data-tooltip-content={formatDateTime(s.updatedAt)}>{timeAgo(s.updatedAt)}</span>;
                          })()}
                        </button>
                      </div>
                    );
                  })}
                  {searching && list.length === 0 && (
                    <div className="session-search-empty">{t("sidebar.noMatch")}</div>
                  )}
                  {!searching && hiddenCount > 0 && (
                    <button
                      className="session-more-btn"
                      data-testid={`load-more-sessions-${p.id}`}
                      onClick={() => setSessionLimit((prev) => ({ ...prev, [p.id]: (prev[p.id] ?? SESSION_PAGE) + SESSION_PAGE }))}
                    >
                      {t("sidebar.loadMore", { count: hiddenCount })}
                    </button>
                  )}
                </div>
              )}
            </SortableProjectRow>
          );
        })}
      </div>
      </SortableContext>
      </DndContext>

      {ctx?.kind === "project" && (
        <div ref={menuRef} className="ctx-menu" style={{ left: ctx.x, top: ctx.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button className="ctx-item" onClick={() => { copyTextQuiet(ctx.project.path); closeCtx(); }}>
            <Copy size={13} /> {t("sidebar.copyWorkdir")}
          </button>
          <button className="ctx-item" onClick={() => { void ChatService.RevealPath(ctx.project.path); closeCtx(); }}>
            <FolderOpen size={13} /> {t("sidebar.revealInFinder")}
          </button>
          <div className="ctx-sep" />
          <button className="ctx-item danger" onClick={() => { setConfirm({ kind: "project", project: ctx.project }); setCtx(null); setDeleteErr(null); }}>
            <Trash2 size={13} /> {t("sidebar.removeProject")}
          </button>
        </div>
      )}

      {ctx?.kind === "session" && (
        <div ref={menuRef} className="ctx-menu" style={{ left: ctx.x, top: ctx.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button
            className="ctx-item"
            disabled={props.selectedSessionId === ctx.session.id}
            onClick={() => { if (props.selectedSessionId !== ctx.session.id) void props.onSelectSession(ctx.session.id, ctx.session.projectId); closeCtx(); }}
          >
            <Folder size={13} /> {t("sidebar.activateSession")}
          </button>
          {props.poppedSessionIds?.has(ctx.session.id) ? (
            <button className="ctx-item" onClick={() => { props.onClosePopout?.(ctx.session.id); closeCtx(); }}>
              <ExternalLink size={13} /> {t("sidebar.moveBackToMainWindow")}
            </button>
          ) : (
            <button className="ctx-item" onClick={() => { props.onPopoutSession?.(ctx.session.id); closeCtx(); }}>
              <ExternalLink size={13} /> {t("sidebar.moveToNewWindow")}
            </button>
          )}
          <div className="ctx-sep" />
          <button className="ctx-item" onClick={() => { void props.onTogglePin(ctx.session.id, !ctx.session.pinned); closeCtx(); }}>
            {ctx.session.pinned ? <><PinOff size={13} /> {t("sidebar.unpin")}</> : <><Pin size={13} /> {t("sidebar.pin")}</>}
          </button>
          <button
            className="ctx-item"
            data-testid={`rename-session-${ctx.session.id}`}
            onClick={() => {
              committedRef.current = false; // entering edit mode — reset commit guard
              setRenamingId(ctx.session.id);
              setRenameValue(ctx.session.customTitle || ctx.session.title);
              setCtx(null);
            }}
          >
            <Pencil size={13} /> {t("sidebar.rename")}
          </button>
          <button className="ctx-item" onClick={() => { copyTextQuiet(ctx.session.id); closeCtx(); }}>
            <Copy size={13} /> {t("sidebar.copySessionId")}
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              const project = props.projects.find((p) => p.id === ctx.session.projectId);
              copyTextQuiet(ctx.session.worktreePath || project?.path || "");
              closeCtx();
            }}
          >
            <Copy size={13} /> {t("sidebar.copyWorkdir")}
          </button>
          {ctx.session.worktreePath && (
            <button className="ctx-item" onClick={() => { void ChatService.RevealPath(ctx.session.worktreePath); closeCtx(); }}>
              <FolderOpen size={13} /> {t("sidebar.revealWorktree")}
            </button>
          )}
          <div className="ctx-sep" />
          <div className="ctx-label">{t("sidebar.exportChat")}</div>
          <button className="ctx-item" data-testid={`export-txt-${ctx.session.id}`} onClick={() => { void onExportSession(ctx.session.id, ctx.session.title, "txt"); closeCtx(); }}>
            <FileText size={13} /> {t("sidebar.exportAsText")}
          </button>
          <button className="ctx-item" data-testid={`export-jsonl-${ctx.session.id}`} onClick={() => { void onExportSession(ctx.session.id, ctx.session.title, "jsonl"); closeCtx(); }}>
            <Braces size={13} /> {t("sidebar.exportAsJSON")}
          </button>
          <div className="ctx-sep" />
          <button className="ctx-item danger" onClick={() => { setConfirm({ kind: "session", session: ctx.session }); setCtx(null); setDeleteErr(null); }}>
            <Trash2 size={13} /> {t("sidebar.deleteSession")}
          </button>
        </div>
      )}

      {confirm?.kind === "project" && (
        <div className="modal-overlay" onClick={() => setConfirm(null)} onMouseDown={(e) => e.stopPropagation()}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-title">{t("sidebar.removeProjectTitle")}</div>
            <div className="modal-del-target" data-tooltip-id="md-tip" data-tooltip-content={confirm.project.path}>{confirm.project.name} · {confirm.project.path}</div>
            <div className="modal-actions">
              <button className="modal-btn ghost" onClick={() => setConfirm(null)}>{t("common.cancel")}</button>
              <button className="modal-btn danger" disabled={deleting} onClick={() => void onConfirmRemoveProject(confirm.project.id)}>{t("sidebar.removeBtn")}</button>
            </div>
          </div>
        </div>
      )}

      {confirm?.kind === "session" && (
        <div className="modal-overlay" onClick={() => setConfirm(null)} onMouseDown={(e) => e.stopPropagation()}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-title">{t("sidebar.deleteSessionTitle")}</div>
            <div className="modal-del-target">{confirm.session.title || t("sidebar.sessionDraftFallback")} · {confirm.session.id.slice(0, 8)}</div>
            {deleteErr && <div className="modal-del-err">⚠ {deleteErr}</div>}
            <div className="modal-actions">
              <button className="modal-btn ghost" onClick={() => setConfirm(null)}>{t("common.cancel")}</button>
              <button className="modal-btn danger" disabled={deleting} onClick={() => void onConfirmRemoveSession(confirm.session.id)}>{t("common.delete")}</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
