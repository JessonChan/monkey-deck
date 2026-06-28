import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import * as ChatService from "../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import { Project, Session, Message } from "../bindings/github.com/jessonchan/monkey-deck/internal/store/models";
import type { ChatItem, PermissionPrompt, SessionEvent, StatusPayload } from "./types";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import Icon from "./components/Icon";

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
      setUsage({ used: 0, size: 0, cost: 0 });
      setStatus("idle");
      setError(null);
      await ChatService.OpenSession(sessionId);
      const msgs = await ChatService.LoadMessages(sessionId);
      setItems(messagesToItems(msgs || []));
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

  // 发送消息。
  const sendMessage = useCallback(
    async (text: string) => {
      if (!selectedSessionId || !text.trim()) return;
      setError(null);
      setStatus("prompting");
      try {
        await ChatService.SendMessage(selectedSessionId, text);
      } catch (e) {
        setError(String(e));
        setStatus("idle");
      }
    },
    [selectedSessionId]
  );

  const stopSession = useCallback(async () => {
    if (!selectedSessionId) return;
    await ChatService.StopSession(selectedSessionId);
  }, [selectedSessionId]);

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
    setStatus("empty");
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
          />
        ) : (
          <EmptyState />
        )}
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-logo"><Icon name="sparkles" size={30} /></div>
      <h2>Monkey Deck</h2>
      <p>ACP 桌面客户端 · 以项目目录为锚点管理编码 agent 对话</p>
      <p className="empty-hint">← 在左侧添加一个项目目录开始</p>
    </div>
  );
}
