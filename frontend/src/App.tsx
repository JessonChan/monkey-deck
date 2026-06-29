import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import * as ChatService from "../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import { Project, Session, Message } from "../bindings/github.com/jessonchan/monkey-deck/internal/store/models";
import type { ChatItem, PermissionPrompt, SessionEvent, StatusPayload, QueueItem } from "./types";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import { Sparkles } from "lucide-react";
import SidePanel from "./components/SidePanel";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import type { FileChange } from "../bindings/github.com/jessonchan/monkey-deck/internal/worktree/models";

// 按 session 隔离的状态:切走再切回时,进行中的流式输出 / 用量 / 状态 / 权限都保留在各自缓存里,
// 不会因「切走→事件被丢弃→切回只剩 DB 已落库内容」而丢失正在输出的内容。
type Usage = { used: number; size: number; cost: number };
const EMPTY_USAGE: Usage = { used: 0, size: 0, cost: 0 };

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const [itemsBySession, setItemsBySession] = useState<Record<string, ChatItem[]>>({});
  const [usageBySession, setUsageBySession] = useState<Record<string, Usage>>({});
  const [statusBySession, setStatusBySession] = useState<Record<string, StatusPayload["status"] | "empty">>({});
  const [statusDetailBySession, setStatusDetailBySession] = useState<Record<string, string>>({});
  const [permissionBySession, setPermissionBySession] = useState<Record<string, PermissionPrompt | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);     // 前端 FIFO 队列(turn 中发的消息)
  const [composerValue, setComposerValue] = useState("");  // composer 受控文本(支持撤回回填)
  const queueRef = useRef<QueueItem[]>([]);
  const userStoppedRef = useRef(false);                    // 用户主动停止:抑制该次 idle 的 auto-continue

  // 标记哪些 session 已从 DB 加载进缓存;有缓存(含进行中的流式)就不再重读 DB,避免切回丢内容。
  const loadedSessionsRef = useRef<Set<string>>(new Set());
  // 选中 session 的 ref:仅用于 status 事件的「错误只弹当前查看会话」过滤,不进 effect 依赖(避免每次切换都重订阅)。
  const selectedSessionIdRef = useRef<string | null>(null);
  selectedSessionIdRef.current = selectedSessionId;

  const refreshProjects = useCallback(async () => {
    const list = await ChatService.ListProjects();
    setProjects(list || []);
  }, []);

  const refreshSessions = useCallback(async (projectId: string) => {
    const list = await ChatService.ListSessions(projectId);
    setSessions(list || []);
  }, []);

  // 把一条 SessionEvent 合并进指定 session 的 items(纯函数,防乱序)。
  const applyEventToItems = useCallback((cur: ChatItem[], ev: SessionEvent): ChatItem[] => {
    const next = [...cur];
    const last = next[next.length - 1];
    switch (ev.kind) {
      case "user_message_chunk":
        if (last && last.type === "user") return next; // 已有 user,不重复
        next.push({ type: "user", id: `u-${Date.now()}`, text: ev.text || "", ts: Date.now() });
        return next;
      case "agent_message_chunk":
        if (last && last.type === "agent" && last.streaming) {
          // 累积全文 + 序号:序号更小(乱序迟到)则忽略,否则替换(非追加,防乱码)
          if (ev.seq == null || last.seq == null || ev.seq >= last.seq) {
            next[next.length - 1] = { ...last, text: ev.text || "", seq: ev.seq };
          }
        } else {
          next.push({ type: "agent", id: `a-${ev.seq ?? Date.now()}`, text: ev.text || "", streaming: true, seq: ev.seq, ts: Date.now() });
        }
        return next;
      case "agent_thought_chunk":
        if (last && last.type === "thought" && last.streaming) {
          if (ev.seq == null || last.seq == null || ev.seq >= last.seq) {
            next[next.length - 1] = { ...last, text: ev.text || "", seq: ev.seq };
          }
        } else {
          next.push({ type: "thought", id: `t-${ev.seq ?? Date.now()}`, text: ev.text || "", streaming: true, seq: ev.seq });
        }
        return next;
      case "tool_call":
      case "tool_call_update": {
        const id = ev.toolCallId || `tool-${Date.now()}`;
        const idx = next.findIndex((it) => it.type === "tool" && it.id === id);
        const existing = idx >= 0 ? (next[idx] as Extract<ChatItem, { type: "tool" }>) : null;
        const toolItem = {
          type: "tool" as const,
          id,
          title: ev.toolTitle || existing?.title || "",
          status: ev.toolStatus || existing?.status || "pending",
          kind: ev.toolKind || existing?.kind || "",
          rawInput: ev.rawInput ?? existing?.rawInput,
          rawOutput: ev.rawOutput ?? existing?.rawOutput,
        };
        if (idx >= 0) next[idx] = toolItem;
        else next.push(toolItem);
        return next;
      }
      case "session_info":
      default:
        return next;
    }
  }, []);

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
  const statusDetail = (selectedSessionId ? statusDetailBySession[selectedSessionId] : undefined) ?? "";
  const permission = (selectedSessionId ? permissionBySession[selectedSessionId] : undefined) ?? null;

  // 启动:加载项目 + 订阅事件。
  useEffect(() => {
    void refreshProjects();
    const offUpdate = Events.On("chat:event", (e: { data: SessionEvent }) => {
      if (e.data) applyEvent(e.data);
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
      // 错误提示只对当前查看的 session 弹(切走时不在意别的 session 的错误条)。
      if (s.status === "error" && s.sessionId === selectedSessionIdRef.current) setError(s.detail || "出错");
      // 回合结束:清掉该 session 最后 agent/thought 的 streaming 标志(去光标 + 显复制按钮)。
      if (s.status === "idle" || s.status === "error") {
        setItemsBySession((prev) => {
          const cur = prev[s.sessionId];
          if (!cur) return prev;
          return {
            ...prev,
            [s.sessionId]: cur.map((it) => (it.type === "agent" || it.type === "thought" ? { ...it, streaming: false } : it)),
          };
        });
      }
      // 回合结束后刷新 Git 面板的 diff(agent 可能改了文件)
      if (s.status === "idle") {
        const sid = selectedSessionIdRef.current;
        if (sid) { ChatService.SessionDiff(sid).then(d => setSessionDiff(d || "")).catch(() => {}); ChatService.SessionChanges(sid).then(setSessionChanges).catch(() => {}); }
      }
    });
    const offMeta = Events.On("chat:session-meta", (e: { data: { sessionId: string; title: string } }) => {
      const m = e.data;
      if (!m || !m.title) return;
      setSessions((prev) => prev.map((s) => (s.id === m.sessionId ? { ...s, title: m.title } : s)));
    });
    return () => {
      offUpdate();
      offPerm();
      offStatus();
      offMeta();
    };
  }, [refreshProjects, applyEvent]);

  // auto-continue:status 转 idle 时,若非用户主动停止且队列非空,自动发下一条(FIFO)。
  // 每条排队消息 = 一个独立 turn,按序逐个发(协议无 queue,一次只一个 Prompt)。
  const drainQueue = useCallback(async () => {
    const q = queueRef.current;
    if (q.length === 0) return;
    const next = q[0];
    queueRef.current = q.slice(1);
    setQueue(queueRef.current);
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    setError(null);
    setStatusBySession((prev) => ({ ...prev, [sid]: "prompting" }));
    try {
      await ChatService.SendMessage(sid, next.text);
    } catch (e) {
 setError(String(e));
      setStatusBySession((prev) => ({ ...prev, [sid]: "idle" }));
    }
  }, []);
  useEffect(() => {
    if (status !== "idle") return;
    if (userStoppedRef.current) { userStoppedRef.current = false; return; } // 用户主动停:不自动续发
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

  // 选项目 → 加载 sessions。
  const selectProject = useCallback(
    async (projectId: string) => {
      setSelectedProjectId(projectId);
      setSelectedSessionId(null);
      setQueue([]); queueRef.current = []; setComposerValue("");
      userStoppedRef.current = false;
      await refreshSessions(projectId);
    },
    [refreshSessions]
  );

  // 打开 session:OpenSession + 加载历史。
  // 关键:有缓存(含进行中的流式)就保留缓存,仅首次打开才从 DB 读 —— 否则切回会丢正在输出的内容。
  const openSession = useCallback(
    async (sessionId: string) => {
      setSelectedSessionId(sessionId);
      setPermissionBySession((prev) => ({ ...prev, [sessionId]: null }));
      setQueue([]); queueRef.current = []; setComposerValue("");
      userStoppedRef.current = false;
      setError(null);
      await ChatService.OpenSession(sessionId);
      // 从持久化的 session 用量恢复 token 占比(无 live 记录时),使重开会话不归零(§1.6)。
      setUsageBySession((prev) => {
        if (prev[sessionId]) return prev;
        const se = sessions.find((x) => x.id === sessionId);
        return { ...prev, [sessionId]: { used: se?.usedTokens ?? 0, size: se?.sizeTokens ?? 0, cost: se?.cost ?? 0 } };
      });
      if (!loadedSessionsRef.current.has(sessionId)) {
        loadedSessionsRef.current.add(sessionId);
        const msgs = await ChatService.LoadMessages(sessionId);
        setItemsBySession((prev) => ({ ...prev, [sessionId]: messagesToItems(msgs || []) }));
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
    [messagesToItems, sessions]
  );

  // 新建 session。
  const createSession = useCallback(async () => {
    if (!selectedProjectId) return;
    try {
      const se = await ChatService.CreateSession(selectedProjectId, "");
      if (se) {
        await refreshSessions(selectedProjectId);
        await openSession(se.id);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [selectedProjectId, refreshSessions, openSession]);

  // 发送消息:idle 直发;prompting(一轮进行中)入前端队列,回合结束自动续发(§5.4 协议无 queue)。
  const sendMessage = useCallback(
    async (text: string) => {
      if (!selectedSessionId || !text.trim()) return;
      if (status === "prompting") {
        const item: QueueItem = { id: "q" + Date.now() + Math.random().toString(36).slice(2, 6), text };
        queueRef.current = [...queueRef.current, item];
        setQueue(queueRef.current);
        return;
      }
      setError(null);
      setStatusBySession((prev) => ({ ...prev, [selectedSessionId]: "prompting" }));
      try {
        await ChatService.SendMessage(selectedSessionId, text);
      } catch (e) {
        setError(String(e));
        setStatusBySession((prev) => ({ ...prev, [selectedSessionId]: "idle" }));
      }
    },
    [selectedSessionId, status]
  );

  const stopSession = useCallback(async () => {
    if (!selectedSessionId) return;
    userStoppedRef.current = true; // 抑制本次 idle 的 auto-continue(用户主动停,不自动续发;队列保留)
    await ChatService.StopSession(selectedSessionId);
  }, [selectedSessionId]);

  // 立即发送:打断当前 turn,这条插队先发(其余保留排队)。后端 InterruptAndSend 原子完成
  // (cancel + 等落定 + 发新);被取消的轮不发 idle,故 status 保持 prompting,不会误触发 auto-continue。
  const interruptQueue = useCallback(async (id: string) => {
    const item = queueRef.current.find((q) => q.id === id);
    if (!item) return;
    queueRef.current = queueRef.current.filter((q) => q.id !== id);
    setQueue(queueRef.current);
    const sid = selectedSessionIdRef.current;
    if (!sid) return;
    setError(null);
    userStoppedRef.current = false;
    setStatusBySession((prev) => ({ ...prev, [sid]: "prompting" }));
    try {
      await ChatService.InterruptAndSend(sid, item.text);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // 撤回编辑:移出队列,文本回填 composer。
  const revokeQueue = useCallback((id: string) => {
    const item = queueRef.current.find((q) => q.id === id);
    if (!item) return;
    queueRef.current = queueRef.current.filter((q) => q.id !== id);
    setQueue(queueRef.current);
    setComposerValue((prev) => (prev.trim() ? prev + "\n" + item.text : item.text));
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

  const closeSession = useCallback(async () => {
    if (!selectedSessionId) return;
    await ChatService.CloseSession(selectedSessionId);
    setSelectedSessionId(null);
    setQueue([]); queueRef.current = []; setComposerValue("");
  }, [selectedSessionId]);

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

  const addProjectByPath = useCallback(
    async (path: string) => {
      try {
        await ChatService.AddProject("", path, "");
        await refreshProjects();
      } catch (e) {
        setError(String(e));
      }
    },
    [refreshProjects]
  );

  const removeProject = useCallback(
    async (projectId: string) => {
      await ChatService.RemoveProject(projectId);
      if (selectedProjectId === projectId) {
        setSelectedProjectId(null);
        setSelectedSessionId(null);
        setSessions([]);
      }
      await refreshProjects();
    },
    [refreshProjects, selectedProjectId]
  );

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) || null,
    [projects, selectedProjectId]
  );

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId) || null,
    [sessions, selectedSessionId]
  );

  // 三栏布局尺寸持久化:用户拖拽过的分隔位置存 localStorage,重开恢复。
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "monkey-deck-layout",
    onlySaveAfterUserInteractions: true,
  });



  return (
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
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          onSelectProject={selectProject}
          onSelectSession={openSession}
          onCreateSession={createSession}
          onAddProject={addProject}
          onAddProjectByPath={addProjectByPath}
          onRemoveProject={removeProject}
        />
      </Panel>
      <Separator className="resize-handle" />
      <Panel id="main" minSize="30%">
        <main className="main">
          {selectedSessionId ? (
            <ChatView
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
              onCloseSession={closeSession}
              onMerge={mergeSession}
              mergeResult={mergeResult}
              sessionDiff={sessionDiff}
              queue={queue}
              onInterruptQueue={interruptQueue}
              onRevokeQueue={revokeQueue}
              composerValue={composerValue}
              onComposerChange={setComposerValue}
            />
          ) : (
            <EmptyState />
          )}
        </main>
      </Panel>
      {selectedSessionId && activeSession && (
        <>
          <Separator className="resize-handle" />
          <Panel id="side" defaultSize="20%" minSize="14%" maxSize="34%">
            <SidePanel
              sessionId={selectedSessionId}
              rootName={selectedProject?.name || ""}
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
          </Panel>
        </>
      )}
    </Group>
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
