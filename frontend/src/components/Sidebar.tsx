import { useState, useEffect } from "react";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { Project, Session } from "../../bindings/github.com/jessonchan/monkey-deck/internal/store/models";
import { Plus, ChevronDown, Folder, Copy, FolderOpen, Trash2 } from "lucide-react";

interface Props {
  projects: Project[];
  selectedProjectId: string | null;
  sessionsByProject: Record<string, Session[]>;
  selectedSessionId: string | null;
  onSelectProject: (id: string) => void;
  onSelectSession: (sessionId: string, projectId: string) => void;
  onCreateSession: (projectId: string) => void;
  onAddProject: () => void;
  onAddProjectByPath: (path: string) => void;
  onRemoveProject: (id: string) => void;
  statusBySession: Record<string, string>;
  activityBySession: Record<string, "thinking" | "executing" | "replying">;
  unreadBySession: Record<string, boolean>;
  permPendingBySession: Record<string, boolean>;
}

export default function Sidebar(props: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [ctx, setCtx] = useState<{ x: number; y: number; project: Project } | null>(null);
  const [confirm, setConfirm] = useState<Project | null>(null);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleProject = async (p: Project) => {
    await props.onSelectProject(p.id);
    setExpanded((prev) => new Set(prev).add(p.id));
  };

  const startAdd = () => {
    setAdding(true);
    setPathInput("");
    props.onAddProject();
  };
  const submitPath = () => {
    const p = pathInput.trim();
    setAdding(false);
    setPathInput("");
    if (p) props.onAddProjectByPath(p);
  };

  const onTitleDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, input, a")) return;
    void ChatService.ToggleMaximise();
  };

  // 右键菜单:外部点击/调整窗口关闭;Esc 关闭菜单与确认框(§4.2)。
  useEffect(() => {
    if (!ctx && !confirm) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setCtx(null); setConfirm(null); } };
    const closeCtx = () => setCtx(null);
    window.addEventListener("keydown", onKey);
    if (ctx) {
      window.addEventListener("mousedown", closeCtx);
      window.addEventListener("resize", closeCtx);
    }
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", closeCtx);
      window.removeEventListener("resize", closeCtx);
    };
  }, [ctx, confirm]);

  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="sidebar-header" onDoubleClick={onTitleDoubleClick}>
        <span className="sidebar-title">Monkey Deck</span>
        <button className="icon-btn" data-testid="add-project" onClick={startAdd} data-tooltip-id="md-tip" data-tooltip-content="添加项目目录" data-tooltip-place="bottom">
          <Plus size={17} />
        </button>
      </div>

      {adding && (
        <div className="add-path-row">
          <input
            className="add-path-input"
            data-testid="add-path-input"
            autoFocus
            placeholder="粘贴项目目录路径…"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitPath();
              if (e.key === "Escape") setAdding(false);
            }}
            onBlur={() => setTimeout(() => setAdding(false), 200)}
          />
        </div>
      )}

      <div className="project-list">
        {props.projects.length === 0 && !adding && (
          <div className="sidebar-empty">还没有项目。点右上角 + 添加一个代码目录。</div>
        )}
        {props.projects.map((p) => {
          const isOpen = expanded.has(p.id);
          const projSessions = props.sessionsByProject[p.id] ?? [];
          return (
            <div key={p.id} className="project-item-wrap">
              <div
                className={`project-item ${props.selectedProjectId === p.id ? "active" : ""}`}
                onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, project: p }); }}
              >
                <button className={`caret ${isOpen ? "open" : ""}`} onClick={() => toggle(p.id)}>
                  <ChevronDown size={13} style={{ transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s" }} />
                </button>
                <button className="project-main" data-testid={`project-${p.id}`} onClick={() => handleProject(p)}>
                  <Folder size={15} />
                  <span className="project-name" data-tooltip-id="md-tip" data-tooltip-content={p.path}>{p.name}</span>
                </button>
                <button className="icon-btn small" onClick={() => props.onCreateSession(p.id)} data-tooltip-id="md-tip" data-tooltip-content="新对话" data-testid={`new-session-${p.id}`}>
                  <Plus size={13} />
                </button>
              </div>
              {isOpen && (
                <div className="session-list">
                  {projSessions.map((s) => {
                    const st = props.statusBySession[s.id];
                    const active = st === "prompting";
                    const act = props.activityBySession[s.id];
                    const cls = st === "error" ? "error" : active ? act ?? "running" : "";
                    // 色点悬停提示(原生 title,悬停片刻浮现):空闲→灰、思考→琥珀、执行→蓝、回复→绿、出错→红。
                    const dotTip = st === "error" ? "出错"
                      : active ? ({ thinking: "思考中", executing: "执行中", replying: "回复中" } as Record<string, string>)[act ?? ""] ?? "生成中"
                      : "空闲";
                    const unread = !active && props.unreadBySession[s.id];
                    return (
                      <button
                        key={s.id}
                        className={`session-item ${props.selectedSessionId === s.id ? "active" : ""}`}
                        data-testid={`session-${s.id}`}
                        onClick={() => props.onSelectSession(s.id, p.id)}
                      >
                        <span className={`session-dot ${cls}`} data-tooltip-id="md-tip" data-tooltip-content={dotTip} />
                        <span className="session-label">{s.title || "新对话"}</span>
                        {props.permPendingBySession[s.id] ? (
                          <span className="perm-dot" data-tooltip-id="md-tip" data-tooltip-content="等待授权 · 点击进入裁决" data-testid={`perm-dot-${s.id}`} />
                        ) : active ? (
                          <span className="tail-spinner" data-tooltip-id="md-tip" data-tooltip-content="正在生成…" />
                        ) : unread ? (
                          <span className="unread-dot" data-tooltip-id="md-tip" data-tooltip-content="有未读回复，点击查看" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {ctx && (
        <div className="ctx-menu" style={{ left: ctx.x, top: ctx.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button className="ctx-item" onClick={() => { void navigator.clipboard?.writeText(ctx.project.path); setCtx(null); }}>
            <Copy size={13} /> 复制工作目录
          </button>
          <button className="ctx-item" onClick={() => { void ChatService.RevealPath(ctx.project.path); setCtx(null); }}>
            <FolderOpen size={13} /> 在 Finder 打开
          </button>
          <div className="ctx-sep" />
          <button className="ctx-item danger" onClick={() => { setConfirm(ctx.project); setCtx(null); }}>
            <Trash2 size={13} /> 移除项目
          </button>
        </div>
      )}

      {confirm && (
        <div className="modal-overlay" onClick={() => setConfirm(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">移除项目?</div>
            <div className="modal-del-target" data-tooltip-id="md-tip" data-tooltip-content={confirm.path}>{confirm.name} · {confirm.path}</div>
            <div className="modal-actions">
              <button className="modal-btn ghost" onClick={() => setConfirm(null)}>取消</button>
              <button className="modal-btn danger" onClick={() => { props.onRemoveProject(confirm.id); setConfirm(null); }}>移除</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
