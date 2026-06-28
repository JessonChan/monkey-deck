import { useState } from "react";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { Project, Session } from "../../bindings/github.com/jessonchan/monkey-deck/internal/store/models";
import { Plus, ChevronDown, Folder, X, MessageCircle } from "lucide-react";

interface Props {
  projects: Project[];
  selectedProjectId: string | null;
  sessions: Session[];
  selectedSessionId: string | null;
  onSelectProject: (id: string) => void;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onAddProject: () => void;
  onAddProjectByPath: (path: string) => void;
  onRemoveProject: (id: string) => void;
}

export default function Sidebar(props: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [pathInput, setPathInput] = useState("");

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

  const onTitleMouseDown = (e: React.MouseEvent) => {
    if (e.detail !== 2) return;
    if ((e.target as HTMLElement).closest("button, input, a")) return;
    void ChatService.ToggleMaximise();
  };

  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="sidebar-header" onMouseDown={onTitleMouseDown}>
        <span className="sidebar-title">Monkey Deck</span>
        <button className="icon-btn" data-testid="add-project" onClick={startAdd} title="添加项目目录">
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
          const isOpen = expanded.has(p.id) || props.selectedProjectId === p.id;
          return (
            <div key={p.id} className="project-item-wrap">
              <div className={`project-item ${props.selectedProjectId === p.id ? "active" : ""}`}>
                <button className={`caret ${isOpen ? "open" : ""}`} onClick={() => toggle(p.id)}>
                  <ChevronDown size={13} style={{ transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s" }} />
                </button>
                <button className="project-main" data-testid={`project-${p.id}`} onClick={() => handleProject(p)}>
                  <Folder size={15} />
                  <span className="project-name" title={p.path}>{p.name}</span>
                </button>
                <button className="icon-btn small" onClick={() => props.onRemoveProject(p.id)} title="移除项目">
                  <X size={13} />
                </button>
              </div>
              {isOpen && props.selectedProjectId === p.id && (
                <div className="session-list">
                  {props.sessions.map((s) => (
                    <button
                      key={s.id}
                      className={`session-item ${props.selectedSessionId === s.id ? "active" : ""}`}
                      data-testid={`session-${s.id}`}
                      onClick={() => props.onSelectSession(s.id)}
                    >
                      <MessageCircle size={13} />
                      <span className="session-label">{s.title || "新对话"}</span>
                    </button>
                  ))}
                  <button className="session-item new" onClick={props.onCreateSession} data-testid="new-session">
                    <Plus size={13} />
                    <span className="session-label">新对话</span>
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
