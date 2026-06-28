import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import * as ChatService from "../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import { Project, Session, Message } from "../bindings/github.com/jessonchan/monkey-deck/internal/store/models";
import type { ChatItem, PermissionPrompt, SessionEvent, StatusPayload } from "./types";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import Icon from "./components/Icon";

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
      await refreshSessions(projectId);
    },
    [refreshSessions]
  );

  // 打开 session:OpenSession + 加载历史。
  // 关键:有缓存(含进行中的流式)就保留缓存,仅首次打开才从 DB 读 —— 否则切回会丢正在输出的内容。
  const openSession = useCallback(
    async (sessionId: string) => {
      setSelectedSessionId(sessionId);
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

  // 发送消息。
  const sendMessage = useCallback(
    async (text: string) => {
      if (!selectedSessionId || !text.trim()) return;
      setError(null);
      setStatusBySession((prev) => ({ ...prev, [selectedSessionId]: "prompting" }));
      try {
        await ChatService.SendMessage(selectedSessionId, text);
      } catch (e) {
        setError(String(e));
        setStatusBySession((prev) => ({ ...prev, [selectedSessionId]: "idle" }));
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

  // 渲染用:取当前选中 session 的切片(无选中 → 空)。
  const items = useMemo(
    () => (selectedSessionId ? itemsBySession[selectedSessionId] ?? [] : []),
    [itemsBySession, selectedSessionId]
  );
  const usage = (selectedSessionId ? usageBySession[selectedSessionId] : undefined) ?? EMPTY_USAGE;
  const status = (selectedSessionId ? statusBySession[selectedSessionId] : undefined) ?? "empty";
  const statusDetail = (selectedSessionId ? statusDetailBySession[selectedSessionId] : undefined) ?? "";
  const permission = (selectedSessionId ? permissionBySession[selectedSessionId] : undefined) ?? null;

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
