import { useState, useEffect, useLayoutEffect, useRef } from "react";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { Project, Session } from "../../bindings/github.com/jessonchan/monkey-deck/internal/store/models";
import { Plus, ChevronDown, Folder, Copy, FolderOpen, Trash2, Pencil, Search, X } from "lucide-react";

interface Props {
  projects: Project[];
  selectedProjectId: string | null;
  sessionsByProject: Record<string, Session[]>;
  selectedSessionId: string | null;
  onSelectProject: (id: string) => void;
  onSelectSession: (sessionId: string, projectId: string) => void;
  onCreateSession: (projectId: string) => void;
  onAddProject: () => void;
  onAddProjectByPath?: (path: string) => void;
  onRemoveProject: (id: string) => void;
  onRemoveSession: (sessionId: string) => void;
  statusBySession: Record<string, string>;
  activityBySession: Record<string, "thinking" | "executing" | "replying">;
  unreadBySession: Record<string, boolean>;
  permPendingBySession: Record<string, boolean>;
  draftBySession?: Record<string, string>;
}

type Ctx =
  | { kind: "project"; x: number; y: number; project: Project }
  | { kind: "session"; x: number; y: number; session: Session };

type ConfirmTarget =
  | { kind: "project"; project: Project }
  | { kind: "session"; session: Session };

// 侧栏 session 列表分片渲染每页大小:本地 SQLite 全量已加载(查询本来就快),
// 这里只控制渲染的 DOM 节点数,避免单项目几百个 session 一次性撑爆。
const SESSION_PAGE = 25;

export default function Sidebar(props: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
  // session 列表分片渲染:每个项目默认 SESSION_PAGE 个,「加载更多」每次 +SESSION_PAGE。
  const [sessionLimit, setSessionLimit] = useState<Record<string, number>>({});
  // 会话搜索:searchProj 标记哪个项目展开了搜索框。标题本地即时过滤,
  // 内容命中经 SearchSessionContent(后端 LIKE)异步回流,与标题做并集(§4.1)。
  const [searchProj, setSearchProj] = useState<string | null>(null);
  const [searchQ, setSearchQ] = useState("");
  const [contentHits, setContentHits] = useState<string[] | null>(null); // null=未发起内容搜索
  const [contentLoading, setContentLoading] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        // 折叠:清掉该项目的 session 分片(下次展开回到默认 SESSION_PAGE)。
        next.delete(id);
        setSessionLimit((lim) => { const c = { ...lim }; delete c[id]; return c; });
      } else {
        next.add(id);
      }
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
    if (p) props.onAddProjectByPath?.(p);
  };

  const onTitleDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, input, a")) return;
    void ChatService.ToggleMaximise();
  };

  // 右键菜单:统一用鼠标坐标作为起点(VS Code 风格),简单可靠。
  // 视口 clamp 在 useLayoutEffect 里做(渲染后量菜单尺寸再修正)。
  const openProjectMenu = (e: React.MouseEvent, p: Project) => {
    e.preventDefault();
    setCtx({ kind: "project", x: e.clientX, y: e.clientY, project: p });
  };
  const openSessionMenu = (e: React.MouseEvent, s: Session) => {
    e.preventDefault();
    setCtx({ kind: "session", x: e.clientX, y: e.clientY, session: s });
  };
  const menuRef = useRef<HTMLDivElement>(null);

  const closeCtx = () => { setCtx(null); setConfirm(null); };

  // 点项目行搜索按钮切换:开则展开项目并聚焦输入框,关则清空(只允许一个项目同时搜索)。
  const toggleSearch = (pId: string) => {
    if (searchProj === pId) {
      setSearchProj(null); setSearchQ(""); setContentHits(null); setContentLoading(false);
      return;
    }
    if (!expanded.has(pId)) setExpanded((prev) => new Set(prev).add(pId));
    setSearchProj(pId); setSearchQ(""); setContentHits(null); setContentLoading(false);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  // 单个 session 是否命中:空 query 全过;标题子串(本地即时)∪ 内容命中(后端回流)。
  const matchSession = (s: Session) => {
    const q = searchQ.trim().toLowerCase();
    if (!q) return true;
    if ((s.title || "").toLowerCase().includes(q)) return true;
    if (contentHits && contentHits.includes(s.id)) return true;
    return false;
  };

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
  // 视口 clamp:渲染后量菜单尺寸,推入 [left,top] 防溢出。
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !ctx) return;
    const pad = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = ctx.x;
    let top = ctx.y;
    if (left + w > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - w - pad);
    if (top + h > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - h - pad);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [ctx]);

  // 内容搜索:query≥2 字符时去抖 200ms 调后端 LIKE(桌面 SQLite 毫秒级),回填命中 session id。
  // 标题命中是本地即时过滤,不在此 effect 内;切项目/清空立即重置。
  useEffect(() => {
    if (searchProj == null) return;
    const q = searchQ.trim();
    if (q.length < 2) { setContentHits(null); setContentLoading(false); return; }
    setContentLoading(true);
    const h = setTimeout(() => {
      ChatService.SearchSessionContent(searchProj, q)
        .then((ids) => { setContentHits(ids ?? []); })
        .catch(() => { setContentHits([]); })
        .finally(() => setContentLoading(false));
    }, 200);
    return () => clearTimeout(h);
  }, [searchProj, searchQ]);

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
          const sessLimit = sessionLimit[p.id] ?? SESSION_PAGE;
          const visibleSessions = projSessions.slice(0, sessLimit);
          const hiddenCount = projSessions.length - visibleSessions.length;
          const searching = searchProj === p.id && searchQ.trim() !== "";
          const list = searching ? projSessions.filter(matchSession) : visibleSessions;
          // 项目行活跃信号:折叠时显示左竖条(running=慢呼吸 / unread=静态)。展开时 session 行已有 dot/spinner,无需重复。
          const projRunning = projSessions.some((s) => props.statusBySession[s.id] === "prompting");
          const projUnread = projSessions.some((s) => props.statusBySession[s.id] !== "prompting" && props.unreadBySession[s.id]);
          const barCls = !isOpen && projRunning ? "has-running" : !isOpen && projUnread ? "has-unread" : "";
          return (
            <div key={p.id} className="project-item-wrap">
              <div
                className={`project-item ${props.selectedProjectId === p.id ? "active" : ""} ${barCls}`}
                onContextMenu={(e) => openProjectMenu(e, p)}
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
                <button className="icon-btn small" onClick={() => toggleSearch(p.id)} data-tooltip-id="md-tip" data-tooltip-content={searchProj === p.id ? "关闭搜索" : "搜索会话"} data-tooltip-place="bottom" data-testid={`search-sessions-${p.id}`}>
                  <Search size={12} />
                </button>
              </div>
              {isOpen && (
                <div className="session-list">
                  {searchProj === p.id && (
                    <div className="session-search-row">
                      <Search size={12} />
                      <input
                        ref={searchInputRef}
                        className="session-search-input"
                        data-testid={`session-search-${p.id}`}
                        placeholder="搜索标题或内容…"
                        value={searchQ}
                        onChange={(e) => setSearchQ(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Escape") toggleSearch(p.id); }}
                      />
                      {contentLoading && <span className="search-spinner" data-tooltip-id="md-tip" data-tooltip-content="正在搜索内容…" />}
                      {searchQ && (
                        <button className="icon-btn small" data-tooltip-id="md-tip" data-tooltip-content="清空" onClick={() => setSearchQ("")}>
                          <X size={11} />
                        </button>
                      )}
                    </div>
                  )}
                  {list.map((s) => {
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
                        onContextMenu={(e) => openSessionMenu(e, s)}
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
                          ) : (() => {
                            const dh = props.draftBySession?.[s.id];
                            return dh && dh.trim() ? (
                              <span className="draft-indicator" data-tooltip-id="md-tip" data-tooltip-content={`草稿: ${dh.slice(0, 40)}${dh.length > 40 ? "…" : ""}`} data-testid={`draft-${s.id}`}>
                                <Pencil size={6} />
                              </span>
                            ) : null;
                          })()}
                        </button>
                      </div>
                    );
                  })}
                  {searching && list.length === 0 && (
                    <div className="session-search-empty">无匹配的会话</div>
                  )}
                  {!searching && hiddenCount > 0 && (
                    <button
                      className="session-more-btn"
                      data-testid={`load-more-sessions-${p.id}`}
                      onClick={() => setSessionLimit((prev) => ({ ...prev, [p.id]: (prev[p.id] ?? SESSION_PAGE) + SESSION_PAGE }))}
                    >
                      加载更多（还有 {hiddenCount} 个）
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {ctx?.kind === "project" && (
        <div ref={menuRef} className="ctx-menu" style={{ left: ctx.x, top: ctx.y }} onMouseDown={(e) => e.stopPropagation()}>
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
        <div ref={menuRef} className="ctx-menu" style={{ left: ctx.x, top: ctx.y }} onMouseDown={(e) => e.stopPropagation()}>
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
