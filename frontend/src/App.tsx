import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Events } from "@wailsio/runtime";
import * as ChatService from "../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import * as TerminalService from "../bindings/github.com/jessonchan/monkey-deck/internal/terminal/terminalservice";
import { Project, Session, Message } from "../bindings/github.com/jessonchan/monkey-deck/internal/store/models";
import type { ChatItem, ConfigOption, PermissionPrompt, ElicitationPrompt, SessionEvent, StatusPayload, QueueItem, Mention, ImageAttachment, AudioAttachment, PlanEntry, LivePlan, Usage, SlashCommand } from "./types";
import Sidebar from "./components/Sidebar";
import TabBar from "./components/TabBar";
import ChatView, { type ChatViewHandle } from "./components/ChatView";
import { Sparkles } from "lucide-react";
import SidePanel from "./components/SidePanel";
import TerminalPanel from "./components/TerminalPanel";
import FileTabBar, { type FileTab, tabKey } from "./components/FileTabBar";
import EditorPane from "./components/EditorPane";
import DiffPane from "./components/DiffPane";
import { clearScrollPosition } from "./components/CodeViewer";
import type { TerminalTab } from "./lib/terminalTypes";
import { disposeTerminal } from "./lib/termRegistry";
import NewSessionModal, { type NewSessionChoice } from "./components/NewSessionModal";
import SettingsPanel from "./components/SettingsPanel";
import DeleteWorktreeDialog from "./components/DeleteWorktreeDialog";
import CloseTabDialog from "./components/CloseTabDialog";
import type { Harness } from "../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef, type PanelImperativeHandle } from "react-resizable-panels";
import { Tooltip } from "react-tooltip";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Pin } from "lucide-react";
import type { FileChange, BranchInfo, WorktreeInfo } from "../bindings/github.com/jessonchan/monkey-deck/internal/worktree/models";
import { applyEventToItems as applyEventToItemsPure } from "./lib/streamMerge";
import { shouldDropOnSwitch } from "./lib/sessionDrop";
import { isNotifySoundEnabled, playNotifySound } from "./lib/notifySound";
import { extractErrMsg } from "./lib/errorMsg";
import { isMemorySaverEnabled } from "./lib/memorySaver";
import { deleteFilePanelState } from "./lib/filePanelCache";
import { routeDroppedFiles, type ReadImageFn } from "./lib/dropFiles";
const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
// Coarse pointer (touch) detection for the tooltip click-to-show equivalence.
// Evaluated once at module load — a desktop window never becomes touch mid-session.
const coarsePointer = typeof window !== "undefined" && typeof window.matchMedia === "function"
  && window.matchMedia("(pointer: coarse)").matches;

// readImageForDrop adapts ChatService.SessionReadImage to the ReadImageFn shape used
// by routeDroppedFiles (worktree-relative image → {dataUrl}). Injected so the pure
// router stays free of bindings and unit-testable.
const readImageForDrop: ReadImageFn = async (sessionId, rel) => {
  try {
    return await ChatService.SessionReadImage(sessionId, rel);
  } catch {
    return null;
  }
};

// parsePopoutHash 从 URL hash 读取 popout session ID(/#popout=<sid>)。
// 主窗口加载时 hash 为空(返回 null);popout 窗口由后端 OpenSessionWindow 创建时带上
// /#popout=<sid>,fragment 不发后端、前端 location.hash 读取后进入 popout 模式。
function parsePopoutHash(): string | null {
  const h = window.location.hash;
  const m = h.match(/[#&]popout=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// 按 session 隔离的状态:切走再切回时,进行中的流式输出 / 用量 / 状态 / 权限都保留在各自缓存里,
// 不会因「切走→事件被丢弃→切回只剩 DB 已落库内容」而丢失正在输出的内容。

const EMPTY_USAGE: Usage = { used: 0, size: 0, cost: 0, cachedReadTokens: 0, cachedWriteTokens: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 };

// 分页:首次打开只加载最近 PAGE_SIZE 条,滚到顶部点「加载更多」继续往前翻(游标 = 最旧 seq)。
const PAGE_SIZE = 30;

// buildAttachments 把三类用户输入归一成后端 SendMessage/InterruptAndSend 接受的 Attachment[]
// (与 internal/acp.Attachment 对齐)。显式带 Kind —— internal/acp/runner.go 的 attachmentBlock
// switch 据此选 ContentBlock 类型:
//   - mentions(@提及)/ 回形针文件 → "file" → ContentBlock::ResourceLink(协议 baseline,所有 agent MUST support)
//   - images                       → "image" → ContentBlock::Image(内联 base64,需 image 能力)
//   - audios                       → "audio" → ContentBlock::Audio(内联 base64,需 audio 能力)
// mentions 与回形针文件在 Composer.submit 已合并为同一个 mentions 数组(两者都 → ResourceLink,
// 协议无差别),此处统一带 kind:"file"。三处发送路径(sendMessage / drainSession / interruptQueue)
// 共用本 helper,避免 Kind 漂移(§5.3:重复 3 次再抽象)。
function buildAttachments(mentions?: Mention[], imgs?: ImageAttachment[], aus?: AudioAttachment[]) {
  return [
    ...(mentions || []).map((m) => ({ kind: "file", path: m.path, name: m.name })),
    ...(imgs || []).map((im) => ({ kind: "image", name: im.name, data: im.data, mimeType: im.mimeType })),
    ...(aus || []).map((au) => ({ kind: "audio", name: au.name, data: au.data, mimeType: au.mimeType })),
  ];
}

export default function App() {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [gitByProject, setGitByProject] = useState<Record<string, boolean>>({});
  const [branchBySession, setBranchBySession] = useState<Record<string, string>>({});
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, Session[]>>({});
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  // Multi-tab bar: ordered list of session ids the user has opened as tabs in the main window.
  // Explicit state (NOT derived from cache-map keys) — the memory saver drops idle sessions'
  // itemsBySession on switch, so deriving tabs from Object.keys(itemsBySession) would make tabs
  // "disappear" when their cache gets evicted. Tab semantics = "user opened it, hasn't closed it",
  // independent of whether its cache is currently resident in memory. §5.3: respect the data
  // source, don't derive from heuristics. Popout windows never show the tab bar, so they don't
  // maintain this state.
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  // popout 模式:本窗口是某 session 的独立窗口(由后端 OpenSessionWindow 创建,URL 带 #popout=<sid>)。
  // popout 模式下隐藏 Sidebar、启动时直接 openSession 目标 session、不处理 poppedSessionIds 过滤
  // (它是主窗口专属:主窗口对已 popout 的 session 视而不见,避免权限/状态/声音双弹)。
  const [popoutMode] = useState<string | null>(() => parsePopoutHash());
  const isPopout = !!popoutMode;
  // popout 窗口「始终置顶」状态(仅 popout 模式用;主窗口不需要)。
  const [onTop, setOnTop] = useState(false);
  // 主窗口模式:已弹出到独立窗口的 session 集合。全局事件处理器(status/permission/sound)
  // 对该集合内的 session 跳过 —— 一道过滤同时消灭「权限双弹、提示音双响、状态双反应」(§5.3 不变量)。
  const [poppedSessionIds, setPoppedSessionIds] = useState<Set<string>>(new Set());
  const poppedSessionIdsRef = useRef<Set<string>>(new Set());
  poppedSessionIdsRef.current = poppedSessionIds;

  const [itemsBySession, setItemsBySession] = useState<Record<string, ChatItem[]>>({});
  const [hasMoreBySession, setHasMoreBySession] = useState<Record<string, boolean>>({});
  const [loadingMoreBySession, setLoadingMoreBySession] = useState<Record<string, boolean>>({});
  const oldestSeqRef = useRef<Record<string, number>>({});
  const [usageBySession, setUsageBySession] = useState<Record<string, Usage>>({});
  const [statusBySession, setStatusBySession] = useState<Record<string, StatusPayload["status"] | "empty">>({});
  const [statusDetailBySession, setStatusDetailBySession] = useState<Record<string, string>>({});
  const [activityBySession, setActivityBySession] = useState<Record<string, "thinking" | "executing" | "replying">>({});
  const [unreadBySession, setUnreadBySession] = useState<Record<string, boolean>>({});
  const [permissionBySession, setPermissionBySession] = useState<Record<string, PermissionPrompt | null>>({});
  const [elicitationBySession, setElicitationBySession] = useState<Record<string, ElicitationPrompt | null>>({});
  const [error, setError] = useState<string | null>(null);
  // notice:非异常的温和提示(如 empty-turn:本轮无输出,但连接正常)。与 error 分开:
  // 蓝色而非红色,语义是「提示」不是「出错」。只对当前查看的 session 显示(同 error)。
  const [notice, setNotice] = useState<string | null>(null);
  const [queueBySession, setQueueBySession] = useState<Record<string, QueueItem[]>>({});  // 前端 FIFO 队列(按 session 隔离,切走保留)
  const [draftBySession, setDraftBySession] = useState<Record<string, string>>({});  // composer 草稿(按 session 隔离,切走保留)
  const [historyBySession, setHistoryBySession] = useState<Record<string, string[]>>({});  // 输入框历史(上下键翻):按 session 隔离,seed 自 DB + 每次发送追加
  const [attachmentsBySession, setAttachmentsBySession] = useState<Record<string, string[]>>({});  // composer 回形针附件(按 session 隔离,切走保留)
  const [mentionsBySession, setMentionsBySession] = useState<Record<string, Mention[]>>({});  // composer @提及(按 session 隔离,切走保留)
  const [imagesBySession, setImagesBySession] = useState<Record<string, ImageAttachment[]>>({});  // composer 内联图片附件(按 session 隔离,需 agent 支持 image 能力)
  const [audiosBySession, setAudiosBySession] = useState<Record<string, AudioAttachment[]>>({});  // composer 内联音频附件(按 session 隔离,需 agent 支持 audio 能力)
  const [imageSupportedBySession, setImageSupportedBySession] = useState<Record<string, boolean>>({});  // agent 是否声明 image prompt 能力(门控图片输入入口)
  const [audioSupportedBySession, setAudioSupportedBySession] = useState<Record<string, boolean>>({});  // agent 是否声明 audio prompt 能力(门控音频输入入口)
  const [configOptionsBySession, setConfigOptionsBySession] = useState<Record<string, ConfigOption[]>>({}); // model/mode/effort(agent 自报)
  const [commandsBySession, setCommandsBySession] = useState<Record<string, SlashCommand[]>>({}); // harness 自报斜杠命令(动态,available_commands_update;每 harness 不同)
  // 当前 turn 的实时 plan(进行中的 turn 由 plan 事件流式刷新;turn 结束转为持久化 plan item)。
  // 历史 turn 的 plan 不在这里 —— 它们作为 role='plan' message 持久化,重开会话时由
  // messagesToItems 转为 type:'plan' ChatItem 内联渲染。null = 当前无实时 plan。
  const [livePlanBySession, setLivePlanBySession] = useState<Record<string, LivePlan | null>>({});
  // Per-session file tabs (model A: each session owns the tabs it opened) +
  // active tab key: "chat" = ChatView, `file:<path>` = EditorPane, `diff:s|u:<path>`
  // = DiffPane. Replaces the old per-source modal overlays (FilePanel.preview / FilePreviewOverlay).
  const [fileTabsBySession, setFileTabsBySession] = useState<Record<string, FileTab[]>>({});
  const [activeFileTabBySession, setActiveFileTabBySession] = useState<Record<string, string>>({});
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  // 任一 harness 有新版 → 设置入口齿轮 + 设置内 harness 菜单亮红点(§设置入口/harness 菜单红点)。
  const harnessUpdateAvailable = useMemo(
    () => harnesses.some((h) => h.upgradeAvailable),
    [harnesses],
  );
  const [newSession, setNewSession] = useState<{ projectId: string; isGit: boolean; lastHarness: string; defaultBaseRef: string; recentRefs: string[]; branches: BranchInfo[]; worktrees: WorktreeInfo[]; initialBaseRef: string } | null>(null);  // new-chat modal
  // Owner-with-guests delete flow: when deleting an owner session whose worktree still has
  // guest chats, defer to a 3-option dialog (delete worktree + all/keep others). null = closed.
  const [deleteWt, setDeleteWt] = useState<{ sessionId: string; projectId: string; guests: Session[] } | null>(null);
  // Closing a still-generating tab ("prompting") is deferred to CloseTabDialog (stop vs detach).
  // null = no dialog pending.
  const [pendingCloseTab, setPendingCloseTab] = useState<{ sessionId: string; title: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false); // 统一设置中心面板(收敛语言/提示音/权限/harness)
  // 集成终端(per-session,与 agent ACP 通道完全分离;§1.1 agent 永远走 ACP)。
  // 终端面板开关也 per-session:session A 开着,切到 B 时 B 按自己的状态显示(各自独立)。
  const [termTabsBySession, setTermTabsBySession] = useState<Record<string, TerminalTab[]>>({});
  const [activeTermBySession, setActiveTermBySession] = useState<Record<string, string | null>>({});
  const [termOpenBySession, setTermOpenBySession] = useState<Record<string, boolean>>({});
  // 侧栏「已开终端」图标的权威状态:后端驱动(Start/Kill/退出推 terminal:state event,
  // 启动时查 ListTerminalsBySession 对账)。与 termOpenBySession(面板是否展开,本地 UI 态)
  // 解耦:面板可收起但终端仍活着(图标应亮);反之面板开着但终端已死(图标应灭)。
  const [hasTermBySession, setHasTermBySession] = useState<Record<string, boolean>>({});
  const termCwdRef = useRef("");
  const queueBySessionRef = useRef<Record<string, QueueItem[]>>({});
  // per-session 用户主动停止标记:Stop 该 session → 加入;该 session 下一个 idle/error 的
  // drainSession 消费一次性标记并跳过 auto-continue(队列保留)。per-session 化后,停 A 不再误抑制
  // B 的续发(原为全局 ref:停 A 后切走,B 的 idle 会被错误抑制或漏触发)。
  const userStoppedBySessionRef = useRef<Set<string>>(new Set());
  // per-session 竞态隔离:同一 session 的 drain 同时只允许一个在飞。SendMessage 是绑定调用,后端
  // runPrompt 在 goroutine 里跑,故绑定几乎立即返回、guard 仅短暂持有;但能挡住 idle/error 抖动或
  // 重复事件触发的并发 dequeue(防跳序 / 重发)。后端 busy 守卫是最终兜底。
  const drainingBySessionRef = useRef<Set<string>>(new Set());
  // 定时发送:per-session setTimeout 句柄。drainSession 发现队列里所有条目都未到点(scheduledAt 在
  // 未来)时,armScheduleTimer 按最早 scheduledAt 设一个一次性定时器,到点再触发 drainSession —— 否则
  // idle 状态下没有 idle 事件会触发、定时消息会静死。drainSession / scheduleQueueItem 改动队列后重 arm(enqueueMessage 只停车、不 arm)。
  const scheduledTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const drainSessionRef = useRef<(sid: string) => Promise<void>>(async () => {});
  // status 派生值的 ref:sendMessage 闭包锁 status 导致「prompting 时仍直发 → 后端报 busy」,
  // 用 ref 绕过 stale closure,读取最新的派生 status。
  const statusRef = useRef<string>("empty");

  // 选中项目的 sessions(派生);sessionsByProject 是全量按项目分组,供侧栏多项目同时展开。
  const sessions = (selectedProjectId ? sessionsByProject[selectedProjectId] : undefined) ?? [];

  // 标记哪些 session 已从 DB 加载进缓存;有缓存(含进行中的流式)就不再重读 DB,避免切回丢内容。
  const loadedSessionsRef = useRef<Set<string>>(new Set());
  // 输入框历史 seed 标记:避免 openSession 读 historyBySession(state)产生 stale closure,重开 session 误覆盖内存追加。
  const historySeededRef = useRef<Set<string>>(new Set());
  // config options 缓存 seed 标记:懒 spawn 只读态用持久化缓存渲染 ModelSelect,仅首次打开 seed
  // (活跃 session 的 config_option 事件会覆盖;切走再切回不重读 DB,保留内存中的直播值)。
  const configSeededRef = useRef<Set<string>>(new Set());
  // 选中 session 的 ref:仅用于 status 事件的「错误只弹当前查看会话」过滤,不进 effect 依赖(避免每次切换都重订阅)。
  const selectedSessionIdRef = useRef<string | null>(null);
  const chatViewRef = useRef<ChatViewHandle>(null);
  selectedSessionIdRef.current = selectedSessionId;
  // openTabs 的 ref:closeTab 需读「邻居」选下一个 tab,用 ref 读最新值避免把它进依赖
  // (每次 tab 增减都重建 closeTab 会牵连 TabBar 整树重渲染)。与 selectedSessionIdRef 同理。
  const openTabsRef = useRef<string[]>([]);
  openTabsRef.current = openTabs;
  // activeFileTabBySession 的 ref:⌘W handler 读它判断「先关 file/diff tab 还是关 session tab」,
  // 不进 effect 依赖(避免每次切 file tab 都重订阅 keydown)。与 selectedSessionIdRef 同理。
  const activeFileTabBySessionRef = useRef(activeFileTabBySession);
  activeFileTabBySessionRef.current = activeFileTabBySession;
  // sessionsByProject 的 ref:status 事件 handler 里查「session 属于哪个 project」用,
  // 不进 effect 依赖(避免每次 sessionsByProject 变化都重订阅事件)。
  const sessionsByProjectRef = useRef(sessionsByProject);
  sessionsByProjectRef.current = sessionsByProject;
  // sessions(选中项目派生列表)的 ref:⌘/Ctrl+1-9 handler 读它切第 N 个 session,
  // 不进 effect 依赖(避免每次 sessions 变化都重订阅 keydown)。与 sessionsByProjectRef 同理。
  const sessionsRef = useRef<Session[]>([]);
  sessionsRef.current = sessions;
  // livePlanBySession 的 ref:turn 结束(idle/error/closed)时读它把实时 plan 转为持久化
  // plan item append 进 itemsBySession。用 ref 绕开「在 setLivePlanBySession updater 内
  // 套 setItemsBySession」的嵌套 setState(StrictMode 下 updater 可能多次执行致重复 append)。
  const livePlanBySessionRef = useRef(livePlanBySession);
  livePlanBySessionRef.current = livePlanBySession;
  // projects / imageSupportedBySession 的 ref:chat:files-dropped handler 里查
  // 「被拖入的 session 的 cwd / 是否支持图片」用,不进 effect 依赖(避免每次变化都重订阅)。
  const projectsRef = useRef<Project[]>(projects);
  projectsRef.current = projects;
  const imageSupportedBySessionRef = useRef(imageSupportedBySession);
  imageSupportedBySessionRef.current = imageSupportedBySession;

  const refreshProjects = useCallback(async () => {
    const list = await ChatService.ListProjects();
    setProjects(list || []);
    // 加载项目级 hasGitContext 信息供 SCM 可见性判定(对齐 orca / VS Code repo-kind 判定,
    // 跟 session 是否有独立 worktree 解耦).RELAXED:wrapper 目录非 git 但子目录是 repo 也算,
    // 与 scmDir 的 FindSubRepo fallback 语义一致。每个项目探测一次,缓存到 gitByProject。
    // 注:worktree 门控(createSession)用 STRICT 的 IsGitProject,不是这个。
    if (list && list.length > 0) {
      const entries = await Promise.all(list.map(async (p) => {
        try { return [p.id, await ChatService.HasGitContext(p.id)] as [string, boolean]; }
        catch { return [p.id, false] as [string, boolean]; }
      }));
      setGitByProject(Object.fromEntries(entries));
    }
  }, []);

  const refreshSessions = useCallback(async (projectId: string, keepFields = false) => {
    const list = await ChatService.ListSessions(projectId);
    setSessionsByProject((prev) => {
      const cur = prev[projectId] ?? [];
      // keepFields(状态刷新用):DB 里 title 只在 turn 结束后回写(status prompting 触发时还是空),
      // 全量替换会洗掉前端现/会话元事件里已经拿到的标题,导致侧栏前端标题搜索中途失效。
      // 这里只把 DB 仍然有值的 title 覆盖过来,前端原值(= 直播拿到的标题)保留。
      if (keepFields && cur.length > 0) {
        const byId = new Map(cur.map((s) => [s.id, s]));
        const merged = (list || []).map((ns) => {
          const live = byId.get(ns.id);
          if (live && !ns.title && live.title) return { ...ns, title: live.title };
          return ns;
        });
        return { ...prev, [projectId]: merged };
      }
      return { ...prev, [projectId]: list || [] };
    });
  }, []);

  // 把一条 SessionEvent 合并进指定 session 的 items(纯函数,防乱序)。
  // 抽出到 lib/streamMerge.ts 便于单测流式段边界行为(§5.3)。
  const applyEventToItems = useCallback(applyEventToItemsPure, []);

  // 事件入口:总是写入「事件所属 session」的缓存(不再过滤 selectedSessionId),
  // 这样切走时进行中的流式仍累积在缓存里,切回即见。
  const applyEvent = useCallback((ev: SessionEvent) => {
    if (ev.kind === "usage_update") {
      setUsageBySession((prev) => {
        const old = prev[ev.sessionId] ?? EMPTY_USAGE;
        // 明细(cachedRead/Write/Input/Output/Thought/Total)仅 Prompt 返回后的事件携带,
        // streaming UsageUpdate 不含(全 0/undefined)→ 保留旧值,不覆盖(Task #15138)。
        const hasBreakdown = !!(ev.totalTokens || ev.inputTokens || ev.outputTokens || ev.cachedReadTokens || ev.cachedWriteTokens || ev.thoughtTokens);
        return {
          ...prev,
          [ev.sessionId]: {
            used: ev.used ?? old.used,
            size: ev.size ?? old.size,
            cost: ev.cost ?? old.cost,
            cachedReadTokens: hasBreakdown ? (ev.cachedReadTokens ?? 0) : old.cachedReadTokens,
            cachedWriteTokens: hasBreakdown ? (ev.cachedWriteTokens ?? 0) : old.cachedWriteTokens,
            inputTokens: hasBreakdown ? (ev.inputTokens ?? 0) : old.inputTokens,
            outputTokens: hasBreakdown ? (ev.outputTokens ?? 0) : old.outputTokens,
            thoughtTokens: hasBreakdown ? (ev.thoughtTokens ?? 0) : old.thoughtTokens,
            totalTokens: hasBreakdown ? (ev.totalTokens ?? 0) : old.totalTokens,
          },
        };
      });
      return;
    }
    if (ev.kind === "config_option") {
      // agent 自报的 config options(model/mode/effort),前端渲染下拉;切 model/effort 经 SetSessionConfigOption 回写。
      setConfigOptionsBySession((prev) => ({ ...prev, [ev.sessionId]: ev.configOptions ?? [] }));
      // 附带的 prompt 能力门控(前端据此决定是否展示对应输入入口,§3.5)。image/audio 随 config_option
      // 事件下发(对齐后端 SupportsImage/SupportsAudio)。embeddedContextSupported 已在 types 对齐,
      // 其内联附件入口的 state/门控逻辑留给后续任务实现。
      setImageSupportedBySession((prev) => (prev[ev.sessionId] === ev.imageSupported ? prev : { ...prev, [ev.sessionId]: !!ev.imageSupported }));
      setAudioSupportedBySession((prev) => (prev[ev.sessionId] === ev.audioSupported ? prev : { ...prev, [ev.sessionId]: !!ev.audioSupported }));
      return;
    }
    if (ev.kind === "available_commands") {
      // harness 自报斜杠命令(ACP available_commands_update,动态、随 harness 不同、非硬编码)。
      // 整表替换;切走再切回不重读(命令随 session 存活期常驻内存,事件覆盖最新全量)。
      setCommandsBySession((prev) => ({ ...prev, [ev.sessionId]: ev.commands ?? [] }));
      return;
    }
    if (ev.kind === "plan") {
      // agent 执行计划(ACP protocol:整表替换)。plan 按 turn 索引:当前 turn = 实时(livePlan,
      // 由 plan 事件整表刷新);turn 结束时后端把最终快照落库为 role='plan' message,重开会话时
      // 作为 type:'plan' ChatItem 内联渲染(历史静态展示)。空 entries 表示 agent 清空 plan。
      const entries = ev.planEntries ?? [];
      setLivePlanBySession((prev) => ({
        ...prev,
        [ev.sessionId]: entries.length > 0 ? { turnId: ev.turnId ?? "", entries } : null,
      }));
      return;
    }
    setItemsBySession((prev) => ({
      ...prev,
      [ev.sessionId]: applyEventToItems(prev[ev.sessionId] ?? [], ev),
    }));
  }, [applyEventToItems]);

  // 渲染用派生:取当前选中 session 的切片(无选中 → 空)。提前在事件订阅之前定义,使下方 callback 可读。
  const items = useMemo(
    () => (selectedSessionId ? itemsBySession[selectedSessionId] ?? [] : []),
    [itemsBySession, selectedSessionId]
  );
  const usage = (selectedSessionId ? usageBySession[selectedSessionId] : undefined) ?? EMPTY_USAGE;
  const status = (selectedSessionId ? statusBySession[selectedSessionId] : undefined) ?? "empty";
  useEffect(() => { statusRef.current = status; }, [status]);
  const statusDetail = (selectedSessionId ? statusDetailBySession[selectedSessionId] : undefined) ?? "";
  const permission = (selectedSessionId ? permissionBySession[selectedSessionId] : undefined) ?? null;
  const elicitation = (selectedSessionId ? elicitationBySession[selectedSessionId] : undefined) ?? null;
  // 侧栏状态指示用:哪些 session 正有待决权限。openSession 不再清权限(原 316 行会清掉 →
  // 切回该 session 卡片消失、再也点不到,只能等 5 分钟超时),故待决权限跨切换保留,切回仍可见。
  const permPendingBySession = useMemo(
    () => Object.fromEntries(Object.entries(permissionBySession).filter(([, v]) => v).map(([k]) => [k, true])) as Record<string, boolean>,
    [permissionBySession]
  );
  const hasMore = (selectedSessionId ? hasMoreBySession[selectedSessionId] : undefined) ?? false;
  const loadingMore = (selectedSessionId ? loadingMoreBySession[selectedSessionId] : undefined) ?? false;
  const queue = (selectedSessionId ? queueBySession[selectedSessionId] : undefined) ?? [];
  const history = (selectedSessionId ? historyBySession[selectedSessionId] : undefined) ?? [];
  const composerValue = (selectedSessionId ? draftBySession[selectedSessionId] : undefined) ?? "";
  const attachments = (selectedSessionId ? attachmentsBySession[selectedSessionId] : undefined) ?? [];
  const mentions = (selectedSessionId ? mentionsBySession[selectedSessionId] : undefined) ?? [];
  const images = (selectedSessionId ? imagesBySession[selectedSessionId] : undefined) ?? [];
  const audios = (selectedSessionId ? audiosBySession[selectedSessionId] : undefined) ?? [];
  const imageSupported = !!(selectedSessionId && imageSupportedBySession[selectedSessionId]);

  // Per-session file tabs (model A: tabs belong to the session that opened them).
  // activeFileTab is "chat" | a tabKey(): "chat" = ChatView, `file:<path>` = EditorPane,
  // `diff:s|u:<path>` = DiffPane (ChatView kept mounted, hidden via display:none —
  // composer draft/scroll/unread preserved). The tab row renders with ≥1 tab open.
  const fileTabs = (selectedSessionId ? fileTabsBySession[selectedSessionId] : undefined) ?? [];
  const activeFileTab = (selectedSessionId ? activeFileTabBySession[selectedSessionId] : undefined) ?? "chat";

  // Open a file as a tab in the active session's second row. If the path is
  // already open, just activate it (don't duplicate); otherwise append + activate.
  // `line` is stored as a hint — re-opening the same path from a different source
  // updates the line without reloading content (EditorPane keys off path).
  const openFileTab = useCallback((sessionId: string, path: string, line?: number) => {
    if (!sessionId) return;
    const key = tabKey({ kind: "file", path });
    setFileTabsBySession((prev) => {
      const cur = prev[sessionId] ?? [];
      // Match a FILE tab with this path (diff tabs are separate identities).
      const idx = cur.findIndex((t) => t.kind === "file" && t.path === path);
      if (idx >= 0) {
        // Update line hint in place (immutable copy) — keeps tab order stable.
        return { ...prev, [sessionId]: cur.map((t, i) => (i === idx ? { ...t, line } : t)) };
      }
      return { ...prev, [sessionId]: [...cur, { kind: "file", path, line }] };
    });
    setActiveFileTabBySession((prev) => ({ ...prev, [sessionId]: key }));
  }, []);
  // Open a file's git diff as a middle-column tab. `staged` selects index vs working
  // tree, so one path can have up to two distinct diff tabs (staged/unstaged) plus a
  // content tab — all coexist, keyed by tabKey. Re-opening just re-activates.
  const openDiffTab = useCallback((sessionId: string, path: string, staged: boolean) => {
    if (!sessionId) return;
    setFileTabsBySession((prev) => {
      const cur = prev[sessionId] ?? [];
      if (cur.some((t) => t.kind === "diff" && t.staged === staged && t.path === path)) {
        return prev;
      }
      return { ...prev, [sessionId]: [...cur, { kind: "diff", path, staged }] };
    });
    setActiveFileTabBySession((prev) => ({ ...prev, [sessionId]: tabKey({ kind: "diff", path, staged }) }));
  }, []);
  const selectFileTab = useCallback((sessionId: string, key: string) => {
    setActiveFileTabBySession((prev) => ({ ...prev, [sessionId]: key }));
  }, []);
  const closeFileTab = useCallback((sessionId: string, key: string) => {
    setFileTabsBySession((prev) => {
      const cur = prev[sessionId] ?? [];
      // Evict the saved CodeViewer scrollTop for this file so the module-level
      // Map doesn't leak (Task #24267). Only file tabs render CodeViewer (diff
      // tabs render DiffPane, which has no entry here). posKey MUST match the
      // key EditorPane passes as scrollKey = `${sessionId}/${file.path}`.
      // Lookup happens inside the updater to read the freshest tab list (the
      // callback closes over no state, deps are intentionally []); the delete
      // is idempotent so a StrictMode double-invoke of the updater is harmless.
      const closing = cur.find((t) => tabKey(t) === key);
      if (closing?.kind === "file") {
        clearScrollPosition(`${sessionId}/${closing.path}`);
      }
      const next = cur.filter((t) => tabKey(t) !== key);
      return { ...prev, [sessionId]: next };
    });
    setActiveFileTabBySession((prev) => {
      // If the closed tab was active, fall back to chat.
      if (prev[sessionId] === key) return { ...prev, [sessionId]: "chat" };
      return prev;
    });
  }, []);
  const audioSupported = !!(selectedSessionId && audioSupportedBySession[selectedSessionId]);
  const configOptions = (selectedSessionId ? configOptionsBySession[selectedSessionId] : undefined) ?? [];
  const commands = (selectedSessionId ? commandsBySession[selectedSessionId] : undefined) ?? [];
  const livePlan = (selectedSessionId ? livePlanBySession[selectedSessionId] : undefined) ?? null;
  const onComposerChange = useCallback((text: string) => {
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    setDraftBySession((prev) => ({ ...prev, [sid]: text }));
  }, []);
  const onAttachmentsChange = useCallback((next: string[]) => {
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    setAttachmentsBySession((prev) => ({ ...prev, [sid]: next }));
  }, []);
  const onMentionsChange = useCallback((next: Mention[]) => {
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    setMentionsBySession((prev) => ({ ...prev, [sid]: next }));
  }, []);
  const onImagesChange = useCallback((next: ImageAttachment[]) => {
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    setImagesBySession((prev) => ({ ...prev, [sid]: next }));
  }, []);
  const onAudiosChange = useCallback((next: AudioAttachment[]) => {
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    setAudiosBySession((prev) => ({ ...prev, [sid]: next }));
  }, []);

  // auto-continue:指定 session 的 turn 结束(idle/error)时,若非用户主动停且队列非空,自动发下一条
  // (FIFO)。每条排队消息 = 一个独立 turn,按序逐个发(协议无 queue,一次只一个 Prompt)。
  // 由 chat:status 事件直接按 sessionId 触发(§5.3 尊重数据源:status 事件携带 sessionId,是「哪个
  // session 该续发」的权威信号)——故后台(非选中)session 的队列也能自动续发,不再限于选中态。
  //
  // 定时发送(Task #22134):队列里 scheduledAt 在未来的条目「未到点跳过」,不阻塞后续已到点/无定时项
  // (扫描找第一条已到点的发)。全队都未到点 → 不发,armScheduleTimer 设定时器到点再触发(见上方 ref)。
  const drainSession = useCallback(async (sid: string) => {
    // 用户主动停止该 session:消费一次性标记,不自动续发(队列保留)。
    if (userStoppedBySessionRef.current.has(sid)) {
      userStoppedBySessionRef.current.delete(sid);
      return;
    }
    // per-session 竞态隔离:同一 session 已有 drain 在飞 → 跳过(防重复 dequeue)。
    if (drainingBySessionRef.current.has(sid)) return;
    const q = queueBySessionRef.current[sid] || [];
    if (q.length === 0) return;
    // 找第一条已到点(scheduledAt <= now)的;定时未到的跳过,不阻塞后续无定时项。
    const now = Date.now();
    const dueIdx = q.findIndex((it) => it.scheduledAt <= now);
    if (dueIdx < 0) {
      // 全队都是未来定时项:设定时器到最早 scheduledAt 再触发,队列静死。
      armScheduleTimer(sid);
      return;
    }
    drainingBySessionRef.current.add(sid);
    const next = q[dueIdx];
    queueBySessionRef.current = { ...queueBySessionRef.current, [sid]: q.filter((_, i) => i !== dueIdx) };
    setQueueBySession(queueBySessionRef.current);
    // error 条只对当前查看的 session 弹(后台 session 续发失败不打扰用户视图)。
    const isViewing = sid === selectedSessionIdRef.current;
    if (isViewing) { setError(null); setNotice(null); }
    setStatusBySession((prev) => ({ ...prev, [sid]: "prompting" }));
    try {
      await ChatService.SendMessage(sid, next.text, buildAttachments(next.mentions, next.images, next.audios));
    } catch (e) {
      if (isViewing) setError(extractErrMsg(e));
      setStatusBySession((prev) => ({ ...prev, [sid]: "idle" }));
    } finally {
      drainingBySessionRef.current.delete(sid);
      // 剩余条目可能仍是未来定时项 —— 重 arm 让到点时再发。
      armScheduleTimer(sid);
    }
  }, []);

  // armScheduleTimer:为指定 session 设一个一次性定时器,在「最早的未来 scheduledAt」触发 drainSession。
  // 幂等:先清该 session 既有定时器再重设。无未来定时项则清掉(不设)。用 drainSessionRef 解循环依赖。
  const armScheduleTimer = useCallback((sid: string) => {
    const ex = scheduledTimersRef.current[sid];
    if (ex) clearTimeout(ex);
    const q = queueBySessionRef.current[sid] || [];
    const now = Date.now();
    let earliest = 0;
    for (const it of q) {
      if (it.scheduledAt > now && (earliest === 0 || it.scheduledAt < earliest)) earliest = it.scheduledAt;
    }
    if (earliest > 0) {
      scheduledTimersRef.current[sid] = setTimeout(() => {
        delete scheduledTimersRef.current[sid];
        void drainSessionRef.current(sid);
      }, Math.min(earliest - now, 2_147_000_000));
    } else {
      delete scheduledTimersRef.current[sid];
    }
  }, []);
  drainSessionRef.current = drainSession;

  // 启动:加载项目 + 订阅事件。
  useEffect(() => {
    void refreshProjects();
    ChatService.ListHarnesses().then((h) => setHarnesses(h ?? [])).catch(() => {});
    // 后端异步发现 harness 完成后推 chat:harnesses 事件,据此重拉 enriched 列表(含版本/可升级)。
    const offHarnesses = Events.On("chat:harnesses", () => {
      ChatService.ListHarnesses().then((h) => setHarnesses(h ?? [])).catch(() => {});
    });
    const offUpdate = Events.On("chat:event", (e: { data: SessionEvent }) => {
      if (!e.data) return;
      applyEvent(e.data);
      // 细粒度活动相位(供侧栏状态点区分思考/执行/回复):取最近事件 kind。
      const k = e.data.kind;
      const sid = e.data.sessionId;
      let act: "thinking" | "executing" | "replying" | null = null;
      if (k === "agent_thought_chunk") act = "thinking";
      else if (k === "tool_call" || k === "tool_call_update") act = e.data.toolStatus === "completed" || e.data.toolStatus === "failed" ? "thinking" : "executing";
      else if (k === "agent_message_chunk") act = "replying";
      if (act) setActivityBySession((p) => (p[sid] === act ? p : { ...p, [sid]: act }));
    });
    const offPerm = Events.On("chat:permission", (e: { data: PermissionPrompt }) => {
      // 权限请求也按 session 缓存;切走再切回仍在。
      // 已弹出到独立窗口的 session:主窗口不弹权限(由 popout 窗口处理),避免双弹(§5.3 不变量)。
      if (e.data && !poppedSessionIdsRef.current.has(e.data.sessionId)) {
        setPermissionBySession((prev) => ({ ...prev, [e.data.sessionId]: e.data }));
      }
    });
    const offElicit = Events.On("chat:elicitation", (e: { data: ElicitationPrompt }) => {
      // elicitation 同 permission:按 session 缓存,popout 不双弹。
      if (e.data && !poppedSessionIdsRef.current.has(e.data.sessionId)) {
        setElicitationBySession((prev) => ({ ...prev, [e.data.sessionId]: e.data }));
      }
    });
    // 后端在「无用户操作」终结(超时降级 decline / ctx 取消)时推 resolved:清残留卡片,
    // 否则卡片最多残留 permTTL=5min,期间点击后端报 no pending(见 respondElicitation 的 try/catch)。
    const offElicitResolved = Events.On("chat:elicitation-resolved", (e: { data: { sessionId: string; id: string } }) => {
      if (!e.data) return;
      setElicitationBySession((prev) => (prev[e.data.sessionId]?.id === e.data.id ? { ...prev, [e.data.sessionId]: null } : prev));
    });
    const offStatus = Events.On("chat:status", (e: { data: StatusPayload }) => {
      const s = e.data;
      if (!s) return;
      // 懒 spawn:发消息触发的 spawn 会推 started(再紧跟 prompting)。不把活跃 turn 降级回 ready,
      // 避免「只读态发消息 → started 闪烁 → prompting」的瞬态(§3.x 懒 spawn)。
      setStatusBySession((prev) => {
        const cur = prev[s.sessionId];
        if (s.status === "started" && cur === "prompting") return prev;
        return { ...prev, [s.sessionId]: s.status };
      });
      setStatusDetailBySession((prev) => ({ ...prev, [s.sessionId]: s.detail || "" }));
      // 新 turn 开始:清掉上一轮的实时 plan(若残留)。历史 turn 的 plan 已作为 type:'plan'
      // ChatItem 持久化在 items 里,不受影响。agent 会在本 turn 重发 plan 事件刷新 livePlan。
      if (s.status === "prompting") {
        setLivePlanBySession((prev) => { if (!prev[s.sessionId]) return prev; const n = { ...prev }; delete n[s.sessionId]; return n; });
      }
      // 用户发消息(prompting)→ 即时刷新侧栏顺序。后端 startTurn 已把 prompted_at 刷为
      // now(主排序键),这里重拉让该 session 跳到顶部。后台活动(usage_update/标题同步)不
      // 走 status 事件,故侧栏不会被后台 session 抖动。
      // keepFields=true:DB 里 title 要 turn 结束才回写,全量替换会洗掉前端已有的
      // 直播标题,导致搜索中途失效——仅保留 DB 仍为空的 title 的原值。
      if (s.status === "prompting") {
        for (const pid of Object.keys(sessionsByProjectRef.current)) {
          if (sessionsByProjectRef.current[pid].some((x) => x.id === s.sessionId)) {
            void refreshSessions(pid, true);
            break;
          }
        }
      }
      // 错误提示只对当前查看的 session 弹(切走时不在意别的 session 的错误条)。
      // 已弹出到独立窗口的 session:主窗口不弹错误(由 popout 窗口处理),避免双弹。
      // 有 code 时按 code 经 i18n 翻译(harness 断连等稳定文案);否则用 detail;最后兜底。
      if (s.status === "error" && s.sessionId === selectedSessionIdRef.current && !poppedSessionIdsRef.current.has(s.sessionId)) {
        setError(s.code ? t(`chat.error.${s.code}`) : (s.detail || t("app.errorFallback")));
        setNotice(null); // 对称清 notice,避免旧 notice(蓝)与新 error(红)叠显
      }
      // notice(温和提示):非异常的零输出等,蓝色提示条。同 error 的 session/popup 门控。
      // code 经 i18n 翻译(chat.notice.*),detail 兜底。
      if (s.status === "notice" && s.sessionId === selectedSessionIdRef.current && !poppedSessionIdsRef.current.has(s.sessionId)) {
        setNotice(s.code ? t(`chat.notice.${s.code}`) : (s.detail || ""));
        setError(null); // 对称清 error,避免两条叠显
      }
      // 回合结束:清掉该 session 最后 agent/thought 的 streaming 标志(去光标 + 显复制按钮);
      // 同时把残留的中间态 tool(in_progress/pending)收口到终态 —— Prompt 正常返回(idle)
      // 意味着所有 tool 必然已完成;若最后的 tool_call_update(completed) 因时序/投递未到前端,
      // tool 会永远卡在「执行中」,重开 session 才恢复(治此 bug)。error/closed → failed。
      if (s.status === "idle" || s.status === "error" || s.status === "closed") {
        const toolFinal = s.status === "idle" ? "completed" : "failed";
        setItemsBySession((prev) => {
          const cur = prev[s.sessionId];
          if (!cur) return prev;
          return {
            ...prev,
            [s.sessionId]: cur.map((it) => {
              if (it.type === "agent" || it.type === "thought") return { ...it, streaming: false };
              if (it.type === "tool" && (it.status === "in_progress" || it.status === "pending")) return { ...it, status: toolFinal };
              return it;
            }),
          };
        });
        // turn 结束:把实时 plan 转为持久化 plan item(append 到 items 末尾,即 turn 末尾)。
        // 后端在 emit idle 前已把同样的快照落库为 role='plan' message,故重开会话时该 plan 会
        // 从 DB 自然加载;此处 eager-append 避免当前会话出现「plan 闪退」(livePlan 清掉到下次
        // 重载之间的空窗)。读 ref 而非在 updater 内套 setState(StrictMode 下 updater 可能
        // 多次执行)。turnID 来自 livePlan(由 plan 事件携带 = user message ID)。
        const lp = livePlanBySessionRef.current[s.sessionId];
        if (lp && lp.entries.length > 0) {
          setItemsBySession((prev) => {
            const cur = prev[s.sessionId] ?? [];
            // 兜底:若已有同 turnId 的 plan item(重复事件 / 重放),不重复 append。
            if (cur.some((it) => it.type === "plan" && it.turnId === lp.turnId)) return prev;
            return {
              ...prev,
              [s.sessionId]: [...cur, {
                type: "plan" as const,
                id: `live-plan-${lp.turnId}`,
                turnId: lp.turnId,
                entries: lp.entries,
                ts: Date.now(),
              }],
            };
          });
        }
        setLivePlanBySession((prev) => { if (!prev[s.sessionId]) return prev; const n = { ...prev }; delete n[s.sessionId]; return n; });
        setActivityBySession((p) => { if (!p[s.sessionId]) return p; const n = { ...p }; delete n[s.sessionId]; return n; });
      }
      // 回合结束后刷新 Git 面板的 diff(agent 可能改了文件)
      if (s.status === "idle") {
        // 对话结束提示音:仅在 agent 自然回合结束(detail 以 stopReason= 开头,§5.3 尊重数据源
        // —— 区分「回复完成」与「用户取消 cancelled / 兜底空 detail」)且开关开启时播放。
        // 已弹出到独立窗口的 session:主窗口不发声(由 popout 窗口发声),避免叠音。
        if (s.detail && s.detail.startsWith("stopReason=") && isNotifySoundEnabled() && !poppedSessionIdsRef.current.has(s.sessionId)) {
          playNotifySound();
        }
        // 未读:回合结束但用户没在看的 session → 标记未读(供侧栏尾部小圆点提示)。
        if (s.sessionId !== selectedSessionIdRef.current) setUnreadBySession((p) => ({ ...p, [s.sessionId]: true }));
        const sid = selectedSessionIdRef.current;
        if (sid) { ChatService.SessionDiff(sid).then(d => setSessionDiff(d || "")).catch(() => {}); ChatService.SessionChanges(sid).then(setSessionChanges).catch(() => {}); ChatService.SessionMergeable(sid).then(m => setMergeableBySession((p) => ({ ...p, [sid]: m }))).catch(() => {}); }
      }
      // auto-continue:turn 结束(idle/error)→ 续发该 session 队列下一条(不限选中态,§1.6)。
      // 由 status 事件按 sessionId 直接触发(尊重数据源:status 事件是「哪个 session 该续发」的权威
      // 信号),后台 session 的队列也能自动续发。closed = idle reaper 回收,session 已关,不续发。
      // 用户主动停则 drainSession 内部按 per-session 标记跳过(队列保留)。
      // notice = 非异常空 turn(end_turn,连接正常),语义等同 idle —— 续发排队消息。
      if (s.status === "idle" || s.status === "error" || s.status === "notice") {
        void drainSession(s.sessionId);
      }
    });
    const offMeta = Events.On("chat:session-meta", (e: { data: { sessionId: string; title: string } }) => {
      const m = e.data;
      if (!m || !m.title) return;
      setSessionsByProject((prev) => {
        const next = { ...prev };
        for (const pid of Object.keys(next)) {
          const idx = next[pid].findIndex((s) => s.id === m.sessionId);
          if (idx >= 0) { const arr = [...next[pid]]; arr[idx] = { ...arr[idx], title: m.title }; next[pid] = arr; }
        }
        return next;
      });
    });
    // Remote client reconnect (§1.8): custom.js dispatches remote:resync on every
    // WS (re)connect so a phone that slept / roamed networks reconciles with the
    // desktop process. Desktop never sees it (custom.js 404s there). Re-pull the
    // server-side snapshots only — live streaming state is intentionally not
    // replayed (WS reconnects resync, never backfill).
    const offResync = Events.On("remote:resync", () => {
      void refreshProjects();
      ChatService.ListHarnesses().then((h) => setHarnesses(h ?? [])).catch(() => {});
      for (const pid of Object.keys(sessionsByProjectRef.current)) {
        void refreshSessions(pid, true);
      }
      // A reconnect implies a possible EVENT GAP, and the open conversation's
      // tail exists only in the desktop's memory — lists alone leave a frozen
      // partial message on the phone until manual re-entry (user report).
      // Force a DB reload via the same path as the switch-away cache drop.
      // Guard: only when this session was already loaded (first WS connect
      // rides along initial boot — skip to avoid a double load).
      const sid = selectedSessionIdRef.current;
      if (sid && loadedSessionsRef.current.has(sid)) {
        loadedSessionsRef.current.delete(sid);
        void openSessionRef.current(sid);
      }
    });
    // OS file drag-and-drop onto the chat area (Task #24255 / #83): the backend
    // (internal/chat/drop.go) forwards native drop paths + the target session id
    // (data-md-session on .chat-view). Route each path: worktree-internal non-image
    // → @mention, internal ACP-image → inline image, external → paperclip attachment.
    // Window scoping: popout windows only handle their own session; the main window
    // skips sessions that are currently popped out (the popout owns them then), so a
    // drop is handled by exactly the window showing that session.
    const offDrop = Events.On("chat:files-dropped", (e: { data: { files: string[]; sessionId: string } }) => {
      const sid = e.data?.sessionId;
      const files = e.data?.files;
      if (!sid || !Array.isArray(files) || files.length === 0) return;
      if (isPopout) {
        if (sid !== popoutMode) return; // popout only handles its own session
      } else if (poppedSessionIdsRef.current.has(sid)) {
        return; // main window defers to the popout that owns this session
      }
      // Resolve the session + its project to find the cwd (= worktreePath || path),
      // mirroring the backend cwdOf so internal @mentions / SessionReadImage line up.
      let sess: Session | undefined;
      for (const list of Object.values(sessionsByProjectRef.current)) {
        const f = list.find((x) => x.id === sid);
        if (f) { sess = f; break; }
      }
      if (!sess) return;
      const proj = projectsRef.current.find((p) => p.id === sess!.projectId);
      const root = sess.worktreePath || proj?.path || "";
      if (!root) return;
      const imageSupported = !!imageSupportedBySessionRef.current[sid];
      void routeDroppedFiles(files, { root, imageSupported, sessionId: sid }, readImageForDrop).then((r) => {
        if (r.mentions.length > 0) {
          setMentionsBySession((prev) => ({ ...prev, [sid]: [...(prev[sid] ?? []), ...r.mentions] }));
          // Append the "@<path> " tokens so submit's inline-filter keeps the mentions
          // (Composer keeps a mention only while its @token is still in the draft).
          setDraftBySession((prev) => ({ ...prev, [sid]: (prev[sid] ?? "") + r.mentionText }));
        }
        if (r.attachments.length > 0) {
          setAttachmentsBySession((prev) => ({ ...prev, [sid]: [...(prev[sid] ?? []), ...r.attachments] }));
        }
        if (r.images.length > 0) {
          setImagesBySession((prev) => ({ ...prev, [sid]: [...(prev[sid] ?? []), ...r.images] }));
        }
      }).catch(() => { /* routing/image-read failure: silent (best-effort, like paste) */ });
    });
    return () => {
      offUpdate();
      offPerm();
      offElicit();
      offElicitResolved();
      offStatus();
      offMeta();
      offHarnesses();
      offDrop();
      offResync();
    };
  }, [refreshProjects, applyEvent, refreshSessions, drainSession, isPopout, popoutMode]);

  // popout 启动标记:目标 session 在本 popout 窗口 open 成功后置 true(快照 effect 据此触发)。
  // 用 state 而非 ref:快照还原 effect 依赖它——openSession 异步完成后 state 变化触发 effect 重跑。
  const [popoutOpened, setPopoutOpened] = useState(false);
  // popout 快照还原:popout 窗口 boot 时从后端取主窗口打包的 React state 快照,
  // 作为初始 state(items/queue/draft/livePlan/permission)。取后即删(一次性)。
  // 仅在 popout 模式且目标 session 已 open 后执行一次。
  const snapshotAppliedRef = useRef(false);
  useEffect(() => {
    if (!popoutMode || !popoutOpened || snapshotAppliedRef.current) return;
    snapshotAppliedRef.current = true;
    ChatService.GetSessionSnapshot(popoutMode).then((json) => {
      if (!json) return;
      try {
        const snap = JSON.parse(json);
        // items:若有进行中的流式 turn,直接灌入(覆盖 SQLite 加载的已落库部分)。
        if (Array.isArray(snap.items) && snap.items.length > 0) {
          setItemsBySession((prev) => ({ ...prev, [popoutMode]: snap.items }));
        }
        if (Array.isArray(snap.queue)) setQueueBySession((prev) => ({ ...prev, [popoutMode]: snap.queue }));
        if (typeof snap.draft === "string") setDraftBySession((prev) => ({ ...prev, [popoutMode]: snap.draft }));
        if (snap.livePlan) setLivePlanBySession((prev) => ({ ...prev, [popoutMode]: snap.livePlan }));
        if (snap.permission) setPermissionBySession((prev) => ({ ...prev, [popoutMode]: snap.permission }));
        if (snap.elicitation) setElicitationBySession((prev) => ({ ...prev, [popoutMode]: snap.elicitation }));
        // 终端:恢复面板开关 + tab 列表 + active tab。tab.id 指向后端同一 PTY;
        // termRegistry 会为每个 id 新建 xterm(独立 JS 上下文),订阅同一 terminal:data。
        // scrollback 历史:TerminalView mount → useTerminal → acquireTerminal 时由 ring buffer replay
        // (在 acquireTerminal 里调 GetTerminalScrollback 灌入历史)。
        if (snap.termOpen) {
          setTermOpenBySession((prev) => ({ ...prev, [popoutMode]: true }));
          if (Array.isArray(snap.termTabs)) setTermTabsBySession((prev) => ({ ...prev, [popoutMode]: snap.termTabs }));
          if (snap.activeTerm) setActiveTermBySession((prev) => ({ ...prev, [popoutMode]: snap.activeTerm }));
        }
      } catch { /* 快照格式异常:静默回退 SQLite */ }
    }).catch(() => {});
  }, [popoutMode, popoutOpened]);

  // 主窗口:订阅 popout 状态变更,维护 poppedSessionIds 集合。
  // popout 窗口不订阅(isPopout 时跳过)——它不需要过滤(它就是那个唯一在看的窗口)。
  useEffect(() => {
    if (isPopout) return;
    const offPopout = Events.On("chat:popout-changed", (e: { data: { sessionId: string; popped: boolean } }) => {
      const { sessionId, popped } = e.data;
      setPoppedSessionIds((prev) => {
        const next = new Set(prev);
        if (popped) next.add(sessionId); else next.delete(sessionId);
        return next;
      });
      // Closing a popout window restores the session back into the main window's tab strip —
      // the same "bring it back to main" restore path the popout feature had before tabs existed.
      // The main window resumes rendering/handling it (poppedSessionIds just dropped it above);
      // re-registering it as a tab makes that visible instead of leaving the user to hunt the sidebar.
      if (!popped) setOpenTabs((prev) => (prev.includes(sessionId) ? prev : [...prev, sessionId]));
    });
    return () => { offPopout(); };
  }, [isPopout]);

  // 主窗口 boot 对账:覆盖「主窗口重启但 popout 窗口仍开着」的场景。
  // sessionsByProject 就绪后,对每个 session 查后端是否已 popout,同步进 poppedSessionIds。
  // 仅执行一次(hasReconciled 守卫),后续由 popout-changed 事件实时维护。
  const popoutReconciledRef = useRef(false);
  useEffect(() => {
    if (isPopout || popoutReconciledRef.current) return;
    const allSids = Object.values(sessionsByProject).flat().map((s) => s.id);
    if (allSids.length === 0) return;
    popoutReconciledRef.current = true;
    void Promise.all(allSids.map((sid) => ChatService.IsSessionWindowPopped(sid).then((p) => [sid, p] as const)))
      .then((res) => {
        const popped = res.filter(([, p]) => p).map(([sid]) => sid);
        if (popped.length > 0) setPoppedSessionIds(new Set(popped));
      }).catch(() => {});
  }, [isPopout, sessionsByProject]);

  // 多项目同时展开:项目列表就绪后,把每个项目的 sessions 都加载进 map(本地 SQLite,快)。
  useEffect(() => {
    for (const p of projects) {
      if (!(p.id in sessionsByProject)) void refreshSessions(p.id);
    }
  }, [projects, sessionsByProject, refreshSessions]);

  // 把持久化消息转成展示 items。
  const messagesToItems = useCallback((msgs: Message[]): ChatItem[] => {
    return msgs.map((m): ChatItem => {
      if (m.role === "user") return { type: "user", id: m.id, text: m.content, ts: m.createdAt };
      if (m.role === "agent") return { type: "agent", id: m.id, text: m.content, ts: m.createdAt };
      if (m.role === "thought") return { type: "thought", id: m.id, text: m.content, ts: m.createdAt };
      if (m.role === "plan") {
        // 历史 turn 的 plan 快照(role='plan' message,turn 结束时后端落库)。
        // content 是 JSON 序列化的 []PlanEntry;toolCallId 列存 turnID(= user message ID)。
        // 解析失败兜底为空 entries(不阻塞历史加载)。
        let entries: PlanEntry[] = [];
        try { entries = JSON.parse(m.content) as PlanEntry[]; } catch { entries = []; }
        return { type: "plan", id: m.id, turnId: m.toolCallId || "", entries, ts: m.createdAt };
      }
      let title = "";
      let status = "";
      let kind = "";
      let rawInput: unknown;
      let rawOutput: unknown;
      try {
        const parsed = JSON.parse(m.content) as { title?: string; status?: string; kind?: string; rawInput?: unknown; rawOutput?: unknown };
        title = parsed.title || "";
        status = parsed.status || "";
        kind = parsed.kind || "";
        rawInput = parsed.rawInput;
        rawOutput = parsed.rawOutput;
      } catch {
        title = m.content;
      }
      return { type: "tool", id: m.toolCallId || m.id, title, status, kind, rawInput, rawOutput, ts: m.createdAt };
    });
  }, []);

  // 选项目 → 加载 sessions。per-session 缓存按 sessionId 隔离(全局唯一),切项目**不清空**:
  // 事件处理器(chat:event / chat:status / chat:permission)均按「事件所属 sessionId」写缓存,
  // 与当前选中无关,故旧项目的残留不会泄漏进新项目视图(selectedSessionId=null 时派生视图全空)。
  // 侧栏可同时展开多项目,各 session 状态点都从 statusBySession 取 —— 清空会让进行中的 session
  // 丢失 prompting 状态(后端一轮只发一次 prompting,无新事件补回),表现为「仍在输出但状态为空闲」。
  const selectProject = useCallback(
    async (projectId: string) => {
      setSelectedProjectId(projectId);
      setSelectedSessionId(null);
      await refreshSessions(projectId);
    },
    [refreshSessions]
  );

  // 打开 session:OpenSession + 加载历史。projectId 用于多展开时点开他项目会话一并切到该项目。
  // 关键:有缓存(含进行中的流式)就保留缓存,仅首次打开才从 DB 读 —— 否则切回会丢正在输出的内容。
  const openSession = useCallback(
    async (sessionId: string, projectId?: string) => {
      // Mobile drawer (M2): opening a session means the user is done browsing
      // and wants the chat — dismiss the drawer. This is the SINGLE close
      // trigger tied to navigation; browsing actions inside the drawer
      // (select project, add project, settings, new-session modal) keep it
      // open. No-op on desktop (drawerOpen is false there and React bails).
      setDrawerOpen(false);
      const pid = projectId ?? selectedProjectId;
      // 切走丢弃(内存优化,docs/worklog/2026-07-18-drop-session-items-on-switch.md):
      // 由「节省内存」设置开关控制(isMemorySaverEnabled,默认开)——内存不敏感的用户可在
      // 设置中心 → 对话 里关掉,关闭后保留所有已开会话缓存(切换瞬开,但内存随 session 数累积)。
      // 开启时:从 old 切到 new 若 old 空闲(非 prompting),丢掉 old 的 items 缓存,让 WebKit heap 可回收。
      // 活跃(prompting)session 保护——流式事件还在往 itemsBySession[old] 灌,丢了会丢内容。
      // 切回时 loadedSessionsRef 已删 → 走下方重载分支从 DB 拉回(idx_messages_session 索引,毫秒级)。
      // 滚动位置在 ChatView 的 scrollStateRef(按 sessionId 记忆),与 itemsBySession 解耦,不丢。
      // composer 状态(draft/history/attachments/mentions/images/queue)本就是"切走保留",不动。
      const oldSession = selectedSessionIdRef.current;
      if (isMemorySaverEnabled() && oldSession && shouldDropOnSwitch(oldSession, sessionId, statusRef.current)) {
        loadedSessionsRef.current.delete(oldSession);
        delete oldestSeqRef.current[oldSession];
        setItemsBySession((prev) => {
          if (!prev[oldSession]) return prev;
          const next = { ...prev };
          delete next[oldSession];
          return next;
        });
        setHasMoreBySession((prev) => {
          if (!(oldSession in prev)) return prev;
          const next = { ...prev };
          delete next[oldSession];
          return next;
        });
      }
      if (projectId && projectId !== selectedProjectId) setSelectedProjectId(projectId);
      setSelectedSessionId(sessionId);
      // Multi-tab: register this session as an open tab in the main window. openSession is the
      // single choke point for "open a session" (sidebar click, tab click, popout boot), so
      // registering here means every entry path auto-tracks the tab. Skip popout windows (they
      // don't render the tab bar and shouldn't maintain openTabs).
      if (!isPopout) setOpenTabs((prev) => (prev.includes(sessionId) ? prev : [...prev, sessionId]));
      setUnreadBySession((prev) => { if (!prev[sessionId]) return prev; const n = { ...prev }; delete n[sessionId]; return n; });
      userStoppedBySessionRef.current.delete(sessionId);
      setError(null); setNotice(null);
      await ChatService.OpenSession(sessionId);
      // 从持久化的 session 用量恢复 token 占比(无 live 记录时),使重开会话不归零(§1.6)。
      const se = (pid ? sessionsByProject[pid] : undefined)?.find((x) => x.id === sessionId);
      setUsageBySession((prev) => {
        if (prev[sessionId]) return prev;
        return { ...prev, [sessionId]: {
          used: se?.usedTokens ?? 0, size: se?.sizeTokens ?? 0, cost: se?.cost ?? 0,
          cachedReadTokens: se?.cachedReadTokens ?? 0, cachedWriteTokens: se?.cachedWriteTokens ?? 0,
          inputTokens: se?.inputTokens ?? 0, outputTokens: se?.outputTokens ?? 0,
          thoughtTokens: se?.thoughtTokens ?? 0, totalTokens: se?.totalTokens ?? 0,
        } };
      });
      if (!loadedSessionsRef.current.has(sessionId)) {
        loadedSessionsRef.current.add(sessionId);
        const msgs = await ChatService.LoadMessagesPage(sessionId, 0, PAGE_SIZE);
        const hasMorePage = (msgs?.length || 0) > PAGE_SIZE;
        const page = hasMorePage ? msgs!.slice(1) : (msgs || []);
        if (page.length > 0) oldestSeqRef.current[sessionId] = page[0].seq;
        setItemsBySession((prev) => ({ ...prev, [sessionId]: messagesToItems(page) }));
        setHasMoreBySession((prev) => ({ ...prev, [sessionId]: hasMorePage }));
      }
      // 输入框历史 seed:从 DB 取全部用户消息(无长度限制),供上下键翻历史。
      // 仅首次打开 seed(后续本会话的发送由 sendMessage 追加,不覆盖)。用 ref 守卫避免 stale closure。
      if (!historySeededRef.current.has(sessionId)) {
        historySeededRef.current.add(sessionId);
        try {
          const hist = await ChatService.ListUserMessages(sessionId);
          setHistoryBySession((prev) => ({ ...prev, [sessionId]: hist || [] }));
        } catch { setHistoryBySession((prev) => ({ ...prev, [sessionId]: [] })); }
      }
      // 懒 spawn config options 缓存 seed:只读态(懒 spawn 未活跃)用持久化缓存渲染 ModelSelect,
      // 避免 configOptions 为空 → ModelSelect return null(§3.x)。仅首次打开 seed;活跃 session 的
      // config_option 事件会覆盖此缓存(spawn 后推送最新全量)。
      if (!configSeededRef.current.has(sessionId)) {
        configSeededRef.current.add(sessionId);
        try {
          const cached = await ChatService.GetSessionCachedConfigOptions(sessionId);
          // bindings 的 ConfigOption.options 是 `[] | null`(Go nil slice → JSON null),
          // 本地 types.ts 的 ConfigOption.options 是非空数组(渲染层假设非空)。此处归一化:null → []。
          if (cached && cached.length > 0) {
            const normalized: ConfigOption[] = cached.map((c) => ({ ...c, options: c.options ?? [] }));
            setConfigOptionsBySession((prev) => (prev[sessionId] ? prev : { ...prev, [sessionId]: normalized }));
          }
        } catch { /* 无缓存或读取失败:静默,等 spawn 推送 */ }
      }
      try {
        const diff = await ChatService.SessionDiff(sessionId);
        setSessionDiff(diff || "");
      } catch {
        setSessionDiff("");
      }
      try {
        setSessionChanges(await ChatService.SessionChanges(sessionId));
      } catch { setSessionChanges(null); }
      // 源代码管理面板的分支展示:读真实 HEAD(worktree 模式 = md/<id>;非 worktree git 项目 = 项目目录当前分支)。
      // session.Branch 仅 worktree 模式有值,非 worktree 恒空 —— 直接用它会在非 worktree 的 git 项目里显示空分支。
      try {
        const br = await ChatService.SessionCurrentBranch(sessionId);
        setBranchBySession((prev) => ({ ...prev, [sessionId]: br || "" }));
      } catch { /* 非 git 项目:保持空 */ }
      // 合并预检:branch 有无领先基线的已提交 commit → 决定合并按钮 enable/disable。
      // 打开/切到 session 时查一次;turn 结束后由事件刷新点(见 onStatusChanged)重查。
      try {
        const mergeable = await ChatService.SessionMergeable(sessionId);
        setMergeableBySession((prev) => ({ ...prev, [sessionId]: mergeable }));
      } catch { /* 非 git session:保持 false */ }
      // worktree 身份:guest 的合并按钮要禁用 + 给「无权合并」提示(owner/project 正常)。
      try {
        const kind = await ChatService.WorktreeKind(sessionId);
        setWorktreeKindBySession((prev) => ({ ...prev, [sessionId]: kind }));
      } catch { /* keep absent → treat as project */ }
    },
    [messagesToItems, selectedProjectId, sessionsByProject]
  );
  // Late-bound handle for the mount effect's remote:resync handler (declared
  // before openSession; a ref avoids both TDZ and stale-closure traps).
  const openSessionRef = useRef(openSession);
  openSessionRef.current = openSession;

  // popout 模式启动:本窗口是某 session 的独立窗口,直接打开目标 session。
  // projectId 从后端 GetSessionProjectID 拿(不依赖 sessionsByProject 的加载时序——
  // 后者可能因分页/项目数多而延迟,导致 popout 拿不到 projectId → SidePanel 空 + sendMessage 异常)。
  useEffect(() => {
    if (!popoutMode || popoutOpened) return;
    void (async () => {
      let pid: string | undefined;
      try { pid = await ChatService.GetSessionProjectID(popoutMode); } catch { /* session 不存在 */ }
      if (pid) { void openSession(popoutMode, pid); setPopoutOpened(true); }
    })();
  }, [popoutMode, openSession, popoutOpened]);
  const loadMoreMessages = useCallback(async (sessionId: string) => {
    if (loadingMoreBySession[sessionId] || !hasMoreBySession[sessionId]) return;
    setLoadingMoreBySession((prev) => ({ ...prev, [sessionId]: true }));
    try {
      const beforeSeq = oldestSeqRef.current[sessionId] || 0;
      const msgs = await ChatService.LoadMessagesPage(sessionId, beforeSeq, PAGE_SIZE);
      const hasMorePage = (msgs?.length || 0) > PAGE_SIZE;
      const page = hasMorePage ? msgs!.slice(1) : (msgs || []);
      if (page.length > 0) oldestSeqRef.current[sessionId] = page[0].seq;
      setItemsBySession((prev) => ({
        ...prev,
        [sessionId]: [...messagesToItems(page), ...(prev[sessionId] || [])],
      }));
      setHasMoreBySession((prev) => ({ ...prev, [sessionId]: hasMorePage }));
    } finally {
      setLoadingMoreBySession((prev) => ({ ...prev, [sessionId]: false }));
    }
  }, [loadingMoreBySession, hasMoreBySession, messagesToItems]);

  // 新建 session:先弹窗让用户选 harness + 是否建 worktree;projectId 为空时用当前选中项目。
  // harness 默认选中上次新建对话用的(后端 lastHarness setting,§5.3 本地是真相来源),照抄 worktree 的
  // 「弹窗打开时预取依赖值放进 newSession 状态、作为 prop 传给 modal」范式。
  const createSession = useCallback(async (projectId?: string, initialBaseRef?: string) => {
    const pid = projectId ?? selectedProjectId;
    if (!pid) return;
    try {
      // 预取:isGit(STRICT,决定 worktree 选项是否显示;非 git 项目不能建 worktree,§1.4)
      // + lastHarness(预选 harness)
      // + 默认基线 + 分支列表(仅 git 项目需要,worktree=true 时的基线选择器用)。
      // 注:SCM 面板可见性用放宽的 HasGitContext,这里 worktree 门控必须严格。
      const [isGit, lastHarness] = await Promise.all([
        ChatService.IsGitProject(pid),
        ChatService.GetLastHarness(),
      ]);
      let defaultBaseRef = "";
      let recentRefs: string[] = [];
      let branches: BranchInfo[] = [];
      let worktrees: WorktreeInfo[] = [];
      if (isGit) {
        // Prefetch everything the modal's two selectors need:
        //   defaultBaseRef/recentRefs/branches → "new worktree" base-ref selector;
        //   worktrees → "use existing directory" selector (project main + linked worktrees).
        const [def, list, recent, wts] = await Promise.all([
          ChatService.ResolveBaseRefDefault(pid).catch(() => ({ baseRef: "", ok: false })),
          ChatService.SearchBaseRefs(pid).catch(() => []),
          ChatService.RecentBaseRefs(pid).catch(() => []),
          ChatService.ListWorktrees(pid).catch(() => []),
        ]);
        defaultBaseRef = def?.ok ? def.baseRef : "";
        branches = list || [];
        recentRefs = recent || [];
        worktrees = wts || [];
      }
      setNewSession({ projectId: pid, isGit, lastHarness, defaultBaseRef, recentRefs, branches, worktrees, initialBaseRef: initialBaseRef ?? "" });
    } catch (e) {
      setError(extractErrMsg(e));
    }
  }, [selectedProjectId]);

  // Composer branch chip → open the new-session modal straight in "new worktree" mode
  // with this branch prefilled as the base (fork a fresh md/<id> off it). Bound to the
  // currently selected project (the Composer only renders for the active session's project).
  const onNewSessionOnBranch = useCallback((branch: string) => {
    void createSession(undefined, branch);
  }, [createSession]);

  // Quote-to-composer (from the chat / editor selection toolbar): formats the
  // selected text as a markdown blockquote, appends it to the active session's
  // draft, switches the middle column back to the chat tab (so the composer is
  // visible — quoting from EditorPane leaves chat hidden), and bumps a focus
  // signal so the caret lands at the end of the textarea ready to type.
  const [composerFocusSignal, setComposerFocusSignal] = useState(0);
  const quoteToComposer = useCallback((text: string) => {
    const sid = selectedSessionIdRef.current;
    const quote = text.trim();
    if (!sid || !quote) return;
    setDraftBySession((prev) => {
      const cur = prev[sid] || "";
      // Markdown blockquote: prefix each line with "> ". Empty draft → just the
      // quote; otherwise separate with a blank line so it reads as its own block.
      const block = quote.split("\n").map((l) => `> ${l}`).join("\n");
      const next = cur.trim() ? `${cur}\n\n${block}` : block;
      return { ...prev, [sid]: next };
    });
    // Reveal the composer (chat tab) in case a file/diff tab is active.
    setActiveFileTabBySession((prev) => ({ ...prev, [sid]: "chat" }));
    setComposerFocusSignal((n) => n + 1);
  }, []);

  // 用户在弹窗确认后真正创建 session。按 mode 分发到三条后端路径:
  //   project → CreateSession(useWorktree=false);new → CreateSession(useWorktree=true, baseRef);
  //   enter → CreateGuestSession(enterPath) 钉到已有 worktree(guest)。
  const confirmNewSession = useCallback(async (choice: NewSessionChoice) => {
    const pid = newSession?.projectId;
    if (!pid) return;
    setNewSession(null);
    try {
      if (pid !== selectedProjectId) await selectProject(pid);
      let se: Session | null | undefined = undefined;
      if (choice.mode === "enter" && choice.enterPath) {
        se = await ChatService.CreateGuestSession(pid, "", choice.harness, choice.enterPath, choice.mcpServerIDs);
      } else if (choice.mode === "new") {
        se = await ChatService.CreateSession(pid, "", choice.harness, true, choice.baseRef ?? "", choice.mcpServerIDs);
      } else {
        se = await ChatService.CreateSession(pid, "", choice.harness, false, "", choice.mcpServerIDs);
      }
      if (se) {
        setItemsBySession((prev) => ({ ...prev, [se.id]: [] }));
        setStatusBySession((prev) => ({ ...prev, [se.id]: "empty" }));
        loadedSessionsRef.current.add(se.id);
        await refreshSessions(pid);
        await openSession(se.id);
      }
    } catch (e) {
      setError(extractErrMsg(e));
    }
  }, [newSession, selectedProjectId, refreshSessions, openSession, selectProject]);

  // 发送消息:idle 直发;prompting(一轮进行中)入前端队列,回合结束自动续发(§5.4 协议无 queue)。
  // mentions(@提及 + 回形针文件)经 ACP ContentBlock::ResourceLink 发给 agent;images(内联图片)经
  // ContentBlock::Image 发(需 agent 声明 image 能力);audios(内联音频)经 ContentBlock::Audio 发
  // (需 agent 声明 audio 能力)。attachments 由 buildAttachments 构造,显式带 Kind。入队时随 QueueItem
  // 携带。只要按过发送键就记进输入框历史(上下键翻历史),无论后端是否成功/排队。
  const sendMessage = useCallback(
    async (text: string, mentions: Mention[], imgs?: ImageAttachment[], aus?: AudioAttachment[]) => {
      if (!selectedSessionId || !text.trim()) return;
      // 立即滚到底让用户看到自己发的消息(即使是排队消息也要滚,用户需要看当前对话末尾)。
      chatViewRef.current?.scrollToBottom();
      // 记进历史(按发送键即记录,含排队/被拒的 —— 用户要求)
      setHistoryBySession((prev) => {
        const cur = prev[selectedSessionId] || [];
        if (cur[cur.length - 1] === text) return prev; // 与最后一条相同则不重复
        return { ...prev, [selectedSessionId]: [...cur, text] };
      });
      // 回合进行中(statusRef 防 stale closure):入队而非直发,避免后端 busy 报错。
      // statusRef.current 始终反映最新 status,闭包锁的 status 可能在 re-render 前仍为旧值。
      if (statusRef.current === "prompting") {
        const item: QueueItem = { id: `q-${Date.now()}-${selectedSessionId}`, text, mentions, images: imgs, audios: aus, scheduledAt: Date.now() };
        queueBySessionRef.current = {
          ...queueBySessionRef.current,
          [selectedSessionId]: [...(queueBySessionRef.current[selectedSessionId] || []), item],
        };
        setQueueBySession(queueBySessionRef.current);
        return;
      }
      // idle 直发(attachments 经 buildAttachments 构造,显式带 Kind,见模块顶部)。
      setError(null); setNotice(null);
      setStatusBySession((prev) => ({ ...prev, [selectedSessionId]: "prompting" }));
      try {
        await ChatService.SendMessage(selectedSessionId, text, buildAttachments(mentions, imgs, aus));
      } catch (e) {
        setError(extractErrMsg(e));
        setStatusBySession((prev) => ({ ...prev, [selectedSessionId]: "idle" }));
      }
    },
    [selectedSessionId]
  );

  // stopSessionById cancels a session's in-flight turn by explicit id (not the selected one).
  // Used both by the composer Stop button (for the active session) and by CloseTabDialog's
  // "stop & close" choice (for a tab that may not be the active one). Marks the session as
  // user-stopped so the next idle event won't auto-continue the queue (§ drainSession guard).
  const stopSessionById = useCallback(async (sid: string) => {
    userStoppedBySessionRef.current.add(sid);
    await ChatService.StopSession(sid);
  }, []);

  // 回合结束 drainSession 自动续发(由 chat:status 事件按 sessionId 触发);idle 直发,status 由 chat:status 事件驱动。
  const stopSession = useCallback(async () => {
    if (!selectedSessionId) return;
    await stopSessionById(selectedSessionId);
  }, [selectedSessionId, stopSessionById]);

  // 继续会话:只读态(懒 spawn)下用户点「继续会话」时显式触发 spawn,切为可交互态。
  // 已活跃则后端 no-op。发新消息也会自动触发 spawn(走 SendMessage→ensureLive)。
  const continueSession = useCallback(async () => {
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    try {
      await ChatService.ContinueSession(sid);
    } catch (e) {
      setError(extractErrMsg(e));
    }
  }, []);

  // 立即发送:打断当前 turn,这条插队先发(其余保留排队)。后端 InterruptAndSend 原子完成
  // (cancel + 等落定 + 发新);被取消的轮不发 idle,故 status 保持 prompting,不会误触发 auto-continue。
  const interruptQueue = useCallback(async (id: string) => {
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    const q = queueBySessionRef.current[sid] || [];
    const item = q.find((x) => x.id === id);
    if (!item) return;
    queueBySessionRef.current = { ...queueBySessionRef.current, [sid]: q.filter((x) => x.id !== id) };
    setQueueBySession(queueBySessionRef.current);
    setError(null); setNotice(null);
    userStoppedBySessionRef.current.delete(sid);
    setStatusBySession((prev) => ({ ...prev, [sid]: "prompting" }));
    try {
      await ChatService.InterruptAndSend(sid, item.text, buildAttachments(item.mentions, item.images, item.audios));
    } catch (e) {
      setError(extractErrMsg(e));
    }
  }, []);

  // 主动入队列:与「发送」并列的显式入队入口(Composer 入队列按钮 / ⌘⇧↩)。无论 idle/prompting
  // 都只把消息压入该 session 的前端队列 —— **永远只停车,不 auto-start**(不主动 drainSession、
  // 不 arm 定时器)。续发时机统一交给「turn 结束的 idle 事件」(chat:status handler 内按 sessionId
  // 触发 drainSession):prompting 时入队,本轮结束的 idle 续发;idle 时入队,等下一次自然 turn 结束
  // 或下一次直发触发。主动入队 = 用户想继续,清掉该 session 的停意图(与 interruptQueue 一致),
  // 否则被 Stop 标记抑制、到点续发时被跳过。
  const enqueueMessage = useCallback(
    async (text: string, mentions: Mention[], imgs?: ImageAttachment[], aus?: AudioAttachment[]) => {
      if (!selectedSessionId || !text.trim()) return;
      chatViewRef.current?.scrollToBottom();
      setHistoryBySession((prev) => {
        const cur = prev[selectedSessionId] || [];
        if (cur[cur.length - 1] === text) return prev; // 与最后一条相同则不重复
        return { ...prev, [selectedSessionId]: [...cur, text] };
      });
      const item: QueueItem = { id: `q-${Date.now()}-${selectedSessionId}`, text, mentions, images: imgs, audios: aus, scheduledAt: Date.now() };
      queueBySessionRef.current = {
        ...queueBySessionRef.current,
        [selectedSessionId]: [...(queueBySessionRef.current[selectedSessionId] || []), item],
      };
      setQueueBySession(queueBySessionRef.current);
      userStoppedBySessionRef.current.delete(selectedSessionId);
    },
    [selectedSessionId]
  );

  // 撤回编辑:移出队列,文本回填 composer。
  const revokeQueue = useCallback((id: string) => {
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    const q = queueBySessionRef.current[sid] || [];
    const item = q.find((x) => x.id === id);
    if (!item) return;
    queueBySessionRef.current = { ...queueBySessionRef.current, [sid]: q.filter((x) => x.id !== id) };
    setQueueBySession(queueBySessionRef.current);
    setDraftBySession((prev) => {
      const cur = prev[sid] || "";
      return { ...prev, [sid]: cur.trim() ? cur + "\n" + item.text : item.text };
    });
  }, []);

  // inline 编辑:直接改队列里某条的文本(mentions/images/scheduledAt 原地保留),不离开队列。
  const editQueueItem = useCallback((id: string, text: string) => {
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    const q = queueBySessionRef.current[sid] || [];
    const idx = q.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const next = q.slice();
    next[idx] = { ...q[idx], text };
    queueBySessionRef.current = { ...queueBySessionRef.current, [sid]: next };
    setQueueBySession(queueBySessionRef.current);
  }, []);

  // 定时发送:设置/清空队列里某条的 scheduledAt(Task #22134)。<= now 视为「立即可发」(清除定时)。
  // 改动后重 arm 定时器;若该 session idle 且新设的 scheduledAt 已到点 → 主动 drain 一次立即发。
  const scheduleQueueItem = useCallback((id: string, scheduledAt: number) => {
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    const q = queueBySessionRef.current[sid] || [];
    const idx = q.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const at = scheduledAt > 0 ? scheduledAt : Date.now();
    const next = q.slice();
    next[idx] = { ...q[idx], scheduledAt: at };
    queueBySessionRef.current = { ...queueBySessionRef.current, [sid]: next };
    setQueueBySession(queueBySessionRef.current);
    armScheduleTimer(sid);
    if (at <= Date.now() && statusRef.current !== "prompting") {
      void drainSession(sid);
    }
  }, [armScheduleTimer, drainSession]);

  // 拖拽重排:把 activeId 这条移到 overId 的位置(remove 后插到 overIdx),drainSession 按新顺序发。
  // 重 arm 定时器(order 变了首条可能变);若 idle 且新首条已到点 → 主动 drain(与 scheduleQueueItem 一致)。
  const reorderQueue = useCallback((activeId: string, overId: string) => {
    const sid = selectedSessionIdRef.current;
    if (!sid || activeId === overId) return;
    const q = queueBySessionRef.current[sid] || [];
    const from = q.findIndex((x) => x.id === activeId);
    const to = q.findIndex((x) => x.id === overId);
    if (from < 0 || to < 0) return;
    const next = q.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    queueBySessionRef.current = { ...queueBySessionRef.current, [sid]: next };
    setQueueBySession(queueBySessionRef.current);
    armScheduleTimer(sid);
    if (statusRef.current !== "prompting") void drainSession(sid);
  }, [armScheduleTimer, drainSession]);

  const respondPermission = useCallback(
    async (optionId: string) => {
      if (!selectedSessionId) return;
      const perm = permissionBySession[selectedSessionId];
      if (!perm) return;
      setPermissionBySession((prev) => ({ ...prev, [selectedSessionId]: null }));
      await ChatService.RespondPermission(selectedSessionId, perm.id, optionId);
    },
    [selectedSessionId, permissionBySession]
  );

  const respondElicitation = useCallback(
    async (action: "accept" | "decline" | "cancel", content: Record<string, unknown>) => {
      if (!selectedSessionId) return;
      const elicit = elicitationBySession[selectedSessionId];
      if (!elicit) return;
      setElicitationBySession((prev) => ({ ...prev, [selectedSessionId]: null }));
      // try/catch:卡片可能已因后端超时降级被 resolved 事件清掉,但本回调与 resolved 竞态时
      // 仍可能撞 no pending。失败不抛 unhandled —— 卡片已乐观清,用户无感(§5.3 尊重数据源)。
      try {
        await ChatService.RespondElicitation(selectedSessionId, elicit.id, action, action === "accept" ? JSON.stringify(content) : "");
      } catch (err) {
        console.warn("RespondElicitation failed (likely already auto-resolved)", err);
      }
    },
    [selectedSessionId, elicitationBySession]
  );


  // —— 集成终端(per-session,与 agent ACP 通道分离)——
  const createTerminal = useCallback(async () => {
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    try {
      const cwd = termCwdRef.current;
      const id = await TerminalService.Start(sid, cwd, 80, 24);
      const defaultTermTitle = t("terminal.defaultTitle");
      const title = cwd ? (cwd.replace(/\/$/, "").split("/").pop() || defaultTermTitle) : defaultTermTitle;
      setTermTabsBySession((prev) => ({ ...prev, [sid]: [...(prev[sid] ?? []), { id, sessionId: sid, title, status: "running" }] }));
      setActiveTermBySession((prev) => ({ ...prev, [sid]: id }));
      setTermOpenBySession((prev) => ({ ...prev, [sid]: true }));
    } catch (e) { setError(extractErrMsg(e)); }
  }, []);

  // toggle:打开时若该 session 还没终端,自动建一个;已开 → 关。开关状态 per-session。
  const toggleTerminalPanel = useCallback(() => {
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    setTermOpenBySession((prev) => {
      if (prev[sid]) return { ...prev, [sid]: false }; // 已开 → 关
      if ((termTabsBySession[sid]?.length ?? 0) === 0) void createTerminal(); // 要开且无终端 → 先建
      return { ...prev, [sid]: true };
    });
  }, [termTabsBySession, createTerminal]);

  // ⌘J / Ctrl+J 切换终端面板(VSCode/openwork 共识,肌肉记忆)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "j" || e.key === "J")) {
        e.preventDefault();
        toggleTerminalPanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleTerminalPanel]);

  // 侧栏终端图标 = 后端驱动:启动时拉一次全量对账,后续订阅 terminal:state 实时更新。
  // 这样应用启动 / 打开历史 session / 跨 session 切换 / 重启后图标都能反映真实终端存在性,
  // 不依赖纯前端内存 state(重启即丢)。createTerminal/closeTerminal 仍本地乐观更新面板态,
  // 图标以本事件为权威对账。
  useEffect(() => {
    let off: (() => void) | undefined;
    TerminalService.ListTerminalsBySession()
      .then((m) => {
        if (!m) return;
        // binding 返回 {[k]?: boolean}(可选值),归一为 Record<string, boolean>。
        const next: Record<string, boolean> = {};
        for (const [k, v] of Object.entries(m)) if (v) next[k] = true;
        setHasTermBySession(next);
      })
      .catch(() => {});
    off = Events.On("terminal:state", (e: { data: { sessionId: string; hasTerminal: boolean } }) => {
      const s = e.data;
      if (!s) return;
      setHasTermBySession((prev) => {
        if (!!prev[s.sessionId] === s.hasTerminal) return prev; // 无变化不触发重渲染
        const n = { ...prev };
        if (s.hasTerminal) n[s.sessionId] = true;
        else delete n[s.sessionId];
        return n;
      });
    });
    return () => { off?.(); };
  }, []);

  const closeTerminalTab = useCallback(async (tabId: string) => {
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    void TerminalService.Kill(tabId);
    disposeTerminal(tabId);
    const remaining = (termTabsBySession[sid] ?? []).filter((t) => t.id !== tabId);
    setTermTabsBySession((prev) => ({ ...prev, [sid]: remaining }));
    if (activeTermBySession[sid] === tabId) setActiveTermBySession((prev) => ({ ...prev, [sid]: remaining[0]?.id ?? null }));
    if (remaining.length === 0) setTermOpenBySession((prev) => ({ ...prev, [sid]: false }));
  }, [termTabsBySession, activeTermBySession]);

  const selectTerminalTab = useCallback((tabId: string) => {
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    setActiveTermBySession((prev) => ({ ...prev, [sid]: tabId }));
  }, []);

  const renameTerminalTab = useCallback((tabId: string, title: string) => {
    const sid = selectedSessionIdRef.current;
    if (!sid || !title) return;
    setTermTabsBySession((prev) => {
      const cur = prev[sid] ?? [];
      return { ...prev, [sid]: cur.map((t) => (t.id === tabId ? { ...t, userTitle: title } : t)) };
    });
  }, []);

  const onTabExit = useCallback((tabId: string) => {
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    setTermTabsBySession((prev) => {
      const cur = prev[sid] ?? [];
      return { ...prev, [sid]: cur.map((t) => (t.id === tabId ? { ...t, status: "dead" as const } : t)) };
    });
  }, []);

  // 切换 session 的 config option(model/mode/effort):热切,后端成功后推 config_option event 回更新。
  const setSessionConfig = useCallback(async (configId: string, value: string) => {
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    try { await ChatService.SetSessionConfigOption(sid, configId, value); }
    catch (e) { setError(extractErrMsg(e)); }
  }, []);

  // 打开 model 下拉时防抖重拉 configOptions(同步外部配置改动:用户在 harness 配置里新增的 provider/model)。
  // 后端 probe 是独立进程,即使 turn 在跑也能刷新;成功后由 config_option event 自动更新下拉。
  // 防抖:下拉快速开合只 spawn 一次 probe;readonly/empty(懒 spawn 未活跃)跳过,避免 "session not active" 报错。
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshConfig = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      const sid = selectedSessionIdRef.current;
      if (!sid || statusRef.current === "readonly" || statusRef.current === "empty") return;
      ChatService.RefreshSessionConfig(sid).catch((e) => {
        setError(`${t("chat.refreshConfigFailed")}: ${extractErrMsg(e)}`);
      });
    }, 400);
  }, [t]);

  const [mergeResults, setMergeResults] = useState<Record<string, string>>({});  // per-session 合并结果(切 session 不会串窗口)
  const [sessionDiff, setSessionDiff] = useState<string | null>(null);
  const [sessionChanges, setSessionChanges] = useState<FileChange[] | null>(null);
  const [mergeableBySession, setMergeableBySession] = useState<Record<string, boolean>>({});  // per-session:branch 有无领先基线的已提交 commit(决定合并按钮 enable/disable)
  const [worktreeKindBySession, setWorktreeKindBySession] = useState<Record<string, string>>({});  // per-session:"project"|"owner"|"guest"(guest → 合并禁用 + 提示)
  const mergeSession = useCallback(async () => {
    if (!selectedSessionId) return;
    try {
      const result = await ChatService.MergeSession(selectedSessionId);
      setError(null);
      setMergeResults((prev) => ({ ...prev, [selectedSessionId]: result || t("app.mergeDone") }));
      const sid = selectedSessionId;
      setTimeout(() => setMergeResults((prev) => { const n = { ...prev }; delete n[sid]; return n; }), 6000);
      // 合并后刷新 diff(变为"无变更")+ mergeable(变 false)
      try { setSessionDiff(await ChatService.SessionDiff(sid) || ""); } catch {}
      try { const m = await ChatService.SessionMergeable(sid); setMergeableBySession((prev) => ({ ...prev, [sid]: m })); } catch {}
    } catch (e) {
      const msg = t("app.mergeFailed", { error: extractErrMsg(e) });
      setError(msg);
      setMergeResults((prev) => ({ ...prev, [selectedSessionId]: msg }));
      const sid = selectedSessionId;
      setTimeout(() => setMergeResults((prev) => { const n = { ...prev }; delete n[sid]; return n; }), 8000);
    }
  }, [selectedSessionId]);

  // SCM 操作:暂存 / 取消暂存 / 丢弃 / 提交。每次操作后刷新文件变更列表。
  const stageFiles = useCallback(async (paths: string[]) => {
    if (!selectedSessionId) return;
    try { await ChatService.SessionStage(selectedSessionId, paths); setError(null); }
    catch (e) { setError(extractErrMsg(e)); }
    finally { try { setSessionChanges(await ChatService.SessionChanges(selectedSessionId)); } catch {} }
  }, [selectedSessionId]);
  const unstageFiles = useCallback(async (paths: string[]) => {
    if (!selectedSessionId) return;
    try { await ChatService.SessionUnstage(selectedSessionId, paths); setError(null); }
    catch (e) { setError(extractErrMsg(e)); }
    finally { try { setSessionChanges(await ChatService.SessionChanges(selectedSessionId)); } catch {} }
  }, [selectedSessionId]);
  const discardFiles = useCallback(async (paths: string[]) => {
    if (!selectedSessionId) return;
    try { await ChatService.SessionDiscard(selectedSessionId, paths); setError(null); }
    catch (e) { setError(extractErrMsg(e)); }
    finally { try { setSessionChanges(await ChatService.SessionChanges(selectedSessionId)); } catch {} }
  }, [selectedSessionId]);
  // 提交:失败时 rethrow,让 GitPanel 保留提交信息 + 显示内联错误。
  const commitSession = useCallback(async (message: string) => {
    if (!selectedSessionId) throw new Error(t("app.noActiveSession"));
    try { await ChatService.SessionCommit(selectedSessionId, message); setError(null); }
    catch (e) { setError(extractErrMsg(e)); throw e; }
    finally { try { setSessionChanges(await ChatService.SessionChanges(selectedSessionId)); const m = await ChatService.SessionMergeable(selectedSessionId); setMergeableBySession((p) => ({ ...p, [selectedSessionId]: m })); } catch {} }
  }, [selectedSessionId]);
  // AI 提交:让当前 session 的 agent 自动提交。触发一轮 turn;turn 结束(idle)时
  // 已有 effect 自动刷新 sessionChanges,故无需手动 finally 刷新。
  const aiCommit = useCallback(async () => {
    if (!selectedSessionId) throw new Error(t("app.noActiveSession"));
    try { await ChatService.SessionAICommit(selectedSessionId); setError(null); }
    catch (e) { setError(extractErrMsg(e)); throw e; }
  }, [selectedSessionId]);


  const addProject = useCallback(async () => {
    try {
      const path = await ChatService.PickDirectory();
      if (!path) return;
      await ChatService.AddProject("", path, "");
      await refreshProjects();
    } catch (e) {
      setError(extractErrMsg(e));
    }
  }, [refreshProjects]);


  const removeProject = useCallback(
    async (projectId: string) => {
      await ChatService.RemoveProject(projectId);
      setSessionsByProject((prev) => { if (!(projectId in prev)) return prev; const n = { ...prev }; delete n[projectId]; return n; });
      if (selectedProjectId === projectId) {
        setSelectedProjectId(null);
        setSelectedSessionId(null);
      }
      await refreshProjects();
    },
    [refreshProjects, selectedProjectId]
  );

  // 拖拽重排项目(0007):乐观更新前端顺序 → 持久化 sort_order;失败回滚拉真实顺序。
  const reorderProjects = useCallback(
    async (ids: string[]) => {
      const byId = new Map(projects.map((p) => [p.id, p]));
      const next = ids.map((id) => byId.get(id)).filter(Boolean) as Project[];
      if (next.length !== projects.length) return; // id 集合不一致,放弃
      setProjects(next);
      try {
        await ChatService.ReorderProjects(ids);
      } catch {
        void refreshProjects();
      }
    },
    [projects, refreshProjects]
  );

  // evictSessionCache drops every per-session cache (maps + refs + seed guards) + kills the
  // session's terminals. Pure cache eviction — does NOT remove the sidebar list entry, does NOT
  // touch selection, does NOT call the backend. Shared building block for purgeSessionState
  // (hard delete) and closeTab (close a tab without deleting the session). §5.3: don't scatter
  // eviction logic — one place to drop a session's in-memory footprint.
  const evictSessionCache = useCallback((sessionId: string) => {
    const drop = <T,>(prev: Record<string, T>) => { if (!(sessionId in prev)) return prev; const n = { ...prev }; delete n[sessionId]; return n; };
    void TerminalService.KillSessionTerminals(sessionId);
    deleteFilePanelState(sessionId);
    setTermTabsBySession(drop);
    setActiveTermBySession(drop);
    setTermOpenBySession(drop);
    setItemsBySession(drop);
    setHasMoreBySession(drop);
    setUsageBySession(drop);
    setStatusBySession(drop);
    setStatusDetailBySession(drop);
    setActivityBySession(drop);
    setUnreadBySession(drop);
    setPermissionBySession(drop);
    setElicitationBySession(drop);
    setQueueBySession(drop);
    setDraftBySession(drop);
    setHistoryBySession(drop);
    setAttachmentsBySession(drop);
    setMentionsBySession(drop);
    setImagesBySession(drop);
    setImageSupportedBySession(drop);
    setAudiosBySession(drop);
    setAudioSupportedBySession(drop);
    setConfigOptionsBySession(drop);
    setFileTabsBySession(drop);
    setActiveFileTabBySession(drop);
    queueBySessionRef.current = drop(queueBySessionRef.current);
    userStoppedBySessionRef.current.delete(sessionId);
    drainingBySessionRef.current.delete(sessionId);
    const t = scheduledTimersRef.current[sessionId];
    if (t) { clearTimeout(t); delete scheduledTimersRef.current[sessionId]; }
    delete oldestSeqRef.current[sessionId];
    loadedSessionsRef.current.delete(sessionId);
    historySeededRef.current.delete(sessionId);
    configSeededRef.current.delete(sessionId);
    // Also drop from the tab strip so deleted/purged sessions don't linger as phantom tabs.
    setOpenTabs((prev) => (prev.includes(sessionId) ? prev.filter((id) => id !== sessionId) : prev));
  }, []);

  // purgeSessionState = evictSessionCache + remove the sidebar list entry + clear selection.
  // Used by all hard-delete paths (delete session / delete worktree). Does NOT call the backend.
  const purgeSessionState = useCallback((sessionId: string) => {
    evictSessionCache(sessionId);
    setSessionsByProject((prev) => {
      const next: Record<string, Session[]> = {};
      for (const [pid, list] of Object.entries(prev)) next[pid] = list.filter((s) => s.id !== sessionId);
      return next;
    });
    if (selectedSessionId === sessionId) setSelectedSessionId(null);
  }, [selectedSessionId, evictSessionCache]);

  // projectIdOf looks up a session's project id from the cached sidebar list.
  const projectIdOf = useCallback((sessionId: string): string => {
    for (const list of Object.values(sessionsByProject)) {
      const s = list.find((x) => x.id === sessionId);
      if (s) return s.projectId;
    }
    return "";
  }, [sessionsByProject]);

  // sessionById resolves a session object by id across all projects. Used by the tab bar to
  // render titles/status for open tabs (a tab may belong to any project, not just the selected
  // one). Returns undefined if the session isn't in the cached sidebar list (e.g. mid-refresh).
  const sessionById = useCallback((sessionId: string): Session | undefined => {
    for (const list of Object.values(sessionsByProject)) {
      const s = list.find((x) => x.id === sessionId);
      if (s) return s;
    }
    return undefined;
  }, [sessionsByProject]);

  // projectNameById resolves a project's display name by id. Used by the tab bar's hover tooltip
  // to disambiguate tabs across projects (e.g. two "refactor" sessions in different projects).
  // Falls back to empty string if the project isn't loaded.
  const projectNameById = useCallback((projectId: string): string => {
    const p = projects.find((x) => x.id === projectId);
    return p?.name ?? "";
  }, [projects]);

  // closeTab closes a main-window tab: evict the session's in-memory cache (free the memory the
  // tab was holding) and remove it from the tab strip. This is NOT a delete — the session stays in
  // the DB and the sidebar list; the user just dismissed it from the tab bar. If the closed tab was
  // the active one, pick a neighbor tab (next, else prev) to focus, else fall back to the empty
  // state. Uses evictSessionCache (not purgeSessionState) precisely because the sidebar entry must
  // survive (evictSessionCache also drops the id from openTabs). Reads openTabs from a ref to avoid
  // re-creating the callback on every tab reorder.
  //
  // Guard: if the session is still generating (status "prompting"), closing is ambiguous — the
  // turn is running on the backend. Defer to CloseTabDialog ("stop & close" vs "detach": close tab
  // only, let the turn finish in the background) instead of silently evicting. Idle / error /
  // closed sessions close directly. "detach" + a still-running turn means the in-memory cache is
  // gone but the turn keeps streaming into SQLite; reopen the session later to see the output.
  const closeTab = useCallback((sessionId: string) => {
    if (statusBySession[sessionId] === "prompting") {
      const se = sessionById(sessionId);
      setPendingCloseTab({ sessionId, title: se?.customTitle || se?.title || t("sidebar.sessionDraftFallback") });
      return;
    }
    evictSessionCache(sessionId);  // also removes from openTabs (choke point)
    const prevTabs = openTabsRef.current;
    if (selectedSessionIdRef.current === sessionId) {
      const idx = prevTabs.indexOf(sessionId);
      const next = prevTabs[idx + 1] ?? prevTabs[idx - 1] ?? null;
      if (next) void openSession(next, projectIdOf(next));
      else setSelectedSessionId(null);
    }
  }, [statusBySession, sessionById, t, evictSessionCache, openSession, projectIdOf]);

  // confirmCloseTab resolves the CloseTabDialog choice for a still-generating tab:
  //   "stop"   — StopSession (cancel the turn) then evict the tab;
  //   "detach" — evict the tab only; the turn keeps running, its output lands in SQLite.
  const confirmCloseTab = useCallback(async (mode: "stop" | "detach") => {
    const pc = pendingCloseTab;
    if (!pc) return;
    setPendingCloseTab(null);
    const sid = pc.sessionId;
    if (mode === "stop") {
      await stopSessionById(sid);
    }
    evictSessionCache(sid);
    const prevTabs = openTabsRef.current;
    if (selectedSessionIdRef.current === sid) {
      const idx = prevTabs.indexOf(sid);
      const next = prevTabs[idx + 1] ?? prevTabs[idx - 1] ?? null;
      if (next) void openSession(next, projectIdOf(next));
      else setSelectedSessionId(null);
    }
  }, [pendingCloseTab, stopSessionById, evictSessionCache, openSession, projectIdOf]);

  // ⌘W / Ctrl+W closes the active tab (editor convention: inner tab before outer). With a
  // file/diff tab active it closes that read-only preview (closeFileTab → falls back to chat);
  // only when the chat view itself is active does it close the session tab (with CloseTabDialog
  // for still-generating turns). Wails3 / macOS would otherwise close the whole window, so we
  // override. Main-window only (popout windows have no tab bar — ⌘W there keeps its native
  // "close window" meaning). No-op when nothing is selected.
  useEffect(() => {
    if (isPopout) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "w" || e.key === "W")) {
        const sid = selectedSessionIdRef.current;
        if (!sid) return;
        e.preventDefault();
        // Read activeFileTab from a ref so it's fresh at keypress time, not stale from
        // effect-capture (the effect only re-subscribes on isPopout/closeTab change).
        const aft = activeFileTabBySessionRef.current[sid];
        if (aft && aft !== "chat") closeFileTab(sid, aft);  // close file/diff tab → falls back to chat
        else closeTab(sid);                                 // close session tab (CloseTabDialog if generating)
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPopout, closeTab, closeFileTab]);

  // ⌘/Ctrl+1-9 切换到当前选中项目的第 N 个 session(VS Code / 浏览器 tab 切换的肌肉记忆)。
  // 不足 N 个则静默(不切换、不 preventDefault —— 让按键原样透传)。popout 窗口不挂(它只看
  // 单个 session,无 session 列表/tab 概念)。用 sessionsRef 读最新 sessions,避免 stale closure
  // (effect 只在 isPopout/openSession 变化时重订阅,不被 sessions 变化牵连)。
  useEffect(() => {
    if (isPopout) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key;
      if (key < "1" || key > "9") return;
      const idx = Number(key) - 1;
      const target = sessionsRef.current[idx];
      if (!target) return;  // not enough sessions: silent no-op
      e.preventDefault();
      void openSession(target.id, target.projectId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPopout, openSession]);

  // Delete a session. Chat-only for guest/project; owner also removes the worktree; owner WITH
  // guests defers to the 3-option dialog (DeleteWorktreeDialog) since removing the worktree
  // affects them. Hard delete (DB row gone), unrecoverable.
  const removeSession = useCallback(async (sessionId: string) => {
    let kind = "project";
    try { kind = await ChatService.WorktreeKind(sessionId); } catch { /* treat as project */ }
    if (kind === "owner") {
      let guests: Session[] = [];
      try { guests = (await ChatService.WorktreeGuests(sessionId)) ?? []; } catch {}
      if (guests.length > 0) {
        setDeleteWt({ sessionId, projectId: projectIdOf(sessionId), guests });
        return; // the dialog drives the rest
      }
      // owner, no guests → delete the worktree (needs the owner row) then the chat.
      await ChatService.DeleteWorktree(sessionId).catch(() => {});
    }
    await ChatService.DeleteSession(sessionId);
    purgeSessionState(sessionId);
  }, [projectIdOf, purgeSessionState]);

  // confirmDeleteWorktree runs the owner-with-guests choice:
  //   "all"  → delete owner + every guest + the worktree;
  //   "keep" → detach guests (keep their history, fall back to project dir) + delete owner + worktree.
  const confirmDeleteWorktree = useCallback(async (mode: "all" | "keep") => {
    const dw = deleteWt;
    if (!dw) return;
    setDeleteWt(null);
    const pid = dw.projectId;
    try {
      if (mode === "all") {
        // Close+delete guests first (their harnesses run in the worktree), then remove the
        // worktree (owner row still exists), then delete the owner.
        for (const g of dw.guests) {
          await ChatService.DeleteSession(g.id);
          purgeSessionState(g.id);
        }
        await ChatService.DeleteWorktree(dw.sessionId).catch(() => {});
        await ChatService.DeleteSession(dw.sessionId);
        purgeSessionState(dw.sessionId);
      } else {
        // keep: detach guests (clear their worktree ref), remove worktree + owner chat.
        await ChatService.DetachWorktreeGuests(dw.sessionId).catch(() => {});
        await ChatService.DeleteWorktree(dw.sessionId).catch(() => {});
        await ChatService.DeleteSession(dw.sessionId);
        purgeSessionState(dw.sessionId);
      }
      if (pid) await refreshSessions(pid);
    } catch (e) {
      setError(extractErrMsg(e));
      if (pid) await refreshSessions(pid);
    }
  }, [deleteWt, purgeSessionState, refreshSessions]);

  // popout:把某 session 弹到独立窗口(主窗口打包当前 React state 快照 → 后端中转 → 新窗口还原)。
  const popoutSession = useCallback(async (sessionId: string) => {
    // 打包当前内存 state(进行中的流式 turn / 队列 / 草稿 / 实时 plan / 待决权限),供 popout 还原。
    // 已落库的对话历史由 popout 自己从 SQLite LoadMessages 拉,不打包(太大)。
    const snapshot = JSON.stringify({
      items: itemsBySession[sessionId] ?? [],
      queue: queueBySession[sessionId] ?? [],
      draft: draftBySession[sessionId] ?? "",
      livePlan: livePlanBySession[sessionId] ?? null,
      permission: permissionBySession[sessionId] ?? null,
      elicitation: elicitationBySession[sessionId] ?? null,
      // 终端:面板开关 + tab 列表 + active tab。tab.id 对应后端同一 PTY —— popout 新建 xterm
      // 后订阅同一 id 的 terminal:data,并调 GetTerminalScrollback replay 历史(ring buffer)。
      termOpen: termOpenBySession[sessionId] ?? false,
      termTabs: termTabsBySession[sessionId] ?? [],
      activeTerm: activeTermBySession[sessionId] ?? null,
    });
    await ChatService.SaveSessionSnapshot(sessionId, snapshot);
    await ChatService.OpenSessionWindow(sessionId);
    // 乐观更新:立即标记为 popped,让主窗口对该 session 视而不见(不等 popout-changed 事件往返)。
    setPoppedSessionIds((prev) => { const n = new Set(prev); n.add(sessionId); return n; });
    // Mutually exclusive with tabs: once popped out to its own window, the session leaves the tab
    // strip. (Re-popping back to main does NOT auto-restore it as a tab — MVP decision; the user
    // re-opens it from the sidebar, which re-registers it via openSession.)
    setOpenTabs((prev) => prev.filter((id) => id !== sessionId));
  }, [itemsBySession, queueBySession, draftBySession, livePlanBySession, permissionBySession, termOpenBySession, termTabsBySession, activeTermBySession]);
  // 临时调试:暴露 popoutSession 到 window,供 server 模式浏览器测试调用。
  useEffect(() => { (window as unknown as Record<string, unknown>).__popoutSession = popoutSession; }, [popoutSession]);

  // 聚焦已弹出的 popout 窗口(不新开)。
  const focusPopout = useCallback((sessionId: string) => {
    void ChatService.FocusSessionWindow(sessionId);
  }, []);

  // 关闭 popout 窗口,移回主窗口(触发 WindowWillClose → 后端推 popout-changed false → 主窗口恢复渲染)。
  const closePopout = useCallback((sessionId: string) => {
    void ChatService.CloseSessionWindow(sessionId);
  }, []);

  // popout 窗口置顶 toggle:切换「始终置顶」状态,后端调 SetAlwaysOnTop。
  const toggleOnTop = useCallback(() => {
    if (!popoutMode) return;
    const next = !onTop;
    setOnTop(next);
    void ChatService.SetSessionWindowOnTop(popoutMode, next);
  }, [popoutMode, onTop]);
  // 切换置顶(0008):后端落库后前端乐观本地重排。不复用 refreshSessions —— 那会全量替换、
  // turn 进行中时洗掉前端直播标题(见 2026-07-01-sidebar-session-search.md 的坑);本地重排规避它、即时生效。
  // 重排复刻 DB 排序:pinned DESC → promptedAt DESC → updatedAt DESC,稳定排序保证同级不乱跳。
  const toggleSessionPin = useCallback(
    async (sessionId: string, pinned: boolean) => {
      await ChatService.SetSessionPinned(sessionId, pinned);
      setSessionsByProject((prev) => {
        const next: Record<string, Session[]> = {};
        for (const [pid, list] of Object.entries(prev)) {
          const idx = list.findIndex((s) => s.id === sessionId);
          if (idx < 0) { next[pid] = list; continue; }
          const updated = { ...list[idx], pinned };
          const rest = list.filter((_, i) => i !== idx);
          next[pid] = [...rest, updated].sort(
            (a, b) =>
              Number(b.pinned) - Number(a.pinned) ||
              b.promptedAt - a.promptedAt ||
              b.updatedAt - a.updatedAt,
          );
        }
        return next;
      });
    },
    []
  );


  // 重命名会话(0016):写 custom_title(空串=清除,回退 auto title)。后端落库后乐观更新本地。
  // 重命名不改排序键(prompted/updated/pinned 都不动),只就地替换字段,无需重排。
  const renameSession = useCallback(
    async (sessionId: string, customTitle: string) => {
      await ChatService.UpdateSessionCustomTitle(sessionId, customTitle);
      setSessionsByProject((prev) => {
        const next: Record<string, Session[]> = {};
        for (const [pid, list] of Object.entries(prev)) {
          const idx = list.findIndex((s) => s.id === sessionId);
          if (idx < 0) { next[pid] = list; continue; }
          const arr = [...list];
          arr[idx] = { ...arr[idx], customTitle };
          next[pid] = arr;
        }
        return next;
      });
    },
    []
  );


  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) || null,
    [projects, selectedProjectId]
  );

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId) || null,
    [sessions, selectedSessionId]
  );
  // 终端 cwd = session worktree(或项目目录)。ref 在此赋值(createTerminal 在上方定义,引用 ref 而非 termCwd 变量,绕开声明顺序)。
  termCwdRef.current = activeSession?.worktreePath || selectedProject?.path || "";

  // 三栏布局尺寸持久化:用户拖拽过的分隔位置存 localStorage,重开恢复。
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "monkey-deck-layout",
    onlySaveAfterUserInteractions: true,
  });

  // 左右面板可收起/展开:用 react-resizable-panels 的 collapsible + 命令式 API,
  // 面板结构恒定(只改尺寸),布局切换无抖动。collapsed 状态经 onResize 同步,
  // 以兼容「持久化布局恰好把该面板存成 0(collapsedSize)」的复载场景。
  const sidebarPanelRef = usePanelRef();
  const sidePanelRef = usePanelRef();
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  // popout 窗口:右侧面板默认收起(给对话区最大显示面积);主窗口默认展开。
  const [rightCollapsed, setRightCollapsed] = useState(isPopout);
  const syncCollapsed = (ref: RefObject<PanelImperativeHandle | null>, set: (v: boolean) => void) => {
    const c = ref.current?.isCollapsed();
    if (c != null) set(c);
  };
  const collapseSidebar = () => sidebarPanelRef.current?.collapse();
  const expandSidebar = () => sidebarPanelRef.current?.expand();
  const collapseSide = () => { sidePanelRef.current?.collapse(); if (isPopout && popoutMode) void ChatService.ShrinkSessionWindow(popoutMode); };
  const expandSide = () => { sidePanelRef.current?.expand(); if (isPopout && popoutMode) void ChatService.ExpandSessionWindow(popoutMode); };

  // 窗口窄时自动折叠右侧面板:聊天区需要足够宽度(对话流可读),窗口 < 750px 时
  // 右侧 SidePanel 自动收起,给聊天区让空间。用户仍可手动展开(rail 按钮),
  // 但展开后聊天区有 minSize 保障不会被挤没。popout 窗口默认比主窗口小,尤其需要。
  const NARROW_THRESHOLD = 750;
  useEffect(() => {
    const onResize = () => {
      const w = window.innerWidth;
      if (w < NARROW_THRESHOLD) {
        sidePanelRef.current?.collapse();
      }
    };
    window.addEventListener("resize", onResize);
    // popout 模式:首次挂载直接收起右侧面板(给对话区最大面积)。
    if (isPopout) sidePanelRef.current?.collapse();
    else onResize(); // 主窗口:首次挂载检查窄屏
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPopout]);

  // ── M2 mobile drawer (≤768px) ──
  // The sidebar drawer is driven by EXPLICIT state, not the panel library's
  // collapsed state: mount-time imperative collapse() races the library's
  // deferred initial layout (observed: the call is silently overridden and the
  // drawer renders open on phones). A dedicated drawerOpen state is
  // race-free by construction; at >768px every touchpoint below is inert
  // (scrim is display:none, rail toggle takes the leftCollapsed branch).
  const MOBILE_BP = 768;
  const [mdViewport, setMdViewport] = useState(
    () => typeof window !== "undefined" && window.matchMedia(`(max-width: ${MOBILE_BP}px)`).matches,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BP}px)`);
    const fn = () => setMdViewport(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  const closeDrawer = () => setDrawerOpen(false);

  // Swipe-left on the drawer closes it (the touch equivalent of tapping the
  // scrim). Threshold + dominant-axis guard so vertical list scrolling inside
  // the drawer never triggers it. Desktop never fires touch events — inert.
  const drawerTouch = useRef<{ x: number; y: number } | null>(null);
  const onDrawerTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    drawerTouch.current = { x: t.clientX, y: t.clientY };
  };
  const onDrawerTouchEnd = (e: React.TouchEvent) => {
    const s = drawerTouch.current;
    drawerTouch.current = null;
    if (!s) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (dx < -60 && Math.abs(dx) > Math.abs(dy) * 2) setDrawerOpen(false);
  };

  // On-screen keyboard (mobile): the layout viewport does NOT shrink when the
  // keyboard opens on iOS — 100dvh keeps the composer under it. visualViewport
  // tracks the visible area; expose it as --md-vvh so the ≤768px layout
  // (.app height, modal sheets) stays above the keyboard. Also reset the
  // layout scroll iOS performs when the focused input sits low.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      document.documentElement.style.setProperty("--md-vvh", `${Math.round(vv.height)}px`);
      if (vv.offsetTop > 0) window.scrollTo(0, 0);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
    };
  }, []);



  return (
    <>
    <Group
      orientation="horizontal"
      className="app"
      id="monkey-deck-layout"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      data-sidebar-collapsed={isPopout ? "popout" : (leftCollapsed ? "true" : "false")}
      data-side-collapsed={rightCollapsed ? "true" : "false"}
      data-md-drawer={drawerOpen ? "true" : "false"}
    >
      {!isPopout && (
      <Panel
        id="sidebar"
        defaultSize="18%"
        minSize="12%"
        maxSize="30%"
        collapsible
        panelRef={sidebarPanelRef}
        onTouchStart={onDrawerTouchStart}
        onTouchEnd={onDrawerTouchEnd}
        onResize={() => syncCollapsed(sidebarPanelRef, setLeftCollapsed)}
      >
        <Sidebar
          projects={projects}
          selectedProjectId={selectedProjectId}
          sessionsByProject={sessionsByProject}
          selectedSessionId={selectedSessionId}
          onSelectProject={(id) => void selectProject(id)}
          onSelectSession={(sid, pid) => void openSession(sid, pid)}
          onCreateSession={(pid) => void createSession(pid)}
          onAddProject={() => void addProject()}
          permPendingBySession={permPendingBySession}
          draftBySession={draftBySession}
          hasTermBySession={hasTermBySession}
          onRemoveProject={removeProject}
          onRemoveSession={removeSession}
          onTogglePin={toggleSessionPin}
          onRenameSession={renameSession}
          statusBySession={statusBySession}
          activityBySession={activityBySession}
          unreadBySession={unreadBySession}
          harnesses={harnesses}
          onReorderProjects={reorderProjects}
          onOpenSettings={() => setSettingsOpen(true)}
          harnessUpdateAvailable={harnessUpdateAvailable}
          poppedSessionIds={poppedSessionIds}
          onPopoutSession={popoutSession}
          onFocusPopout={focusPopout}
          onClosePopout={closePopout}
        />
      </Panel>
      )}
      {!isPopout && !leftCollapsed && <Separator className="resize-handle" />}
      <Panel id="main" minSize={isPopout ? "520px" : "30%"}>
        <div className="main-col">
        {!isPopout && openTabs.length > 0 && (
          <TabBar
            tabs={openTabs
              // Skip sessions popped out to standalone windows (mutual exclusion between tabs
              // and popout — a session is either a tab or a popout, never both) and sessions that
              // aren't in the cached sidebar list (race during refresh / delete mid-render).
              .filter((id) => !poppedSessionIds.has(id) && sessionById(id))
              .map((id) => {
                const se = sessionById(id)!;
                return {
                  id,
                  title: se.customTitle || se.title || t("sidebar.sessionDraftFallback"),
                  projectName: projectNameById(se.projectId),
                  status: statusBySession[id],
                  activity: activityBySession[id],
                  unread: !!unreadBySession[id],
                };
              })}
            activeId={selectedSessionId}
            onSelect={(id) => void openSession(id, projectIdOf(id))}
            onClose={closeTab}
            onPopout={(id) => void popoutSession(id)}
          />
        )}
        {selectedSessionId && fileTabs.length > 0 && (
          <FileTabBar
            tabs={fileTabs}
            activeKey={activeFileTab}
            onActivate={(key) => selectFileTab(selectedSessionId, key)}
            onCloseFile={(key) => closeFileTab(selectedSessionId, key)}
          />
        )}
        <main className="main">
          {selectedSessionId && (isPopout || !poppedSessionIds.has(selectedSessionId)) ? (
            <Group orientation="vertical" id="main-vertical" className="main-vertical">
              <Panel id="chat-area" minSize="20%">
            {/* Hide (not unmount) ChatView when a file tab is active: composer draft / scroll / unread stay. */}
            <div className={`chatview-wrap ${activeFileTab !== "chat" ? "is-hidden" : ""}`}>
            <ChatView
              ref={chatViewRef}
              project={selectedProject}
              session={sessions.find((s) => s.id === selectedSessionId) || null}
              items={items}
              status={status}
              statusDetail={statusDetail}
              usage={usage}
              branch={branchBySession[selectedSessionId] || activeSession?.branch || ""}
              onNewSessionOnBranch={onNewSessionOnBranch}
              error={error}
              notice={notice}
              permission={permission}
              elicitation={elicitation}
              onSend={sendMessage}
              onEnqueue={enqueueMessage}
              onStop={stopSession}
              onContinue={continueSession}
              onRespondPermission={respondPermission}
              onRespondElicitation={respondElicitation}
              onToggleTerminal={toggleTerminalPanel}
              mergeResult={mergeResults[selectedSessionId] || null}
              onMerge={mergeSession}
              sessionDiff={sessionDiff}
              queue={queue}
              onInterruptQueue={interruptQueue}
              onRevokeQueue={revokeQueue}
              onEditQueue={editQueueItem}
              onScheduleQueue={scheduleQueueItem}
              onReorderQueue={reorderQueue}
              composerValue={composerValue}
              onComposerChange={onComposerChange}
              attachments={attachments}
              onAttachmentsChange={onAttachmentsChange}
              mentions={mentions}
              onMentionsChange={onMentionsChange}
              images={images}
              onImagesChange={onImagesChange}
              imageSupported={imageSupported}
              audios={audios}
              onAudiosChange={onAudiosChange}
              audioSupported={audioSupported}
              history={history}
              activity={activityBySession[selectedSessionId]}
              sessionId={selectedSessionId}
              configOptions={configOptions}
              commands={commands}
              livePlan={livePlan}
              onSetConfig={setSessionConfig}
              onRefreshConfig={refreshConfig}
              hasMore={hasMore}
              loadingMore={loadingMore}
              onLoadMore={() => selectedSessionId && loadMoreMessages(selectedSessionId)}
              onOpenFile={(path, line) => openFileTab(selectedSessionId, path, line)}
              onQuoteToComposer={quoteToComposer}
              focusSignal={composerFocusSignal}
            />
            </div>
            {/* EditorPane (content) / DiffPane (git changes): shown when a non-chat
                tab is active; lives in the same chat-area Panel to share column height. */}
            {(() => {
              const tab = activeFileTab !== "chat" ? fileTabs.find((t) => tabKey(t) === activeFileTab) : undefined;
              if (!tab) return null;
              if (tab.kind === "diff") {
                return (
                  <DiffPane
                    sessionId={selectedSessionId}
                    path={tab.path}
                    staged={!!tab.staged}
                    onClose={() => closeFileTab(selectedSessionId, activeFileTab)}
                  />
                );
              }
              return (
                <EditorPane
                  sessionId={selectedSessionId}
                  file={{ path: tab.path, line: tab.line }}
                  onClose={() => closeFileTab(selectedSessionId, activeFileTab)}
                  onQuoteToComposer={quoteToComposer}
                />
              );
            })()}
              </Panel>
              {termOpenBySession[selectedSessionId] && (
                <>
                  <Separator className="resize-handle-v" />
                  <Panel id="terminal-area" defaultSize={260} minSize={120}>
                    <TerminalPanel
                      sessionId={selectedSessionId}
                      cwd={termCwdRef.current}
                      tabs={termTabsBySession[selectedSessionId] ?? []}
                      activeTabId={activeTermBySession[selectedSessionId] ?? null}
                      onSelectTab={selectTerminalTab}
                      onCloseTab={closeTerminalTab}
                      onTabExit={onTabExit}
                      onNewTab={createTerminal}
                      onRenameTab={renameTerminalTab}
                      onClosePanel={() => setTermOpenBySession((p) => ({ ...p, [selectedSessionId]: false }))}
                    />
                  </Panel>
                </>
              )}
            </Group>
          ) : (
            <EmptyState />
          )}
        </main>
        </div>
      </Panel>
      {!rightCollapsed && <Separator className="resize-handle" />}
      <Panel
        id="side"
        defaultSize={isPopout ? 0 : "20%"}
        minSize="14%"
        maxSize="34%"
        collapsible
        collapsedSize={0}
        panelRef={sidePanelRef}
        onResize={() => syncCollapsed(sidePanelRef, setRightCollapsed)}
      >
        {selectedSessionId && activeSession && (isPopout || !poppedSessionIds.has(selectedSessionId)) ? (
          <SidePanel
            key={selectedSessionId ?? ""}
            sessionId={selectedSessionId}
            rootName={selectedProject?.name || ""}
            rootPath={activeSession?.worktreePath || selectedProject?.path || ""}
            isGitProject={gitByProject[selectedProject?.id ?? ""] ?? false}
            changes={sessionChanges}
            status={status}
            mergeResult={mergeResults[selectedSessionId] || null}
            branch={branchBySession[selectedSessionId] || activeSession.branch || ""}
            baseRef={activeSession.baseRef || ""}
            onMerge={mergeSession}
            mergeable={mergeableBySession[selectedSessionId] ?? false}
            isGuest={worktreeKindBySession[selectedSessionId] === "guest"}
            onStage={stageFiles}
            onUnstage={unstageFiles}
            onDiscard={discardFiles}
            onCommit={commitSession}
            onAICommit={aiCommit}
            onOpenDiff={(path, staged) => selectedSessionId && openDiffTab(selectedSessionId, path, staged)}
            busy={status === "prompting"}
            onOpenFile={(path, line) => selectedSessionId && openFileTab(selectedSessionId, path, line)}
          />
        ) : (
          <div className="side-empty" />
        )}
      </Panel>
    </Group>
    {/* Mobile drawer scrim (M2): tap-to-close behind the ≤768px sidebar drawer.
        display:none on desktop (CSS default) and whenever the drawer is closed —
        the >768px layout renders identically to before. */}
    {!isPopout && (
      <button
        type="button"
        className="drawer-scrim"
        onClick={closeDrawer}
        aria-hidden="true"
        tabIndex={-1}
        data-testid="drawer-scrim"
      />
    )}
    {/* Sidebar collapse/expand toggle (fixed anchor): icon stays at the same spot whether
        the sidebar is open or collapsed — only the icon direction swaps. Hidden in popout
        (no sidebar there). Traffic lights occupy the top-left, so this anchor sits below them.
        ≤768px (M2): the same anchor toggles the mobile drawer (explicit state, race-free)
        instead of the panel imperative API. */}
    {!isPopout && (
      <button
        type="button"
        className="panel-toggle left"
        onClick={() => {
          if (mdViewport) setDrawerOpen((v) => !v);
          else if (leftCollapsed) expandSidebar();
          else collapseSidebar();
        }}
        data-testid={mdViewport ? (drawerOpen ? "collapse-sidebar" : "expand-sidebar") : (leftCollapsed ? "expand-sidebar" : "collapse-sidebar")}
        aria-label={mdViewport ? (drawerOpen ? t("sidebar.collapse") : t("app.expandSidebar")) : (leftCollapsed ? t("app.expandSidebar") : t("sidebar.collapse"))}
        data-tooltip-id="md-tip"
        data-tooltip-content={mdViewport ? (drawerOpen ? t("sidebar.collapse") : t("app.expandSidebar")) : (leftCollapsed ? t("app.expandSidebar") : t("sidebar.collapse"))}
        data-tooltip-place="right"
      >
        {(mdViewport ? drawerOpen : !leftCollapsed) ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
      </button>
    )}
    {/* Right side panel collapse/expand toggle (fixed anchor): icon stays pinned to the
        top-right corner whether the panel is open or collapsed — only direction swaps. */}
    <button
      type="button"
      className="panel-toggle right"
      onClick={rightCollapsed ? expandSide : collapseSide}
      data-testid={rightCollapsed ? "expand-side" : "collapse-side"}
      aria-label={rightCollapsed ? t("app.expandSidePanel") : t("sidePanel.collapse")}
      data-tooltip-id="md-tip"
      data-tooltip-content={rightCollapsed ? t("app.expandSidePanel") : t("sidePanel.collapse")}
      data-tooltip-place="left"
    >
      {rightCollapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
    </button>
    {/* popout 窗口专属:置顶 toggle。浮在右上角(macOS 红绿灯右侧)。 */}
    {isPopout && (
      <button
        type="button"
        className={`on-top-toggle ${onTop ? "active" : ""}`}
        onClick={toggleOnTop}
        data-testid="toggle-on-top"
        aria-label={t("app.toggleAlwaysOnTop")}
        data-tooltip-id="md-tip"
        data-tooltip-content={t("app.toggleAlwaysOnTop")}
        data-tooltip-place="left"
      >
        <Pin size={14} />
      </button>
    )}
    {newSession && (
      <NewSessionModal
        harnesses={harnesses}
        isGit={newSession.isGit}
        lastHarness={newSession.lastHarness}
        defaultBaseRef={newSession.defaultBaseRef}
        recentRefs={newSession.recentRefs}
        branches={newSession.branches}
        worktrees={newSession.worktrees}
        initialBaseRef={newSession.initialBaseRef}
        onConfirm={confirmNewSession}
        onCancel={() => setNewSession(null)}
      />
    )}
    {deleteWt && (
      <DeleteWorktreeDialog
        guests={deleteWt.guests}
        onConfirm={confirmDeleteWorktree}
        onCancel={() => setDeleteWt(null)}
      />
    )}
    {pendingCloseTab && (
      <CloseTabDialog
        title={pendingCloseTab.title}
        onConfirm={confirmCloseTab}
        onCancel={() => setPendingCloseTab(null)}
      />
    )}
    {settingsOpen && (
      <SettingsPanel onClose={() => setSettingsOpen(false)} harnessUpdateAvailable={harnessUpdateAvailable} />
    )}
    {/* Tooltips are a hover affordance (§4.5). On touch they mislead more
        than they help (user feedback, 2026-08-23): taps fire them alongside
        the real action and they linger over new surfaces — hide entirely on
        coarse-pointer clients; desktop keeps the hover timing. */}
    <Tooltip id="md-tip" delayShow={isMac ? 1500 : 500} hidden={coarsePointer} />
    </>
  );
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="empty-state">
      <div className="empty-logo"><Sparkles size={30} /></div>
      <h2>{t("app.emptyTitle")}</h2>
      <p>{t("app.emptyTagline")}</p>
      <p className="empty-hint">{t("app.emptyHint")}</p>
    </div>
  );
}
