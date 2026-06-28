import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import * as ChatService from "../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import { Project, Session, Message } from "../bindings/github.com/jessonchan/monkey-deck/internal/store/models";
import type { ChatItem, PermissionPrompt, SessionEvent, StatusPayload, QueueItem } from "./types";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import { Sparkles } from "lucide-react";
import GitPanel from "./components/GitPanel";
import type { FileChange } from "../bindings/github.com/jessonchan/monkey-deck/internal/worktree/models";

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [status, setStatus] = useState<StatusPayload["status"] | "empty">("empty");
  const [statusDetail, setStatusDetail] = useState("");
  const [usage, setUsage] = useState<{ used: number; size: number; cost: number }>({
    used: 0,
    size: 0,
    cost: 0,
  });
  const [permission, setPermission] = useState<PermissionPrompt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);     // 前端 FIFO 队列(turn 中发的消息)
  const [composerValue, setComposerValue] = useState("");  // composer 受控文本(支持撤回回填)
  const queueRef = useRef<QueueItem[]>([]);
  const userStoppedRef = useRef(false);                    // 用户主动停止:抑制该次 idle 的 auto-continue

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

  // 把一条 SessionEvent 应用到 items(流式累积)。
  const applyEvent = useCallback((ev: SessionEvent) => {
    if (ev.sessionId !== selectedSessionIdRef.current) return;
    if (ev.kind === "usage_update") {
      setUsage((u) => ({
        used: ev.used ?? u.used,
        size: ev.size ?? u.size,
        cost: ev.cost ?? u.cost,
      }));
      return;
    }
    setItems((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      switch (ev.kind) {
        case "user_message_chunk":
          if (last && last.type === "user") {
            return next; // 已有 user,不重复
          }
          next.push({ type: "user", id: `u-${Date.now()}`, text: ev.text || "" });
          return next;
        case "agent_message_chunk":
          if (last && last.type === "agent" && last.streaming) {
            // 累积全文 + 序号:序号更小(乱序迟到)则忽略,否则替换(非追加,防乱码)
            if (ev.seq == null || last.seq == null || ev.seq >= last.seq) {
              next[next.length - 1] = { ...last, text: ev.text || "", seq: ev.seq };
            }
          } else {
            next.push({ type: "agent", id: `a-${ev.seq ?? Date.now()}`, text: ev.text || "", streaming: true, seq: ev.seq });
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
          return next;
        default:
          return next;
      }
    });
  }, []);

  // 启动:加载项目 + 订阅事件。
  useEffect(() => {
    void refreshProjects();
    const offUpdate = Events.On("chat:event", (e: { data: SessionEvent }) => {
      if (e.data) applyEvent(e.data);
    });
    const offPerm = Events.On("chat:permission", (e: { data: PermissionPrompt }) => {
      if (e.data && e.data.sessionId === selectedSessionIdRef.current) setPermission(e.data);
    });
    const offStatus = Events.On("chat:status", (e: { data: StatusPayload }) => {
      const s = e.data;
      if (!s || s.sessionId !== selectedSessionIdRef.current) return;
      setStatus(s.status);
      setStatusDetail(s.detail || "");
      if (s.status === "error") setError(s.detail || "出错");
      else setError(null);
      // 回合结束:清掉最后 agent/thought 的 streaming 标志(去光标 + 显复制按钮)
      if (s.status === "idle" || s.status === "error") {
        setItems((prev) => {
          const next = prev.map((it) =>
            it.type === "agent" || it.type === "thought" ? { ...it, streaming: false } : it
          );
          return next;
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
      // 更新会话标题(侧栏 + 当前会话头)
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
    setStatus("prompting");
    try {
      await ChatService.SendMessage(sid, next.text);
    } catch (e) {
 setError(String(e));
      setStatus("idle");
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
      if (m.role === "user") return { type: "user", id: m.id, text: m.content };
      if (m.role === "agent") return { type: "agent", id: m.id, text: m.content };
      if (m.role === "thought") return { type: "thought", id: m.id, text: m.content };
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
      return { type: "tool", id: m.toolCallId || m.id, title, status, kind, rawInput, rawOutput };
    });
  }, []);

  // 选项目 → 加载 sessions。
  const selectProject = useCallback(
    async (projectId: string) => {
      setSelectedProjectId(projectId);
      setSelectedSessionId(null);
      setItems([]);
      setQueue([]); queueRef.current = []; setComposerValue("");
      userStoppedRef.current = false;
      setStatus("empty");
      await refreshSessions(projectId);
    },
    [refreshSessions]
  );

  // 打开 session:OpenSession + 加载历史。
  const openSession = useCallback(
    async (sessionId: string) => {
      setSelectedSessionId(sessionId);
      setPermission(null);
      setStatus("idle");
      setQueue([]); queueRef.current = []; setComposerValue("");
      userStoppedRef.current = false;
      setError(null);
      await ChatService.OpenSession(sessionId);
      const msgs = await ChatService.LoadMessages(sessionId);
      setItems(messagesToItems(msgs || []));
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
    [messagesToItems]
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
      setStatus("prompting");
      try {
        await ChatService.SendMessage(selectedSessionId, text);
      } catch (e) {
        setError(String(e));
        setStatus("idle");
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
    setStatus("prompting");
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
        // clear / new 都=新建会话(monkey-deck 无原地清空,新会话即清空)
        void createSession();
      }
    },
    [stopSession, createSession]
  );

  const respondPermission = useCallback(
    async (optionId: string) => {
      if (!selectedSessionId || !permission) return;
      setPermission(null);
      await ChatService.RespondPermission(selectedSessionId, permission.id, optionId);
    },
    [selectedSessionId, permission]
  );

  const closeSession = useCallback(async () => {
    if (!selectedSessionId) return;
    await ChatService.CloseSession(selectedSessionId);
    setSelectedSessionId(null);
    setItems([]);
    setQueue([]); queueRef.current = []; setComposerValue("");
    setStatus("empty");
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
        setItems([]);
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

  return (
    <div className="app">
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
      {activeSession?.branch && (
        <GitPanel
          branch={activeSession.branch}
          changes={sessionChanges}
          commitCount={0}
          mergeResult={mergeResult}
          onMerge={mergeSession}
        />
      )}
    </div>
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
