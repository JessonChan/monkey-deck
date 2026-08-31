import { useState, useEffect, useLayoutEffect, useRef, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { Project, Session } from "../../bindings/github.com/jessonchan/monkey-deck/internal/store/models";
import type { Harness } from "../../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";
import { AlarmClock, Plus, ChevronDown, Folder, Copy, FolderOpen, Trash2, Search, X, Pin, PinOff, Settings, SquareTerminal, ExternalLink, Pencil, FileText, Braces, ListChecks, Check, Tag, GitFork } from "lucide-react";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
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
import { tagColor, collectTags } from "../lib/tagColor";
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
  // Assign/replace a session's tag set (#150): writes via UpdateSessionTags
  // (backend normalizes trim/dedupe/cap) then optimistic local field update.
  // Adding from the ctx submenu appends to the live set; removing filters one out.
  onSetSessionTags: (sessionId: string, tags: string[]) => void;
  // 用户右键重命名(0016):写 custom_title(空串=清除,回退到 auto title)。后端落库后乐观更新本地。
  onRenameSession: (sessionId: string, customTitle: string) => void;
  statusBySession: Record<string, string>;
  activityBySession: Record<string, "thinking" | "executing" | "replying">;
  unreadBySession: Record<string, boolean>;
  permPendingBySession: Record<string, boolean>;
  draftBySession?: Record<string, string>;
  // Scheduled-send alarm (#138): sessionId -> { count, earliest } over FUTURE
  // scheduledAt entries among queued items, derived in App from authoritative
  // chat:queue snapshots. Once an item falls due the backend drain dequeues it,
  // the next snapshot drops the entry, and this marker clears itself — no local
  // ticking involved. count feeds the tooltip ("N pending"), earliest its time.
  scheduledBySession?: Record<string, { count: number; earliest: number }>;
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
  // #172 fork:「基于最后的对话分叉」右键菜单项。canForkSession 为声明位门控
  // (session harness 探测矩阵的 sessionFork 位,undeclared 不渲染该菜单项);
  // onForkSession 走与 ChatView 相同的 forkSession 链路,成功后新会话打开。
  canForkSession?: (s: Session) => boolean;
  onForkSession?: (sessionId: string) => void;
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
  | { kind: "session"; session: Session }
  // Batch delete (#94): the ordered selected-session list (render order),
  // captured at confirm time so the modal body and the delete loop share one
  // source of truth even if the live selection changes underneath.
  | { kind: "batch"; items: { id: string; title: string }[] };

// Sidebar session list pagination page size: the local SQLite full set is already loaded
// (the query is fast anyway); this only caps rendered DOM nodes so a project with
// hundreds of sessions doesn't blow up the tree at once.
const SESSION_PAGE = 25;

// Expanded-project persistence (issue #57): which projects the user left expanded
// survives restarts via localStorage — same lazy-init + useEffect-writeback pattern
// as `md:plan-open:<sessionId>` (ChatView). Stores a JSON array of project IDs;
// corrupt / missing / non-array values fall back to the empty set (best-effort).
const EXPANDED_KEY = "md:sidebar-expanded";

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (!raw) return new Set();
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

// Due-soon window (#141): a scheduled-send alarm flips into its prominent pulse
// mode once the earliest send is this close. Mirrors QueuePanel's live-countdown
// granularity: the final minute is what "about to fire" means to a user.
const DUE_SOON_MS = 60_000;

export default function Sidebar(props: Props) {
  const { t } = useTranslation();
  // Lazy init from localStorage (issue #57): restore the expanded set left over
  // from the previous run instead of always starting collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);
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
  // Tag filter (#150/#160c): tagFilter[projectId] = the project's selected
  // filter tags (no key = unfiltered). OR semantics — a session passes when
  // ANY of its tags is selected; an empty selection never filters. ANDs with
  // search, per-project independent (mirrors searchProj).
  const [tagFilter, setTagFilter] = useState<Record<string, string[]>>({});
  // Tag-filter panel (#160b): which project's chip row is expanded (null = all
  // closed). The row is no longer always-on — it opens from the project-row
  // button group and closes back to zero footprint; single-open mirrors
  // searchProj. A closed panel never keeps filtering: closing drops that
  // project's active tagFilter too (see toggleTagPanel) — no hidden state.
  const [tagPanelProj, setTagPanelProj] = useState<string | null>(null);
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

  // Scheduled-send due-soon wake (#141): re-render exactly when the nearest pending
  // schedule crosses the DUE_SOON_MS threshold so the alarm chip gains .is-due-soon
  // without waiting for a chat:queue snapshot (an idle app may see none for minutes).
  // Same model as the backend's own one-shot schedule timers — never a polling
  // interval. One armed timeout at a time; the fired counter feeds back into the
  // effect deps so each firing arms the next boundary. Zero cost while no schedule
  // is within arming distance, and timers stop once all boundaries are crossed
  // (the drain snapshot then drops the entries entirely).
  const [dueTick, setDueTick] = useState(0);
  useEffect(() => {
    let wake = Infinity;
    for (const { earliest } of Object.values(props.scheduledBySession ?? {})) {
      const at = earliest - DUE_SOON_MS;
      if (at > Date.now() && at < wake) wake = at;
    }
    if (!isFinite(wake)) return;
    const id = setTimeout(() => setDueTick((n) => n + 1), Math.max(0, wake - Date.now()));
    return () => clearTimeout(id);
  }, [props.scheduledBySession, dueTick]);

  // ── Batch selection (#94) ──────────────────────────────────────────────────
  // Multi-select sessions via ⌘/Ctrl+click (toggle), Shift+click (range from the
  // last individually clicked row) and per-row checkboxes (visible while select
  // mode is on; entered from the per-project select-all button (project row,
  // next to search; #155) or any modifier click).
  // Batch actions: copy working directories (newline-joined, worktreePath ||
  // project path — same resolution as the single-row ctx menu) and delete
  // (confirm modal, sequential via the existing onRemoveSession flow).
  const [selMode, setSelMode] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  // Anchor row for Shift+click ranges: the id last individually (toggled) clicked.
  // Ref not state: it never drives rendering, only click-time range math.
  const selAnchorRef = useRef<string | null>(null);
  const { copied: selCopied, failed: selCopyFailed, copy: selCopy } = useCopyFeedback();

  const exitSelMode = () => {
    setSelMode(false);
    setSel(new Set());
    selAnchorRef.current = null;
  };

  const toggleSel = (id: string) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    selAnchorRef.current = id;
  };

  // Selected sessions in sidebar render order (project order → session order):
  // batch copy/delete act on what the user sees, in that order, regardless of
  // the click order that built the selection.
  const selectedSessions = (): { s: Session; projectId: string }[] => {
    const out: { s: Session; projectId: string }[] = [];
    for (const p of props.projects)
      for (const s of props.sessionsByProject[p.id] ?? [])
        if (sel.has(s.id)) out.push({ s, projectId: p.id });
    return out;
  };

  const onBatchCopyDirs = async () => {
    const text = selectedSessions()
      .map(({ s, projectId }) =>
        s.worktreePath || props.projects.find((p) => p.id === projectId)?.path || "")
      .filter(Boolean)
      .join("\n");
    if (text) await selCopy(text);
  };

  const openBatchConfirm = () => {
    const items = selectedSessions().map(({ s }) => ({
      id: s.id,
      title: s.customTitle || s.title || t("sidebar.sessionDraftFallback"),
    }));
    if (items.length === 0) return;
    setConfirm({ kind: "batch", items });
    setCtx(null);
    setDeleteErr(null);
  };

  const onConfirmBatchDelete = async (items: { id: string; title: string }[]) => {
    setDeleting(true); setDeleteErr(null);
    try {
      for (const it of items) await props.onRemoveSession(it.id);
      setConfirm(null);
      exitSelMode();
    } catch (e) { setDeleteErr(String(e)); }
    finally { setDeleting(false); }
  };


  // harness ID → 显示名 查表(供 session 行 harness 图标 tooltip 用);缺省回退到 ID 本身。
  const harnessNameById = (id: string): string =>
    props.harnesses?.find((h) => h.id === id)?.name || id;

  // Drag reordering (0007): distance=6 tells click from drag so clicking child
  // buttons doesn't accidentally start a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  // True while a project drag is in progress: dragStart collapses everything as a
  // transient visual state and dragEnd/cancel restores it — the persistence effect
  // must not write the transient empty set (a crash mid-drag would wipe the
  // user's expansion). The restore re-fires the effect with the flag back to false,
  // so the pre-drag set is re-persisted.
  const draggingRef = useRef(false);
  const handleDragStart = () => {
    draggingRef.current = true;
    expandedBeforeDrag.current = new Set(expanded);
    setExpanded(new Set());
  };
  const handleDragEnd = (e: DragEndEvent) => {
    draggingRef.current = false;
    setExpanded(expandedBeforeDrag.current); // restore pre-drag expansion (whether reordered or not)
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = props.projects.map((p) => p.id);
    const from = ids.indexOf(active.id as string);
    const to = ids.indexOf(over.id as string);
    if (from < 0 || to < 0) return;
    props.onReorderProjects(arrayMove(ids, from, to));
  };
  const handleDragCancel = () => {
    draggingRef.current = false;
    setExpanded(expandedBeforeDrag.current);
  };

  // Persist the expanded set back to localStorage on every change (issue #57).
  // Also fires once on mount (idempotent write of the just-loaded value). Stale IDs
  // of since-removed projects are harmless (never match) and are NOT pruned here —
  // projects load async after mount, so pruning on the mount pass would wipe the
  // persisted state.
  useEffect(() => {
    if (draggingRef.current) return;
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
    } catch {
      // localStorage unavailable (quota / disabled) — persistence is best-effort.
    }
  }, [expanded]);

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

  // Toggle one chip in a project's OR filter (#150/#160c): add joins the
  // selected set, re-click removes; removing the last tag returns the
  // project to unfiltered (no empty-array key left behind).
  const toggleTagFilter = (pId: string, tag: string) => {
    setTagFilter((prev) => {
      const cur = prev[pId] ?? [];
      const next = cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag];
      if (next.length === 0) {
        if (!(pId in prev)) return prev;
        const rest = { ...prev };
        delete rest[pId];
        return rest;
      }
      return { ...prev, [pId]: next };
    });
  };

  // Tag-filter panel toggle (#160b): opens the per-project chip row from the
  // project-row button group (or closes it back). Single-open, mirroring
  // toggleSearch: opening another project's panel closes the previous one.
  // Closing a panel — directly or by opening elsewhere — clears that
  // project's active filter, so a hidden chip row can never keep narrowing
  // the list invisibly.
  const toggleTagPanel = (pId: string) => {
    if (tagPanelProj === pId) {
      setTagPanelProj(null);
      setTagFilter((prev) => {
        if (!(pId in prev)) return prev;
        const next = { ...prev };
        delete next[pId];
        return next;
      });
      return;
    }
    if (tagPanelProj != null) {
      const prevProj = tagPanelProj;
      setTagFilter((prev) => {
        if (!(prevProj in prev)) return prev;
        const next = { ...prev };
        delete next[prevProj];
        return next;
      });
    }
    if (!expanded.has(pId)) setExpanded((prev) => new Set(prev).add(pId));
    setTagPanelProj(pId);
  };
  // ctx 菜单里取该 session 的「活」数据:ctx.session 是打开菜单那一刻的快照,
  // 标签增删后乐观更新的是 sessionsByProject,快照会过期 → 每次渲染/动作前现查。
  const liveSession = (id: string): Session | null => {
    for (const list of Object.values(props.sessionsByProject)) {
      const hit = list.find((s) => s.id === id);
      if (hit) return hit;
    }
    return null;
  };

  // Does a single session match the search: empty query passes everything;
  // title substring (local, instant) ∪ content hits (backend LIKE, async).
  const matchSession = (s: Session) => {
    const q = searchQ.trim().toLowerCase();
    if (!q) return true;
    if ((s.customTitle || s.title || "").toLowerCase().includes(q)) return true;
    if (contentHits && contentHits.includes(s.id)) return true;
    return false;
  };

  // Rendered session list of a project — the exact array the user sees
  // (paginated slice, or tag/search-filtered). Shared by the render loop, the
  // keyboard-nav scope and Shift+click range math so all three agree (#94).
  // Tag filter ANDs with search (#150): either being active bypasses
  // pagination (same as search); tags narrow the set first, search then
  // applies title ∪ content on top. OR membership (#160c): a session passes
  // when any of its tags intersects the selection; an empty selection never
  // filters.
  const projectList = (pId: string): Session[] => {
    const projSessions = props.sessionsByProject[pId] ?? [];
    const activeTags = tagFilter[pId] ?? [];
    const tagFiltered = activeTags.length
      ? projSessions.filter((s) => (s.tags ?? []).some((t) => activeTags.includes(t)))
      : projSessions;
    const sessLimit = sessionLimit[pId] ?? SESSION_PAGE;
    const searching = searchProj === pId && searchQ.trim() !== "";
    if (searching || activeTags.length) {
      return searching ? tagFiltered.filter(matchSession) : tagFiltered;
    }
    return tagFiltered.slice(0, sessLimit);
  };
  // Select-all toggle for one project (#155, toggle semantics #161): first
  // click folds every currently visible session of that project into the
  // selection and turns select mode on; when every visible session is already
  // selected, the click deselects that visible set instead — exiting select
  // mode if that empties the whole selection. "Visible" is the same rendered
  // array shared with keyboard-nav and Shift+click range math (projectList):
  // under an active search/tag filter that is the filtered result set;
  // otherwise the paginated slice (pagination caps rendering, not intent —
  // "load more" then select-all again unions the tail). Nothing visible →
  // no-op, never an error (#155 ③). A collapsed project is expanded so the
  // promised checkboxes are actually rendered (same auto-expand the
  // neighbouring search button does). The click-order anchor is deliberately
  // NOT touched in either branch: select-all is not an individual toggle
  // click, so the anchor keeps its documented meaning for Shift+click ranges
  // (#155 ④).
  const selectAllProject = (pId: string) => {
    const list = projectList(pId);
    if (list.length === 0) return;
    if (!list.every((s) => sel.has(s.id))) {
      if (!expanded.has(pId)) setExpanded((prev) => new Set(prev).add(pId));
      setSelMode(true);
      setSel((prev) => {
        const next = new Set(prev);
        for (const s of list) next.add(s.id);
        return next;
      });
      return;
    }
    // All visible already selected → deselect them. An emptied selection
    // leaves select mode entirely (same end state as Esc).
    const remaining = new Set(sel);
    for (const s of list) remaining.delete(s.id);
    if (remaining.size === 0) exitSelMode();
    else setSel(remaining);
  };

  // Drop selected ids that no longer exist in any project's session list
  // (deleted via ctx menu / another window) so the batch count never lies.
  const allSessionIds = useMemo(
    () => new Set(Object.values(props.sessionsByProject).flat().map((s) => s.id)),
    [props.sessionsByProject],
  );
  useEffect(() => {
    setSel((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (allSessionIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [allSessionIds]);

  // Esc leaves select mode once any ctx/confirm overlay has closed itself.
  // Inputs keep their own Esc handling (search clear / rename cancel).
  useEffect(() => {
    if (!selMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
      if (ctx || confirm) return;
      e.preventDefault();
      exitSelMode();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selMode, ctx, confirm]);


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

  // Session search input: uncontrolled + native "input" listener (FilePanel
  // precedent). React synthetic onChange from dispatched events is unreliable
  // in the test DOM; the native path reaches setSearchQ in both happy-dom and
  // real webviews. Re-bound per open search row (the row remounts per project).
  useEffect(() => {
    const el = searchInputRef.current;
    if (!el) return;
    const onInput = () => setSearchQ(el.value);
    el.addEventListener("input", onInput);
    return () => el.removeEventListener("input", onInput);
  }, [searchProj]);

  // Keyboard-nav scope: the rendered session list of the currently-selected project, computed
  // identically to the per-project `list` in the render loop (visible slice, or search-filtered).
  // kbdSelectIdx indexes into this array.
  const selProjId = props.selectedProjectId;
  const selProjExpanded = selProjId ? expanded.has(selProjId) : false;
  const kbdList: Session[] =
    !selProjId || !selProjExpanded ? [] : projectList(selProjId);

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

  // Modifier-aware session-row click (#94): ⌘/Ctrl toggles the row into the
  // selection, Shift extends from the anchor row (within the project's rendered
  // list; a cross-project anchor degrades to a plain toggle), and a plain click
  // toggles while select mode is on — activating the session otherwise.
  // Modifier clicks always enter select mode first, so checkboxes appear.
  const onSessionRowClick = (e: React.MouseEvent, s: Session, projectId: string) => {
    if (selMode || e.metaKey || e.ctrlKey || e.shiftKey) {
      e.preventDefault();
      setSelMode(true);
      if (e.shiftKey && selAnchorRef.current) {
        const list = projectList(projectId);
        const a = list.findIndex((x) => x.id === selAnchorRef.current);
        const b = list.findIndex((x) => x.id === s.id);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          setSel((prev) => {
            const next = new Set(prev);
            for (let i = lo; i <= hi; i++) next.add(list[i].id);
            return next;
          });
          return;
        }
      }
      toggleSel(s.id);
      return;
    }
    if (props.poppedSessionIds?.has(s.id) && props.onFocusPopout) props.onFocusPopout(s.id);
    else props.onSelectSession(s.id, projectId);
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
          const hiddenCount = Math.max(0, projSessions.length - (sessionLimit[p.id] ?? SESSION_PAGE));
          const searching = searchProj === p.id && searchQ.trim() !== "";
          // All tags seen across the project's sessions (first-seen order)
          // + this project's selected filter tags (#150/#160c).
          const projTags = collectTags(projSessions);
          const activeTags = tagFilter[p.id] ?? [];
          const list = projectList(p.id);
          // #161/#28399: the select-all button keeps its STATIC「全选」tooltip
          // per the pinned spec — it must not flip with selection state.
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
                <button className="icon-btn small" onClick={() => toggleTagPanel(p.id)} data-tooltip-id="md-tip" data-tooltip-content={tagPanelProj === p.id ? t("sidebar.tagFilterOn") : t("sidebar.tagFilterOff")} data-tooltip-place="bottom" data-testid={`tag-filter-sessions-${p.id}`}>
                  <Tag size={12} />
                </button>
                <button className="icon-btn small" onClick={() => selectAllProject(p.id)} data-tooltip-id="md-tip" data-tooltip-content={t("sidebar.batchSelectAll")} data-tooltip-place="bottom" data-testid={`select-all-sessions-${p.id}`}>
                  <ListChecks size={13} />
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
                        onKeyDown={(e) => { if (e.key === "Escape") toggleSearch(p.id); }}
                      />
                      {contentLoading && <span className="search-spinner" data-tooltip-id="md-tip" data-tooltip-content={t("sidebar.searchingContent")} />}
                      {searchQ && (
                        <button className="icon-btn small" data-tooltip-id="md-tip" data-tooltip-content={t("common.clear")} onClick={() => { setSearchQ(""); if (searchInputRef.current) searchInputRef.current.value = ""; }}>
                          <X size={11} />
                        </button>
                      )}
                    </div>
                  )}
                  {tagPanelProj === p.id && projTags.length > 0 && (
                    <div className="session-tags-row" data-testid={`tag-row-${p.id}`}>
                      {projTags.map((tag) => (
                        <button
                          key={tag}
                          className={`session-tag-filter${activeTags.includes(tag) ? " active" : ""}`}
                          style={{ background: tagColor(tag) }}
                          onClick={() => toggleTagFilter(p.id, tag)}
                          data-testid={`tagfilter-${p.id}-${tag}`}
                          data-tooltip-id="md-tip"
                          data-tooltip-content={activeTags.includes(tag) ? t("sidebar.tagFilterActive") : t("sidebar.tagFilterIdle", { tag })}
                          data-tooltip-place="bottom"
                        >
                          {tag}
                        </button>
                      ))}
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
                    // #154 phase 2: the rename marker is state-typed. While the session is
                    // prompting it stays ahead of the title (persistent, as shipped in #154);
                    // when idle (statusBySession !== "prompting") it moves to the tail slot
                    // after the label, ahead of the meta cluster. One element, two mutually
                    // exclusive slots — node, size, color and tooltip are identical either way.
                    const renamedMark = s.customTitle ? (
                      <span
                        className="session-renamed"
                        data-tooltip-id="md-tip"
                        data-tooltip-content={t("sidebar.renamedTip")}
                        data-testid={`renamed-${s.id}`}
                      >
                        <Pencil size={10} />
                      </span>
                    ) : null;
                    return (
                      <div
                        key={s.id}
                        ref={kbdActive ? kbdActiveRef : undefined}
                        className={`session-item-row ${props.selectedSessionId === s.id ? "active" : ""}${kbdActive ? " kbd-active" : ""}${sel.has(s.id) ? " selected" : ""}`}
                        data-testid={`session-${s.id}`}
                        onContextMenu={(e) => openSessionMenu(e, s)}
                      >
                        {selMode && (
                          <button
                            type="button"
                            className={`session-check${sel.has(s.id) ? " checked" : ""}`}
                            role="checkbox"
                            aria-checked={sel.has(s.id)}
                            aria-label={displayTitle}
                            data-testid={`sel-${s.id}`}
                            onClick={(e) => { e.stopPropagation(); setSelMode(true); toggleSel(s.id); }}
                            data-tooltip-id="md-tip"
                            data-tooltip-content={t("sidebar.batchCheckTip")}
                          >
                            {sel.has(s.id) && <Check size={11} />}
                          </button>
                        )}
                        <button
                          className="session-item-main"
                          onClick={(e) => onSessionRowClick(e, s, p.id)}
                        >
                          <span className={`session-dot ${cls}`} data-tooltip-id="md-tip" data-tooltip-content={dotTip} />
                          {/* Prompting slot (#154 phase 2): marker ahead of the title —
                              constant for the whole turn. */}
                          {active && renamedMark}
                          <span className="session-label" {...labelTipProps}>{displayTitle}</span>
                          {/* Idle slot: title tail, ahead of the meta cluster (popout /
                              harness / pin / terminal / status). Same node, same appearance. */}
                          {!active && renamedMark}
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
                          {(() => {
                            const sch = props.scheduledBySession?.[s.id];
                            // Gate on "> now" too: between a schedule falling due and the
                            // next chat:queue snapshot arriving, the marker hides early
                            // instead of claiming a pending send that is about to fire.
                            if (!sch || sch.earliest <= Date.now()) return null;
                            // #162: within the due-soon window the chip pulses.
                            const dueSoon = sch.earliest - Date.now() <= DUE_SOON_MS;
                            return (
                              <span
                                className={`scheduled-indicator${dueSoon ? " is-due-soon" : ""}`}
                                data-tooltip-id="md-tip"
                                data-tooltip-content={t("sidebar.scheduledTip", { count: sch.count, time: formatDateTime(sch.earliest) })}
                                data-testid={`scheduled-${s.id}`}
                              >
                                <AlarmClock />
                              </span>
                            );
                          })()}
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
                  {(searching || activeTags.length) && list.length === 0 && (
                    <div className="session-search-empty">{t("sidebar.noMatch")}</div>
                  )}
                  {!searching && activeTags.length === 0 && hiddenCount > 0 && (
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

      {selMode && sel.size > 0 && (
        <div className="batch-bar" data-testid="batch-bar" role="toolbar" aria-label={t("sidebar.batchBarLabel")}>
          <span className="batch-count" data-testid="batch-count">{t("sidebar.batchCount", { count: sel.size })}</span>
          <span className="batch-acts">
            <button
              type="button"
              className={`batch-btn${selCopyFailed ? " failed" : ""}`}
              data-testid="batch-copy-dirs"
              onClick={() => void onBatchCopyDirs()}
              data-tooltip-id="md-tip"
              data-tooltip-content={selCopyFailed ? t("common.copyFailed") : t("sidebar.batchCopyDirsTip")}
            >
              {selCopied ? <Check size={13} /> : <Copy size={13} />}
              <span>{selCopied ? t("common.copied") : selCopyFailed ? t("common.copyFailed") : t("sidebar.batchCopyDirs")}</span>
            </button>
            <button
              type="button"
              className="batch-btn danger"
              data-testid="batch-delete"
              onClick={openBatchConfirm}
              data-tooltip-id="md-tip"
              data-tooltip-content={t("sidebar.batchDeleteTip")}
            >
              <Trash2 size={13} />
              <span>{t("sidebar.batchDelete")}</span>
            </button>
            <button
              type="button"
              className="icon-btn small"
              data-testid="batch-exit"
              onClick={exitSelMode}
              data-tooltip-id="md-tip"
              data-tooltip-content={t("sidebar.batchExit")}
            >
              <X size={13} />
            </button>
          </span>
        </div>
      )}

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
          {props.canForkSession?.(ctx.session) && props.onForkSession && (
            <button
              className="ctx-item"
              data-testid={`fork-session-${ctx.session.id}`}
              data-tooltip-id="md-tip"
              data-tooltip-content={t("sidebar.forkSessionTip")}
              onClick={() => { void props.onForkSession!(ctx.session.id); closeCtx(); }}
            >
              <GitFork size={13} /> {t("sidebar.forkSession")}
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
          {/* 标签 ›(#150):hover 展开的二级菜单。已有标签打勾 → 点击移除;
              输入框 Enter → 追加新标签(后端 NormalizeTags 兜底 trim/去重/上限)。
              数据一律读 liveSession(ctx 打开后的乐观更新直接反映,菜单不关,可连续增删)。 */}
          <div className="ctx-item ctx-has-sub" data-testid={`tags-menu-${ctx.session.id}`}>
            <Tag size={13} /> {t("sidebar.tags")}
            <div className="ctx-submenu">
              {(() => {
                const live = liveSession(ctx.session.id) ?? ctx.session;
                const tags = live.tags ?? [];
                return (
                  <>
                    {tags.length === 0 && (
                      <div className="ctx-submenu-empty" data-testid={`tags-empty-${ctx.session.id}`}>{t("sidebar.tagsEmpty")}</div>
                    )}
                    {tags.map((tag) => (
                      <button
                        key={tag}
                        className="ctx-item ctx-tag-item"
                        data-testid={`tag-remove-${ctx.session.id}-${tag}`}
                        data-tooltip-id="md-tip"
                        data-tooltip-content={t("sidebar.tagRemoveTip")}
                        data-tooltip-place="right"
                        onClick={() => props.onSetSessionTags(live.id, tags.filter((x) => x !== tag))}
                      >
                        <span className="ctx-tag-dot" style={{ background: tagColor(tag) }} />
                        <span className="ctx-tag-name">{tag}</span>
                        <Check size={12} className="ctx-tag-check" />
                      </button>
                    ))}
                    <div className="ctx-sep" />
                    <input
                      className="ctx-tag-input"
                      data-testid={`tag-new-input-${ctx.session.id}`}
                      placeholder={t("sidebar.tagNewPlaceholder")}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        e.preventDefault();
                        e.stopPropagation();
                        const val = e.currentTarget.value.trim();
                        if (!val) return;
                        const cur = liveSession(ctx.session.id)?.tags ?? [];
                        props.onSetSessionTags(ctx.session.id, [...cur, val]);
                        e.currentTarget.value = "";
                      }}
                    />
                  </>
                );
              })()}
            </div>
          </div>
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

      {confirm?.kind === "batch" && (
        <div className="modal-overlay" onClick={() => setConfirm(null)} onMouseDown={(e) => e.stopPropagation()}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-title">{t("sidebar.batchDeleteTitle", { count: confirm.items.length })}</div>
            <div className="modal-del-target">
              {confirm.items.slice(0, 3).map((it) => it.title).join(", ")}
              {confirm.items.length > 3 ? ` · ${t("sidebar.batchMore", { count: confirm.items.length - 3 })}` : ""}
            </div>
            <div className="modal-del-hint">{t("sidebar.batchDeleteHint")}</div>
            {deleteErr && <div className="modal-del-err">⚠ {deleteErr}</div>}
            <div className="modal-actions">
              <button className="modal-btn ghost" onClick={() => setConfirm(null)}>{t("common.cancel")}</button>
              <button
                className="modal-btn danger"
                data-testid="batch-delete-confirm"
                disabled={deleting}
                onClick={() => void onConfirmBatchDelete(confirm.items)}
              >
                {t("common.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
