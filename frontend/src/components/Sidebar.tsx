import { useState, useEffect } from "react";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { Project, Session } from "../../bindings/github.com/jessonchan/monkey-deck/internal/store/models";
import { Plus, ChevronDown, Folder, Copy, FolderOpen, Trash2, MoreVertical } from "lucide-react";

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
  onRemoveSession: (sessionId: string) => void;
  statusBySession: Record<string, string>;
  activityBySession: Record<string, "thinking" | "executing" | "replying">;
  unreadBySession: Record<string, boolean>;
  permPendingBySession: Record<string, boolean>;
}

type Ctx =
  | { kind: "project"; x: number; y: number; project: Project }
  | { kind: "session"; x: number; y: number; session: Session };

type ConfirmTarget =
  | { kind: "project"; project: Project }
  | { kind: "session"; session: Session };

export default function Sidebar(props: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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

  // 会话 ⋮ 菜单:取 session-row 的 bounding rect,菜单右对齐于该行底部。
  const openSessionMenu = (e: React.MouseEvent, s: Session) => {
    e.stopPropagation();
    const row = (e.currentTarget as HTMLElement).closest(".session-item-row") as HTMLElement | null;
    const rect = row?.getBoundingClientRect();
    if (rect) {
      // 菜单右对齐:右边缘 = rect.right,top = rect.bottom;CSS 里 transform: translateX(-100%) 把菜单宽度左移对齐。
      setCtx({ kind: "session", x: window.innerWidth - rect.right, y: rect.bottom, session: s });
    }
  };

  const closeCtx = () => { setCtx(null); setConfirm(null); };

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
                onContextMenu={(e) => { e.preventDefault(); setCtx({ kind: "project", x: e.clientX, y: e.clientY, project: p }); }}
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
                    const dotTip = st === "error" ? "出错"
                      : active ? ({ thinking: "思考中", executing: "执行中", replying: "回复中" } as Record<string, string>)[act ?? ""] ?? "生成中"
                      : "空闲";
                    const unread = !active && props.unreadBySession[s.id];
                    return (
                      <div
                        key={s.id}
                        className={`session-item-row ${props.selectedSessionId === s.id ? "active" : ""}`}
                        data-testid={`session-${s.id}`}
                      >
                        <button
                          className="session-item-main"
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
                        <button className="session-menu-btn" onClick={(e) => openSessionMenu(e, s)}>
                          <MoreVertical size={13} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {ctx?.kind === "project" && (
        <div className="ctx-menu" style={{ left: ctx.x, top: ctx.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button className="ctx-item" onClick={() => { void navigator.clipboard?.writeText(ctx.project.path); closeCtx(); }}>
            <Copy size={13} /> 复制工作目录
          </button>
          <button className="ctx-item" onClick={() => { void ChatService.RevealPath(ctx.project.path); closeCtx(); }}>
            <FolderOpen size={13} /> 在 Finder 打开
          </button>
          <div className="ctx-sep" />
          <button className="ctx-item danger" onClick={() => { setConfirm({ kind: "project", project: ctx.project }); setCtx(null); }}>
            <Trash2 size={13} /> 移除项目
          </button>
        </div>
      )}

      {ctx?.kind === "session" && (
        <div className="ctx-menu ctx-menu--right" style={{ right: ctx.x, top: ctx.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button
            className="ctx-item"
            disabled={props.selectedSessionId === ctx.session.id}
            onClick={() => { if (props.selectedSessionId !== ctx.session.id) void props.onSelectSession(ctx.session.id, ctx.session.projectId); closeCtx(); }}
          >
            <Folder size={13} /> 激活对话
          </button>
          <button className="ctx-item" onClick={() => { void navigator.clipboard?.writeText(ctx.session.id); closeCtx(); }}>
            <Copy size={13} /> 复制会话 ID
          </button>
          {ctx.session.worktreePath && (
            <button className="ctx-item" onClick={() => { void ChatService.RevealPath(ctx.session.worktreePath); closeCtx(); }}>
              <FolderOpen size={13} /> 在 Finder 打开 Worktree
            </button>
          )}
          <div className="ctx-sep" />
          <button className="ctx-item danger" onClick={() => { setConfirm({ kind: "session", session: ctx.session }); setCtx(null); }}>
            <Trash2 size={13} /> 删除会话
          </button>
        </div>
      )}

      {confirm?.kind === "project" && (
        <div className="modal-overlay" onClick={() => setConfirm(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">移除项目?</div>
            <div className="modal-del-target" data-tooltip-id="md-tip" data-tooltip-content={confirm.project.path}>{confirm.project.name} · {confirm.project.path}</div>
            <div className="modal-actions">
              <button className="modal-btn ghost" onClick={() => setConfirm(null)}>取消</button>
              <button className="modal-btn danger" onClick={() => { props.onRemoveProject(confirm.project.id); setConfirm(null); }}>移除</button>
            </div>
          </div>
        </div>
      )}

      {confirm?.kind === "session" && (
        <div className="modal-overlay" onClick={() => setConfirm(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">删除会话?</div>
            <div className="modal-del-target">{confirm.session.title || "新对话"} · {confirm.session.id.slice(0, 8)}</div>
            <div className="modal-actions">
              <button className="modal-btn ghost" onClick={() => setConfirm(null)}>取消</button>
              <button className="modal-btn danger" onClick={() => { props.onRemoveSession(confirm.session.id); setConfirm(null); }}>删除</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
