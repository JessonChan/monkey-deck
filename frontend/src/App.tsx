import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Events } from "@wailsio/runtime";
import * as ChatService from "../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import * as TerminalService from "../bindings/github.com/jessonchan/monkey-deck/internal/terminal/terminalservice";
import { Project, Session, Message } from "../bindings/github.com/jessonchan/monkey-deck/internal/store/models";
import type { ChatItem, ConfigOption, PermissionPrompt, SessionEvent, StatusPayload, QueueItem, Mention, ImageAttachment, PlanEntry, LivePlan, Usage } from "./types";
import Sidebar from "./components/Sidebar";
import ChatView, { type ChatViewHandle } from "./components/ChatView";
import { Sparkles } from "lucide-react";
import SidePanel from "./components/SidePanel";
import TerminalPanel from "./components/TerminalPanel";
import type { TerminalTab } from "./lib/terminalTypes";
import { disposeTerminal } from "./lib/termRegistry";
import NewSessionModal from "./components/NewSessionModal";
import SettingsPanel from "./components/SettingsPanel";
import type { Harness } from "../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef, type PanelImperativeHandle } from "react-resizable-panels";
import { Tooltip } from "react-tooltip";
import { PanelLeftOpen, PanelRightOpen } from "lucide-react";
import type { FileChange } from "../bindings/github.com/jessonchan/monkey-deck/internal/worktree/models";
import { applyEventToItems as applyEventToItemsPure } from "./lib/streamMerge";
import { shouldDropOnSwitch } from "./lib/sessionDrop";
import { isNotifySoundEnabled, playNotifySound } from "./lib/notifySound";
import { isMemorySaverEnabled } from "./lib/memorySaver";
const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

// 按 session 隔离的状态:切走再切回时,进行中的流式输出 / 用量 / 状态 / 权限都保留在各自缓存里,
// 不会因「切走→事件被丢弃→切回只剩 DB 已落库内容」而丢失正在输出的内容。

const EMPTY_USAGE: Usage = { used: 0, size: 0, cost: 0, cachedReadTokens: 0, cachedWriteTokens: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 };

// 分页:首次打开只加载最近 PAGE_SIZE 条,滚到顶部点「加载更多」继续往前翻(游标 = 最旧 seq)。
const PAGE_SIZE = 30;

export default function App() {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [gitByProject, setGitByProject] = useState<Record<string, boolean>>({});
  const [branchBySession, setBranchBySession] = useState<Record<string, string>>({});
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, Session[]>>({});
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

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
  const [error, setError] = useState<string | null>(null);
  // 刷新模型列表(spawn probe harness 拉最新 configOptions)。按 session 隔离,切走保留。
  const [refreshingConfigBySession, setRefreshingConfigBySession] = useState<Record<string, boolean>>({});
  const [queueBySession, setQueueBySession] = useState<Record<string, QueueItem[]>>({});  // 前端 FIFO 队列(按 session 隔离,切走保留)
  const [draftBySession, setDraftBySession] = useState<Record<string, string>>({});  // composer 草稿(按 session 隔离,切走保留)
  const [historyBySession, setHistoryBySession] = useState<Record<string, string[]>>({});  // 输入框历史(上下键翻):按 session 隔离,seed 自 DB + 每次发送追加
  const [attachmentsBySession, setAttachmentsBySession] = useState<Record<string, string[]>>({});  // composer 回形针附件(按 session 隔离,切走保留)
  const [mentionsBySession, setMentionsBySession] = useState<Record<string, Mention[]>>({});  // composer @提及(按 session 隔离,切走保留)
  const [imagesBySession, setImagesBySession] = useState<Record<string, ImageAttachment[]>>({});  // composer 内联图片附件(按 session 隔离,需 agent 支持 image 能力)
  const [imageSupportedBySession, setImageSupportedBySession] = useState<Record<string, boolean>>({});  // agent 是否声明 image prompt 能力(门控图片输入入口)
  const [configOptionsBySession, setConfigOptionsBySession] = useState<Record<string, ConfigOption[]>>({}); // model/mode/effort(agent 自报)
  // 当前 turn 的实时 plan(进行中的 turn 由 plan 事件流式刷新;turn 结束转为持久化 plan item)。
  // 历史 turn 的 plan 不在这里 —— 它们作为 role='plan' message 持久化,重开会话时由
  // messagesToItems 转为 type:'plan' ChatItem 内联渲染。null = 当前无实时 plan。
  const [livePlanBySession, setLivePlanBySession] = useState<Record<string, LivePlan | null>>({});
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  // 任一 harness 有新版 → 设置入口齿轮 + 设置内 harness 菜单亮红点(§设置入口/harness 菜单红点)。
  const harnessUpdateAvailable = useMemo(
    () => harnesses.some((h) => h.upgradeAvailable),
    [harnesses],
  );
  const [newSession, setNewSession] = useState<{ projectId: string; isGit: boolean; lastHarness: string } | null>(null);  // 新建对话弹窗
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
  // sessionsByProject 的 ref:status 事件 handler 里查「session 属于哪个 project」用,
  // 不进 effect 依赖(避免每次 sessionsByProject 变化都重订阅事件)。
  const sessionsByProjectRef = useRef(sessionsByProject);
  sessionsByProjectRef.current = sessionsByProject;
  // livePlanBySession 的 ref:turn 结束(idle/error/closed)时读它把实时 plan 转为持久化
  // plan item append 进 itemsBySession。用 ref 绕开「在 setLivePlanBySession updater 内
  // 套 setItemsBySession」的嵌套 setState(StrictMode 下 updater 可能多次执行致重复 append)。
  const livePlanBySessionRef = useRef(livePlanBySession);
  livePlanBySessionRef.current = livePlanBySession;

  const refreshProjects = useCallback(async () => {
    const list = await ChatService.ListProjects();
    setProjects(list || []);
    // 加载项目级 isGit 信息供 SCM 可见性判定(对齐 orca / VS Code repo-kind 判定,
    // 跟 session 是否有独立 worktree 解耦).每个项目探测一次,缓存到 gitByProject。
    if (list && list.length > 0) {
      const entries = await Promise.all(list.map(async (p) => {
        try { return [p.id, await ChatService.IsGitProject(p.id)] as [string, boolean]; }
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
      // 附带的 image prompt 能力门控(前端据此决定是否展示图片输入入口,§3.5)。
      setImageSupportedBySession((prev) => (prev[ev.sessionId] === ev.imageSupported ? prev : { ...prev, [ev.sessionId]: !!ev.imageSupported }));
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
  const imageSupported = !!(selectedSessionId && imageSupportedBySession[selectedSessionId]);
  const configOptions = (selectedSessionId ? configOptionsBySession[selectedSessionId] : undefined) ?? [];
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

  // auto-continue:指定 session 的 turn 结束(idle/error)时,若非用户主动停且队列非空,自动发下一条
  // (FIFO)。每条排队消息 = 一个独立 turn,按序逐个发(协议无 queue,一次只一个 Prompt)。
  // 由 chat:status 事件直接按 sessionId 触发(§5.3 尊重数据源:status 事件携带 sessionId,是「哪个
  // session 该续发」的权威信号)——故后台(非选中)session 的队列也能自动续发,不再限于选中态。
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
    drainingBySessionRef.current.add(sid);
    const next = q[0];
    queueBySessionRef.current = { ...queueBySessionRef.current, [sid]: q.slice(1) };
    setQueueBySession(queueBySessionRef.current);
    // error 条只对当前查看的 session 弹(后台 session 续发失败不打扰用户视图)。
    const isViewing = sid === selectedSessionIdRef.current;
    if (isViewing) setError(null);
    setStatusBySession((prev) => ({ ...prev, [sid]: "prompting" }));
    try {
      await ChatService.SendMessage(sid, next.text, [
        ...(next.mentions || []).map((m) => ({ path: m.path, name: m.name })),
        ...(next.images || []).map((im) => ({ name: im.name, data: im.data, mimeType: im.mimeType })),
      ]);
    } catch (e) {
      if (isViewing) setError(String(e));
      setStatusBySession((prev) => ({ ...prev, [sid]: "idle" }));
    } finally {
      drainingBySessionRef.current.delete(sid);
    }
  }, []);

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
      if (e.data) setPermissionBySession((prev) => ({ ...prev, [e.data.sessionId]: e.data }));
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
      // 有 code 时按 code 经 i18n 翻译(harness 断连等稳定文案);否则用 detail;最后兜底。
      if (s.status === "error" && s.sessionId === selectedSessionIdRef.current) {
        setError(s.code ? t(`chat.error.${s.code}`) : (s.detail || t("app.errorFallback")));
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
        if (s.detail && s.detail.startsWith("stopReason=") && isNotifySoundEnabled()) {
          playNotifySound();
        }
        // 未读:回合结束但用户没在看的 session → 标记未读(供侧栏尾部小圆点提示)。
        if (s.sessionId !== selectedSessionIdRef.current) setUnreadBySession((p) => ({ ...p, [s.sessionId]: true }));
        const sid = selectedSessionIdRef.current;
        if (sid) { ChatService.SessionDiff(sid).then(d => setSessionDiff(d || "")).catch(() => {}); ChatService.SessionChanges(sid).then(setSessionChanges).catch(() => {}); }
      }
      // auto-continue:turn 结束(idle/error)→ 续发该 session 队列下一条(不限选中态,§1.6)。
      // 由 status 事件按 sessionId 直接触发(尊重数据源:status 事件是「哪个 session 该续发」的权威
      // 信号),后台 session 的队列也能自动续发。closed = idle reaper 回收,session 已关,不续发。
      // 用户主动停则 drainSession 内部按 per-session 标记跳过(队列保留)。
      if (s.status === "idle" || s.status === "error") {
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
    return () => {
      offUpdate();
      offPerm();
      offStatus();
      offMeta();
      offHarnesses();
    };
  }, [refreshProjects, applyEvent, refreshSessions, drainSession]);

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
      setUnreadBySession((prev) => { if (!prev[sessionId]) return prev; const n = { ...prev }; delete n[sessionId]; return n; });
      userStoppedBySessionRef.current.delete(sessionId);
      setError(null);
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
    },
    [messagesToItems, selectedProjectId, sessionsByProject]
  );

  // 加载更早的历史(分页翻页):取游标 seq 之前的 PAGE_SIZE 条,prepend 到现有 items 前面。
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
  const createSession = useCallback(async (projectId?: string) => {
    const pid = projectId ?? selectedProjectId;
    if (!pid) return;
    try {
      const [isGit, lastHarness] = await Promise.all([
        ChatService.IsGitProject(pid),
        ChatService.GetLastHarness(),
      ]);
      setNewSession({ projectId: pid, isGit, lastHarness });
    } catch (e) {
      setError(String(e));
    }
  }, [selectedProjectId]);

  // 用户在弹窗确认后真正创建 session。
  const confirmNewSession = useCallback(async (harness: string, useWorktree: boolean) => {
    const pid = newSession?.projectId;
    if (!pid) return;
    setNewSession(null);
    try {
      if (pid !== selectedProjectId) await selectProject(pid);
      const se = await ChatService.CreateSession(pid, "", harness, useWorktree);
      if (se) {
        setItemsBySession((prev) => ({ ...prev, [se.id]: [] }));
        setStatusBySession((prev) => ({ ...prev, [se.id]: "empty" }));
        loadedSessionsRef.current.add(se.id);
        await refreshSessions(pid);
        await openSession(se.id);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [newSession, selectedProjectId, refreshSessions, openSession, selectProject]);

  // 发送消息:idle 直发;prompting(一轮进行中)入前端队列,回合结束自动续发(§5.4 协议无 queue)。
  // mentions(@提及)经 ACP ContentBlock::ResourceLink 发给 agent;images(内联图片)经
  // ContentBlock::Image 发(需 agent 声明 image 能力)。入队时随 QueueItem 携带。
  // 只要按过发送键就记进输入框历史(上下键翻历史),无论后端是否成功/排队。
  const sendMessage = useCallback(
    async (text: string, mentions: Mention[], imgs?: ImageAttachment[]) => {
      if (!selectedSessionId || !text.trim()) return;
      // 立即滚到底让用户看到自己发的消息(即使是排队消息也要滚,用户需要看当前对话末尾)。
      chatViewRef.current?.scrollToBottom();
      // 记进历史(按发送键即记录,含排队/被拒的 —— 用户要求)
      setHistoryBySession((prev) => {
        const cur = prev[selectedSessionId] || [];
        if (cur[cur.length - 1] === text) return prev; // 与最后一条相同则不重复
        return { ...prev, [selectedSessionId]: [...cur, text] };
      });
      // 后端 attachments:@提及 + 回形针文件 → ResourceLink;内联图片 → Image 块(后端按 Data 字段分流)。
      const attachments = [
        ...mentions.map((m) => ({ path: m.path, name: m.name })),
        ...(imgs || []).map((im) => ({ name: im.name, data: im.data, mimeType: im.mimeType })),
      ];
      // 回合进行中(statusRef 防 stale closure):入队而非直发,避免后端 busy 报错。
      // statusRef.current 始终反映最新 status,闭包锁的 status 可能在 re-render 前仍为旧值。
      if (statusRef.current === "prompting") {
        const item: QueueItem = { id: `q-${Date.now()}-${selectedSessionId}`, text, mentions, images: imgs, scheduledAt: Date.now() };
        queueBySessionRef.current = {
          ...queueBySessionRef.current,
          [selectedSessionId]: [...(queueBySessionRef.current[selectedSessionId] || []), item],
        };
        setQueueBySession(queueBySessionRef.current);
        return;
      }
      // idle 直发
      setError(null);
      setStatusBySession((prev) => ({ ...prev, [selectedSessionId]: "prompting" }));
      try {
        await ChatService.SendMessage(selectedSessionId, text, attachments);
      } catch (e) {
        setError(String(e));
        setStatusBySession((prev) => ({ ...prev, [selectedSessionId]: "idle" }));
      }
    },
    [selectedSessionId]
  );

  // 回合结束 drainSession 自动续发(由 chat:status 事件按 sessionId 触发);idle 直发,status 由 chat:status 事件驱动。
  const stopSession = useCallback(async () => {
    if (!selectedSessionId) return;
    userStoppedBySessionRef.current.add(selectedSessionId); // 抑制本 session 下个 idle 的 auto-continue(用户主动停,不自动续发;队列保留)
    await ChatService.StopSession(selectedSessionId);
  }, [selectedSessionId]);

  // 继续会话:只读态(懒 spawn)下用户点「继续会话」时显式触发 spawn,切为可交互态。
  // 已活跃则后端 no-op。发新消息也会自动触发 spawn(走 SendMessage→ensureLive)。
  const continueSession = useCallback(async () => {
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    try {
      await ChatService.ContinueSession(sid);
    } catch (e) {
      setError(String(e));
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
    setError(null);
    userStoppedBySessionRef.current.delete(sid);
    setStatusBySession((prev) => ({ ...prev, [sid]: "prompting" }));
    try {
      await ChatService.InterruptAndSend(sid, item.text, [
        ...(item.mentions || []).map((m) => ({ path: m.path, name: m.name })),
        ...(item.images || []).map((im) => ({ name: im.name, data: im.data, mimeType: im.mimeType })),
      ]);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // 主动入队列:与「发送」并列的显式入队入口(Composer 入队列按钮 / ⌘⇧↩)。无论 idle/prompting
  // 都把消息压入该 session 的前端队列(Protocol 无 queue,回合结束由 chat:status 的 idle 事件自动续发)。
  // idle 时入队后需主动 drainSession 推一次队列 —— 否则没有 idle 事件触发、队列会静死;
  // prompting 时入队则等本轮结束的 idle 事件续发。主动入队 = 用户想继续,清掉该 session 的停意图
  // (与 interruptQueue 一致),否则被 Stop 标记抑制、入队却不续发。
  const enqueueMessage = useCallback(
    async (text: string, mentions: Mention[], imgs?: ImageAttachment[]) => {
      if (!selectedSessionId || !text.trim()) return;
      chatViewRef.current?.scrollToBottom();
      setHistoryBySession((prev) => {
        const cur = prev[selectedSessionId] || [];
        if (cur[cur.length - 1] === text) return prev; // 与最后一条相同则不重复
        return { ...prev, [selectedSessionId]: [...cur, text] };
      });
      const item: QueueItem = { id: `q-${Date.now()}-${selectedSessionId}`, text, mentions, images: imgs, scheduledAt: Date.now() };
      queueBySessionRef.current = {
        ...queueBySessionRef.current,
        [selectedSessionId]: [...(queueBySessionRef.current[selectedSessionId] || []), item],
      };
      setQueueBySession(queueBySessionRef.current);
      userStoppedBySessionRef.current.delete(selectedSessionId);
      // idle(非 prompting)时无 idle 事件会触发,需主动推一次队列,否则队列静死。
      if (statusRef.current !== "prompting") {
        void drainSession(selectedSessionId);
      }
    },
    [selectedSessionId, drainSession]
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

  const handleComposerAction = useCallback(
    (action: "clear" | "new" | "stop") => {
      if (action === "stop") {
        void stopSession();
      } else {
        void createSession();
      }
    },
    [stopSession, createSession]
  );

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
    } catch (e) { setError(String(e)); }
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
    catch (e) { setError(String(e)); }
  }, []);

  // 刷新模型列表:spawn probe harness 拉最新 configOptions(同步用户在 harness 配置里外部改动
  // 的新 provider/model)。后端成功后会推 config_option event 自动更新下拉,这里只管 loading/error。
  // 独立于当前对话流:即使 turn 正在跑也能刷新(后端 probe 是独立进程)。
  const refreshingConfig = !!(selectedSessionId && refreshingConfigBySession[selectedSessionId]);
  const refreshConfig = useCallback(async () => {
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    try {
      setError(null);
      setRefreshingConfigBySession((prev) => ({ ...prev, [sid]: true }));
      await ChatService.RefreshSessionConfig(sid);
    } catch (e) {
      setError(`${t("chat.refreshConfigFailed")}: ${String(e)}`);
    } finally {
      setRefreshingConfigBySession((prev) => ({ ...prev, [sid]: false }));
    }
  }, [t]);

  const [mergeResult, setMergeResult] = useState<string | null>(null);
  const [sessionDiff, setSessionDiff] = useState<string | null>(null);
  const [sessionChanges, setSessionChanges] = useState<FileChange[] | null>(null);
  const mergeSession = useCallback(async () => {
    if (!selectedSessionId) return;
    try {
      const result = await ChatService.MergeSession(selectedSessionId);
      setError(null);
      setMergeResult(result || t("app.mergeDone"));
      setTimeout(() => setMergeResult(null), 6000);
      // 合并后刷新 diff(变为"无变更")
      try { setSessionDiff(await ChatService.SessionDiff(selectedSessionId) || ""); } catch {}
    } catch (e) {
      const msg = t("app.mergeFailed", { error: String(e) });
      setError(msg);
      setMergeResult(msg);
      setTimeout(() => setMergeResult(null), 8000);
    }
  }, [selectedSessionId]);

  // SCM 操作:暂存 / 取消暂存 / 丢弃 / 提交。每次操作后刷新文件变更列表。
  const stageFiles = useCallback(async (paths: string[]) => {
    if (!selectedSessionId) return;
    try { await ChatService.SessionStage(selectedSessionId, paths); setError(null); }
    catch (e) { setError(String(e)); }
    finally { try { setSessionChanges(await ChatService.SessionChanges(selectedSessionId)); } catch {} }
  }, [selectedSessionId]);
  const unstageFiles = useCallback(async (paths: string[]) => {
    if (!selectedSessionId) return;
    try { await ChatService.SessionUnstage(selectedSessionId, paths); setError(null); }
    catch (e) { setError(String(e)); }
    finally { try { setSessionChanges(await ChatService.SessionChanges(selectedSessionId)); } catch {} }
  }, [selectedSessionId]);
  const discardFiles = useCallback(async (paths: string[]) => {
    if (!selectedSessionId) return;
    try { await ChatService.SessionDiscard(selectedSessionId, paths); setError(null); }
    catch (e) { setError(String(e)); }
    finally { try { setSessionChanges(await ChatService.SessionChanges(selectedSessionId)); } catch {} }
  }, [selectedSessionId]);
  // 提交:失败时 rethrow,让 GitPanel 保留提交信息 + 显示内联错误。
  const commitSession = useCallback(async (message: string) => {
    if (!selectedSessionId) throw new Error(t("app.noActiveSession"));
    try { await ChatService.SessionCommit(selectedSessionId, message); setError(null); }
    catch (e) { setError(String(e)); throw e; }
    finally { try { setSessionChanges(await ChatService.SessionChanges(selectedSessionId)); } catch {} }
  }, [selectedSessionId]);
  // AI 提交:让当前 session 的 agent 自动提交。触发一轮 turn;turn 结束(idle)时
  // 已有 effect 自动刷新 sessionChanges,故无需手动 finally 刷新。
  const aiCommit = useCallback(async () => {
    if (!selectedSessionId) throw new Error(t("app.noActiveSession"));
    try { await ChatService.SessionAICommit(selectedSessionId); setError(null); }
    catch (e) { setError(String(e)); throw e; }
  }, [selectedSessionId]);

  // 点击文件查看改动(staged 区分暂存/工作区上下文)。读操作,turn 进行中也允许。
  const fileDiff = useCallback(async (path: string, staged: boolean) => {
    if (!selectedSessionId) return "";
    return await ChatService.SessionFileDiff(selectedSessionId, path, staged);
  }, [selectedSessionId]);

  const addProject = useCallback(async () => {
    try {
      const path = await ChatService.PickDirectory();
      if (!path) return;
      await ChatService.AddProject("", path, "");
      await refreshProjects();
    } catch (e) {
      setError(String(e));
    }
  }, [refreshProjects]);

  // 按路径添加项目(侧栏路径输入框 Enter 提交)。与 addProject(文件选择器)互补。
  const addProjectByPath = useCallback(async (path: string) => {
    try {
      await ChatService.AddProject("", path, "");
      await refreshProjects();
    } catch (e) {
      setError(String(e));
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

  // 删除 session:后端关 harness + 清 worktree + 删 DB;前端清掉该 session 的所有 per-session 缓存 + 从侧栏列表移除,
  // 若是当前选中则清空选中态。删除是硬删除(DB 记录也没了),不可恢复。
  const removeSession = useCallback(
    async (sessionId: string) => {
      await ChatService.DeleteSession(sessionId);
      const drop = <T,>(prev: Record<string, T>) => { if (!(sessionId in prev)) return prev; const n = { ...prev }; delete n[sessionId]; return n; };
      void TerminalService.KillSessionTerminals(sessionId);
      setTermTabsBySession(drop);
      setActiveTermBySession(drop);
      setTermOpenBySession(drop);
      setSessionsByProject((prev) => {
        const next: Record<string, Session[]> = {};
        for (const [pid, list] of Object.entries(prev)) next[pid] = list.filter((s) => s.id !== sessionId);
        return next;
      });
      setItemsBySession(drop);
      setHasMoreBySession(drop);
      setUsageBySession(drop);
      setStatusBySession(drop);
      setStatusDetailBySession(drop);
      setActivityBySession(drop);
      setUnreadBySession(drop);
      setPermissionBySession(drop);
      setQueueBySession(drop);
      setDraftBySession(drop);
      setHistoryBySession(drop);
      setAttachmentsBySession(drop);
      setMentionsBySession(drop);
      setImagesBySession(drop);
      setImageSupportedBySession(drop);
      setConfigOptionsBySession(drop);
      queueBySessionRef.current = drop(queueBySessionRef.current);
      userStoppedBySessionRef.current.delete(sessionId);
      drainingBySessionRef.current.delete(sessionId);
      delete oldestSeqRef.current[sessionId];
      loadedSessionsRef.current.delete(sessionId);
      historySeededRef.current.delete(sessionId);
      configSeededRef.current.delete(sessionId);
      if (selectedSessionId === sessionId) setSelectedSessionId(null);
    },
    [selectedSessionId]
  );

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
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const syncCollapsed = (ref: RefObject<PanelImperativeHandle | null>, set: (v: boolean) => void) => {
    const c = ref.current?.isCollapsed();
    if (c != null) set(c);
  };
  const collapseSidebar = () => sidebarPanelRef.current?.collapse();
  const expandSidebar = () => sidebarPanelRef.current?.expand();
  const collapseSide = () => sidePanelRef.current?.collapse();
  const expandSide = () => sidePanelRef.current?.expand();



  return (
    <>
    <Group
      orientation="horizontal"
      className="app"
      id="monkey-deck-layout"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      data-sidebar-collapsed={leftCollapsed ? "true" : "false"}
    >
      <Panel
        id="sidebar"
        defaultSize="18%"
        minSize="12%"
        maxSize="30%"
        collapsible
        collapsedSize={0}
        panelRef={sidebarPanelRef}
        onResize={() => syncCollapsed(sidebarPanelRef, setLeftCollapsed)}
      >
        <Sidebar
          projects={projects}
          selectedProjectId={selectedProjectId}
          sessionsByProject={sessionsByProject}
          selectedSessionId={selectedSessionId}
          onSelectProject={selectProject}
          onSelectSession={openSession}
          onCreateSession={createSession}
          onAddProject={addProject}
          onAddProjectByPath={addProjectByPath}
          permPendingBySession={permPendingBySession}
          draftBySession={draftBySession}
          hasTermBySession={hasTermBySession}
          onRemoveProject={removeProject}
          onRemoveSession={removeSession}
          onTogglePin={toggleSessionPin}
          statusBySession={statusBySession}
          activityBySession={activityBySession}
          unreadBySession={unreadBySession}
          harnesses={harnesses}
          onReorderProjects={reorderProjects}
          onCollapse={collapseSidebar}
          onOpenSettings={() => setSettingsOpen(true)}
          harnessUpdateAvailable={harnessUpdateAvailable}
        />
      </Panel>
      {!leftCollapsed && <Separator className="resize-handle" />}
      <Panel id="main" minSize="30%">
        <main className="main">
          {selectedSessionId ? (
            <Group orientation="vertical" id="main-vertical" className="main-vertical">
              <Panel id="chat-area" minSize="20%">
            <ChatView
              ref={chatViewRef}
              project={selectedProject}
              session={sessions.find((s) => s.id === selectedSessionId) || null}
              items={items}
              status={status}
              statusDetail={statusDetail}
              usage={usage}
              error={error}
              permission={permission}
              onSend={sendMessage}
              onEnqueue={enqueueMessage}
              onStop={stopSession}
              onContinue={continueSession}
              onAction={handleComposerAction}
              onRespondPermission={respondPermission}
              onToggleTerminal={toggleTerminalPanel}
              onRefreshConfig={refreshConfig}
              refreshingConfig={refreshingConfig}
              onMerge={mergeSession}
              mergeResult={mergeResult}
              sessionDiff={sessionDiff}
              queue={queue}
              onInterruptQueue={interruptQueue}
              onRevokeQueue={revokeQueue}
              onEditQueue={editQueueItem}
              composerValue={composerValue}
              onComposerChange={onComposerChange}
              attachments={attachments}
              onAttachmentsChange={onAttachmentsChange}
              mentions={mentions}
              onMentionsChange={onMentionsChange}
              images={images}
              onImagesChange={onImagesChange}
              imageSupported={imageSupported}
              history={history}
              activity={activityBySession[selectedSessionId]}
              sessionId={selectedSessionId}
              configOptions={configOptions}
              livePlan={livePlan}
              onSetConfig={setSessionConfig}
              hasMore={hasMore}
              loadingMore={loadingMore}
              onLoadMore={() => selectedSessionId && loadMoreMessages(selectedSessionId)}
            />
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
      </Panel>
      {!rightCollapsed && <Separator className="resize-handle" />}
      <Panel
        id="side"
        defaultSize="20%"
        minSize="14%"
        maxSize="34%"
        collapsible
        collapsedSize={0}
        panelRef={sidePanelRef}
        onResize={() => syncCollapsed(sidePanelRef, setRightCollapsed)}
      >
        {selectedSessionId && activeSession ? (
          <SidePanel
            sessionId={selectedSessionId}
            rootName={selectedProject?.name || ""}
            isGitProject={gitByProject[selectedProject?.id ?? ""] ?? false}
            changes={sessionChanges}
            status={status}
            branch={branchBySession[selectedSessionId] || activeSession.branch || ""}
            mergeResult={mergeResult}
            onMerge={mergeSession}
            onStage={stageFiles}
            onUnstage={unstageFiles}
            onDiscard={discardFiles}
            onCommit={commitSession}
            onAICommit={aiCommit}
            onDiff={fileDiff}
            busy={status === "prompting"}
            onCollapse={collapseSide}
          />
        ) : (
          <div className="side-empty" />
        )}
      </Panel>
    </Group>
    {leftCollapsed && (
      <button
        type="button"
        className="panel-rail left"
        onClick={expandSidebar}
        data-testid="expand-sidebar"
        aria-label={t("app.expandSidebar")}
        data-tooltip-id="md-tip"
        data-tooltip-content={t("app.expandSidebar")}
        data-tooltip-place="right"
      >
        <PanelLeftOpen size={14} />
      </button>
    )}
    {rightCollapsed && (
      <button
        type="button"
        className="panel-rail right"
        onClick={expandSide}
        data-testid="expand-side"
        aria-label={t("app.expandSidePanel")}
        data-tooltip-id="md-tip"
        data-tooltip-content={t("app.expandSidePanel")}
        data-tooltip-place="left"
      >
        <PanelRightOpen size={14} />
      </button>
    )}
    {newSession && (
      <NewSessionModal
        harnesses={harnesses}
        isGit={newSession.isGit}
        lastHarness={newSession.lastHarness}
        onConfirm={confirmNewSession}
        onCancel={() => setNewSession(null)}
      />
    )}
    {settingsOpen && (
      <SettingsPanel onClose={() => setSettingsOpen(false)} harnessUpdateAvailable={harnessUpdateAvailable} />
    )}
    <Tooltip id="md-tip" delayShow={isMac ? 1500 : 500} />
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
