import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import * as ChatService from "../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import * as TerminalService from "../bindings/github.com/jessonchan/monkey-deck/internal/terminal/terminalservice";
import { Project, Session, Message } from "../bindings/github.com/jessonchan/monkey-deck/internal/store/models";
import type { ChatItem, ConfigOption, PermissionPrompt, SessionEvent, StatusPayload, QueueItem, Mention } from "./types";
import Sidebar from "./components/Sidebar";
import ChatView, { type ChatViewHandle } from "./components/ChatView";
import { Sparkles } from "lucide-react";
import SidePanel from "./components/SidePanel";
import TerminalPanel from "./components/TerminalPanel";
import type { TerminalTab } from "./lib/terminalTypes";
import { disposeTerminal } from "./lib/termRegistry";
import NewSessionModal from "./components/NewSessionModal";
import type { Harness } from "../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { Tooltip } from "react-tooltip";
import type { FileChange } from "../bindings/github.com/jessonchan/monkey-deck/internal/worktree/models";
import { applyEventToItems as applyEventToItemsPure } from "./lib/streamMerge";
const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

// 按 session 隔离的状态:切走再切回时,进行中的流式输出 / 用量 / 状态 / 权限都保留在各自缓存里,
// 不会因「切走→事件被丢弃→切回只剩 DB 已落库内容」而丢失正在输出的内容。

type Usage = { used: number; size: number; cost: number };
const EMPTY_USAGE: Usage = { used: 0, size: 0, cost: 0 };

// 分页:首次打开只加载最近 PAGE_SIZE 条,滚到顶部点「加载更多」继续往前翻(游标 = 最旧 seq)。
const PAGE_SIZE = 30;

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [gitByProject, setGitByProject] = useState<Record<string, boolean>>({});
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
  const [queueBySession, setQueueBySession] = useState<Record<string, QueueItem[]>>({});  // 前端 FIFO 队列(按 session 隔离,切走保留)
  const [draftBySession, setDraftBySession] = useState<Record<string, string>>({});  // composer 草稿(按 session 隔离,切走保留)
  const [historyBySession, setHistoryBySession] = useState<Record<string, string[]>>({});  // 输入框历史(上下键翻):按 session 隔离,seed 自 DB + 每次发送追加
  const [attachmentsBySession, setAttachmentsBySession] = useState<Record<string, string[]>>({});  // composer 回形针附件(按 session 隔离,切走保留)
  const [mentionsBySession, setMentionsBySession] = useState<Record<string, Mention[]>>({});  // composer @提及(按 session 隔离,切走保留)
  const [configOptionsBySession, setConfigOptionsBySession] = useState<Record<string, ConfigOption[]>>({}); // model/mode/effort(agent 自报)
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const [newSession, setNewSession] = useState<{ projectId: string; isGit: boolean } | null>(null);  // 新建对话弹窗
  // 集成终端(per-session,与 agent ACP 通道完全分离;§1.1 agent 永远走 ACP)。
  // 终端面板开关也 per-session:session A 开着,切到 B 时 B 按自己的状态显示(各自独立)。
  const [termTabsBySession, setTermTabsBySession] = useState<Record<string, TerminalTab[]>>({});
  const [activeTermBySession, setActiveTermBySession] = useState<Record<string, string | null>>({});
  const [termOpenBySession, setTermOpenBySession] = useState<Record<string, boolean>>({});
  const termCwdRef = useRef("");
  const queueBySessionRef = useRef<Record<string, QueueItem[]>>({});
  const userStoppedRef = useRef(false);                    // 用户主动停止:抑制该次 idle 的 auto-continue
  // status 派生值的 ref:sendMessage 闭包锁 status 导致「prompting 时仍直发 → 后端报 busy」,
  // 用 ref 绕过 stale closure,读取最新的派生 status。
  const statusRef = useRef<string>("empty");

  // 选中项目的 sessions(派生);sessionsByProject 是全量按项目分组,供侧栏多项目同时展开。
  const sessions = (selectedProjectId ? sessionsByProject[selectedProjectId] : undefined) ?? [];

  // 标记哪些 session 已从 DB 加载进缓存;有缓存(含进行中的流式)就不再重读 DB,避免切回丢内容。
  const loadedSessionsRef = useRef<Set<string>>(new Set());
  // 输入框历史 seed 标记:避免 openSession 读 historyBySession(state)产生 stale closure,重开 session 误覆盖内存追加。
  const historySeededRef = useRef<Set<string>>(new Set());
  // 选中 session 的 ref:仅用于 status 事件的「错误只弹当前查看会话」过滤,不进 effect 依赖(避免每次切换都重订阅)。
  const selectedSessionIdRef = useRef<string | null>(null);
  const chatViewRef = useRef<ChatViewHandle>(null);
  selectedSessionIdRef.current = selectedSessionId;
  // sessionsByProject 的 ref:status 事件 handler 里查「session 属于哪个 project」用,
  // 不进 effect 依赖(避免每次 sessionsByProject 变化都重订阅事件)。
  const sessionsByProjectRef = useRef(sessionsByProject);
  sessionsByProjectRef.current = sessionsByProject;

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
        return { ...prev, [ev.sessionId]: { used: ev.used ?? old.used, size: ev.size ?? old.size, cost: ev.cost ?? old.cost } };
      });
      return;
    }
    if (ev.kind === "config_option") {
      // agent 自报的 config options(model/mode/effort),前端渲染下拉;切 model/effort 经 SetSessionConfigOption 回写。
      setConfigOptionsBySession((prev) => ({ ...prev, [ev.sessionId]: ev.configOptions ?? [] }));
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
  const configOptions = (selectedSessionId ? configOptionsBySession[selectedSessionId] : undefined) ?? [];
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

  // 启动:加载项目 + 订阅事件。
  useEffect(() => {
    void refreshProjects();
    ChatService.ListHarnesses().then((h) => setHarnesses(h ?? [])).catch(() => {});
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
      setStatusBySession((prev) => ({ ...prev, [s.sessionId]: s.status }));
      setStatusDetailBySession((prev) => ({ ...prev, [s.sessionId]: s.detail || "" }));
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
      if (s.status === "error" && s.sessionId === selectedSessionIdRef.current) setError(s.detail || "出错");
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
        setActivityBySession((p) => { if (!p[s.sessionId]) return p; const n = { ...p }; delete n[s.sessionId]; return n; });
      }
      // 回合结束后刷新 Git 面板的 diff(agent 可能改了文件)
      if (s.status === "idle") {
        // 未读:回合结束但用户没在看的 session → 标记未读(供侧栏尾部小圆点提示)。
        if (s.sessionId !== selectedSessionIdRef.current) setUnreadBySession((p) => ({ ...p, [s.sessionId]: true }));
        const sid = selectedSessionIdRef.current;
        if (sid) { ChatService.SessionDiff(sid).then(d => setSessionDiff(d || "")).catch(() => {}); ChatService.SessionChanges(sid).then(setSessionChanges).catch(() => {}); }
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
    };
  }, [refreshProjects, applyEvent, refreshSessions]);

  // 多项目同时展开:项目列表就绪后,把每个项目的 sessions 都加载进 map(本地 SQLite,快)。
  useEffect(() => {
    for (const p of projects) {
      if (!(p.id in sessionsByProject)) void refreshSessions(p.id);
    }
  }, [projects, sessionsByProject, refreshSessions]);

  // auto-continue:status 转 idle 时,若非用户主动停止且队列非空,自动发下一条(FIFO)。
  // 每条排队消息 = 一个独立 turn,按序逐个发(协议无 queue,一次只一个 Prompt)。
  const drainQueue = useCallback(async () => {
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    const q = queueBySessionRef.current[sid] || [];
    if (q.length === 0) return;
    const next = q[0];
    queueBySessionRef.current = { ...queueBySessionRef.current, [sid]: q.slice(1) };
    setQueueBySession(queueBySessionRef.current);
    setError(null);
    setStatusBySession((prev) => ({ ...prev, [sid]: "prompting" }));
    try {
      await ChatService.SendMessage(sid, next.text, (next.mentions || []).map((m) => ({ path: m.path, name: m.name })));
    } catch (e) {
 setError(String(e));
      setStatusBySession((prev) => ({ ...prev, [sid]: "idle" }));
    }
  }, []);
  useEffect(() => {
    // idle 和 error 都触发 drain:error 时(如 peer disconnected)队列不能卡死,
    // 下一条会走 ensureLive 重连。用户主动停则不续发(队列保留)。
    if (status !== "idle" && status !== "error") return;
    if (userStoppedRef.current) { userStoppedRef.current = false; return; }
    void drainQueue();
  }, [status, drainQueue]);

  // 把持久化消息转成展示 items。
  const messagesToItems = useCallback((msgs: Message[]): ChatItem[] => {
    return msgs.map((m): ChatItem => {
      if (m.role === "user") return { type: "user", id: m.id, text: m.content, ts: m.createdAt };
      if (m.role === "agent") return { type: "agent", id: m.id, text: m.content, ts: m.createdAt };
      if (m.role === "thought") return { type: "thought", id: m.id, text: m.content, ts: m.createdAt };
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
      if (projectId && projectId !== selectedProjectId) setSelectedProjectId(projectId);
      setSelectedSessionId(sessionId);
      setUnreadBySession((prev) => { if (!prev[sessionId]) return prev; const n = { ...prev }; delete n[sessionId]; return n; });
      userStoppedRef.current = false;
      setError(null);
      await ChatService.OpenSession(sessionId);
      // 从持久化的 session 用量恢复 token 占比(无 live 记录时),使重开会话不归零(§1.6)。
      const se = (pid ? sessionsByProject[pid] : undefined)?.find((x) => x.id === sessionId);
      setUsageBySession((prev) => {
        if (prev[sessionId]) return prev;
        return { ...prev, [sessionId]: { used: se?.usedTokens ?? 0, size: se?.sizeTokens ?? 0, cost: se?.cost ?? 0 } };
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
      try {
        const diff = await ChatService.SessionDiff(sessionId);
        setSessionDiff(diff || "");
      } catch {
        setSessionDiff("");
      }
      try {
        setSessionChanges(await ChatService.SessionChanges(sessionId));
      } catch { setSessionChanges(null); }
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
  const createSession = useCallback(async (projectId?: string) => {
    const pid = projectId ?? selectedProjectId;
    if (!pid) return;
    try {
      const isGit = await ChatService.IsGitProject(pid);
      setNewSession({ projectId: pid, isGit });
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
  // mentions(@提及)经 ACP ContentBlock::ResourceLink 发给 agent;入队时随 QueueItem 携带。
  // 只要按过发送键就记进输入框历史(上下键翻历史),无论后端是否成功/排队。
  const sendMessage = useCallback(
    async (text: string, mentions: Mention[]) => {
      if (!selectedSessionId || !text.trim()) return;
      // 立即滚到底让用户看到自己发的消息(即使是排队消息也要滚,用户需要看当前对话末尾)。
      chatViewRef.current?.scrollToBottom();
      // 记进历史(按发送键即记录,含排队/被拒的 —— 用户要求)
      setHistoryBySession((prev) => {
        const cur = prev[selectedSessionId] || [];
        if (cur[cur.length - 1] === text) return prev; // 与最后一条相同则不重复
        return { ...prev, [selectedSessionId]: [...cur, text] };
      });
      const attachments = mentions.map((m) => ({ path: m.path, name: m.name }));
      // 回合进行中(statusRef 防 stale closure):入队而非直发,避免后端 busy 报错。
      // statusRef.current 始终反映最新 status,闭包锁的 status 可能在 re-render 前仍为旧值。
      if (statusRef.current === "prompting") {
        const item: QueueItem = { id: `q-${Date.now()}-${selectedSessionId}`, text, mentions };
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

  // 回合结束 drainQueue 自动续发(见下方 effect);idle 直发,status 由 chat:status 事件驱动。
  const stopSession = useCallback(async () => {
    if (!selectedSessionId) return;
    userStoppedRef.current = true; // 抑制本次 idle 的 auto-continue(用户主动停,不自动续发;队列保留)
    await ChatService.StopSession(selectedSessionId);
  }, [selectedSessionId]);

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
    userStoppedRef.current = false;
    setStatusBySession((prev) => ({ ...prev, [sid]: "prompting" }));
    try {
      await ChatService.InterruptAndSend(sid, item.text, (item.mentions || []).map((m) => ({ path: m.path, name: m.name })));
    } catch (e) {
      setError(String(e));
    }
  }, []);

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
      const title = cwd ? (cwd.replace(/\/$/, "").split("/").pop() || "终端") : "终端";
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

  const [mergeResult, setMergeResult] = useState<string | null>(null);
  const [sessionDiff, setSessionDiff] = useState<string | null>(null);
  const [sessionChanges, setSessionChanges] = useState<FileChange[] | null>(null);
  const mergeSession = useCallback(async () => {
    if (!selectedSessionId) return;
    try {
      const result = await ChatService.MergeSession(selectedSessionId);
      setError(null);
      setMergeResult(result || "✅ 合并完成");
      setTimeout(() => setMergeResult(null), 6000);
      // 合并后刷新 diff(变为"无变更")
      try { setSessionDiff(await ChatService.SessionDiff(selectedSessionId) || ""); } catch {}
    } catch (e) {
      const msg = "❌ 合并失败: " + String(e);
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
    if (!selectedSessionId) throw new Error("无活动 session");
    try { await ChatService.SessionCommit(selectedSessionId, message); setError(null); }
    catch (e) { setError(String(e)); throw e; }
    finally { try { setSessionChanges(await ChatService.SessionChanges(selectedSessionId)); } catch {} }
  }, [selectedSessionId]);
  // AI 提交:让当前 session 的 agent 自动提交。触发一轮 turn;turn 结束(idle)时
  // 已有 effect 自动刷新 sessionChanges,故无需手动 finally 刷新。
  const aiCommit = useCallback(async () => {
    if (!selectedSessionId) throw new Error("无活动 session");
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
      setConfigOptionsBySession(drop);
      queueBySessionRef.current = drop(queueBySessionRef.current);
      delete oldestSeqRef.current[sessionId];
      loadedSessionsRef.current.delete(sessionId);
      historySeededRef.current.delete(sessionId);
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



  return (
    <>
    <Group
      orientation="horizontal"
      className="app"
      id="monkey-deck-layout"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      <Panel id="sidebar" defaultSize="18%" minSize="12%" maxSize="30%">
        <Sidebar
          projects={projects}
          selectedProjectId={selectedProjectId}
          sessionsByProject={sessionsByProject}
          selectedSessionId={selectedSessionId}
          onSelectProject={selectProject}
          onSelectSession={openSession}
          onCreateSession={createSession}
          onAddProject={addProject}
          permPendingBySession={permPendingBySession}
          draftBySession={draftBySession}
          onRemoveProject={removeProject}
          onRemoveSession={removeSession}
          onTogglePin={toggleSessionPin}
          statusBySession={statusBySession}
          activityBySession={activityBySession}
          unreadBySession={unreadBySession}
          onReorderProjects={reorderProjects}
        />
      </Panel>
      <Separator className="resize-handle" />
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
              onStop={stopSession}
              onAction={handleComposerAction}
              onRespondPermission={respondPermission}
              onToggleTerminal={toggleTerminalPanel}
              onMerge={mergeSession}
              mergeResult={mergeResult}
              sessionDiff={sessionDiff}
              queue={queue}
              onInterruptQueue={interruptQueue}
              onRevokeQueue={revokeQueue}
              composerValue={composerValue}
              onComposerChange={onComposerChange}
              attachments={attachments}
              onAttachmentsChange={onAttachmentsChange}
              mentions={mentions}
              onMentionsChange={onMentionsChange}
              history={history}
              activity={activityBySession[selectedSessionId]}
              sessionId={selectedSessionId}
              configOptions={configOptions}
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
      <Separator className="resize-handle" />
      <Panel id="side" defaultSize="20%" minSize="14%" maxSize="34%">
        {selectedSessionId && activeSession ? (
          <SidePanel
            sessionId={selectedSessionId}
            rootName={selectedProject?.name || ""}
            isGitProject={gitByProject[selectedProject?.id ?? ""] ?? false}
            changes={sessionChanges}
            status={status}
            branch={activeSession.branch || ""}
            mergeResult={mergeResult}
            onMerge={mergeSession}
            onStage={stageFiles}
            onUnstage={unstageFiles}
            onDiscard={discardFiles}
            onCommit={commitSession}
            onAICommit={aiCommit}
            onDiff={fileDiff}
            busy={status === "prompting"}
          />
        ) : (
          <div className="side-empty" />
        )}
      </Panel>
    </Group>
    {newSession && (
      <NewSessionModal
        harnesses={harnesses}
        isGit={newSession.isGit}
        onConfirm={confirmNewSession}
        onCancel={() => setNewSession(null)}
      />
    )}
    <Tooltip id="md-tip" delayShow={isMac ? 1500 : 500} />
    </>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-logo"><Sparkles size={30} /></div>
      <h2>Monkey Deck</h2>
      <p>ACP 桌面客户端 · 以项目目录为锚点管理编码 agent 对话</p>
      <p className="empty-hint">← 在左侧添加一个项目目录开始</p>
    </div>
  );
}
