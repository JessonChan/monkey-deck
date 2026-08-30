import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { FileNode } from "../../bindings/github.com/jessonchan/monkey-deck/internal/fsview/models";
import type { FileChange } from "../../bindings/github.com/jessonchan/monkey-deck/internal/worktree/models";
import { copyTextQuiet } from "../lib/clipboard";
import { writePanelFilePayload } from "../lib/panelDrop";
import { getFilePanelState, saveFilePanelState, recentFileSearchesKey, loadRecentFileSearches, rememberRecentFileSearch, removeRecentFileSearch, type ChildrenMap, type FilePanelSnapshot } from "../lib/filePanelCache";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  File as FileIcon,
  RefreshCw,
  FilePlus2,
  FolderPlus,
  Pencil,
  Trash2,
  Copy,
  Search,
  History,
  X,
} from "lucide-react";

interface Props {
  sessionId: string;
  rootName: string;
  rootPath: string;
  changes: FileChange[] | null;
  status: string;
  // Open a file in the editor tab strip (middle column row 2). Replaces the
  // old in-panel modal preview overlay.
  onOpenFile: (path: string, line?: number) => void;
}

type Modal =
  | { kind: "file"; dir: string }
  | { kind: "folder"; dir: string }
  | { kind: "rename"; dir: string; target: string; initial: string }
  | { kind: "delete"; dir: string; target: string; isDir: boolean };

const joinPath = (dir: string, name: string) => (dir === "" ? name : dir + "/" + name);

// Debounce for the fuzzy-find backend call (#132): rapid keystrokes coalesce
// into a single SessionFuzzyFind per pause.
const SEARCH_DEBOUNCE_MS = 200;
// Result cap for one search (#132): enough to be useful, bounded for the flat list.
const SEARCH_LIMIT = 50;

// Drag-out of tree rows is an HTML5 drag (issue #149); touch has no HTML5 DnD,
// so coarse-pointer clients never get the draggable attribute (same module-level
// gate as Composer/App — a desktop window never becomes touch mid-session).
const coarsePointer = typeof window !== "undefined" && typeof window.matchMedia === "function"
  && window.matchMedia("(pointer: coarse)").matches;

export default function FilePanel({ sessionId, rootName, rootPath, changes, status, onOpenFile }: Props) {
  const { t } = useTranslation();
  // Navigational state is seeded from the per-session cache so switching the session tab
  // away and back restores the file tree exactly (expanded dirs / listings / selection).
  // Lazy initializers run only on mount.
  const [children, setChildren] = useState<ChildrenMap>(() => getFilePanelState(sessionId)?.children ?? {});
  const [expanded, setExpanded] = useState<Set<string>>(() => getFilePanelState(sessionId)?.expanded ?? new Set());
  // Search open/typed-query are snapshot-restored as well (#167): switching the
  // session tab away and back reopens the search row with the query intact.
  // Results stay transient — the debounce effect below refetches on its own.
  const [searchOpen, setSearchOpen] = useState(() => getFilePanelState(sessionId)?.searchOpen ?? false);
  const [query, setQuery] = useState(() => getFilePanelState(sessionId)?.query ?? "");
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(() => getFilePanelState(sessionId)?.selected ?? null);
  const [error, setError] = useState<string | null>(null);

  const [modal, setModal] = useState<Modal | null>(null);
  const [modalName, setModalName] = useState("");
  const [tick, setTick] = useState(0);
  // 右键菜单(复用 Sidebar ctx-menu 范式:fixed 定位 + 全局 Esc / outside-mousedown / resize 关闭 + 视口裁剪)。
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; node: FileNode } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  // Snapshot navigational state into the per-session cache on unmount so reopening this
  // session's tab restores the file tree exactly. SidePanel is keyed by sessionId, so this
  // instance lives for exactly one session — cleanup runs once on unmount, reading the
  // latest state via snapRef (avoids re-subscribing the effect on every state change).
  const snapRef = useRef<FilePanelSnapshot>({ expanded, children, selected, searchOpen, query });
  snapRef.current = { expanded, children, selected, searchOpen, query };
  useEffect(() => {
    return () => saveFilePanelState(sessionId, snapRef.current);
  }, [sessionId]);

  // rel(相对路径)→ 绝对路径(钉在 rootPath;无 rootPath 时返回空,交给浏览器默认菜单)。
  const absPath = useCallback((rel: string) => {
    if (!rootPath) return "";
    return rel === "" ? rootPath : rootPath.replace(/\/+$/, "") + "/" + rel;
  }, [rootPath]);

  const openCtxMenu = (e: React.MouseEvent, node: FileNode) => {
    if (!rootPath) return; // 无根路径则交给浏览器默认菜单
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, node });
  };

  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  useEffect(() => {
    if (!ctxMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeCtxMenu(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", closeCtxMenu);
    window.addEventListener("resize", closeCtxMenu);
    window.addEventListener("scroll", closeCtxMenu, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", closeCtxMenu);
      window.removeEventListener("resize", closeCtxMenu);
      window.removeEventListener("scroll", closeCtxMenu, true);
    };
  }, [ctxMenu, closeCtxMenu]);

  // 视口 clamp:渲染后量菜单尺寸,推入 [left,top] 防溢出(对齐 Sidebar)。
  useLayoutEffect(() => {
    const el = ctxMenuRef.current;
    if (!el || !ctxMenu) return;
    const pad = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = ctxMenu.x;
    let top = ctxMenu.y;
    if (left + w > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - w - pad);
    if (top + h > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - h - pad);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [ctxMenu]);

  // path → git 状态字母(工作区优先;用于文件行徽标)。
  const statusByPath = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of changes || []) m[c.path] = c.status;
    return m;
  }, [changes]);

  const loadChildren = useCallback(
    async (dir: string) => {
      setLoading((s) => new Set(s).add(dir));
      try {
        const list = await ChatService.SessionListDir(sessionId, dir);
        setChildren((prev) => ({ ...prev, [dir]: list || [] }));
        setError(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading((s) => {
          const n = new Set(s);
          n.delete(dir);
          return n;
        });
      }
    },
    [sessionId]
  );

  // On mount: refresh the root and any already-expanded dirs (expanded may come from the
  // per-session cache when the user switched away and back). We do NOT reset state here —
  // the initial useState values already come from the cache, and SidePanel is keyed by
  // sessionId so this instance lives for exactly one session.
  useEffect(() => {

    void loadChildren("");
    for (const d of expanded) void loadChildren(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Esc closes the active modal (file/folder/rename/delete). File preview is
  // no longer a modal here — it's a tab in the middle column (EditorPane).
  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModal(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);

  // turn 结束(status→idle):刷新已展开目录,让 agent 新建/删除的文件显现。
  useEffect(() => {
    if (status === "idle") {
      void loadChildren("");
      for (const d of expanded) void loadChildren(d);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, tick]);

  const refresh = useCallback(() => {
    void loadChildren("");
    for (const d of expanded) void loadChildren(d);
    setTick((t) => t + 1);
  }, [expanded, loadChildren]);

  // ── File search (#132) ──
  // searchOpen/query live in the per-session snapshot (#167 — restored on
  // remount); everything below stays transient: results are refetched by the
  // debounce effect, never cached.
  const [results, setResults] = useState<FileNode[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  // Recent-search history (#167): a project-level localStorage asset keyed by
  // rootPath (App resolves sessionId → project; empty rootPath degrades to a
  // per-session key). Reloaded when the search opens, written on pick
  // (move-to-front, cap 12), single-deletable from the dropdown.
  const [recent, setRecent] = useState<string[]>([]);
  const [searchFocused, setSearchFocused] = useState(false);
  const historyKey = recentFileSearchesKey(rootPath, sessionId);
  useEffect(() => {
    if (searchOpen) setRecent(loadRecentFileSearches(historyKey));
  }, [searchOpen, historyKey]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);
  // IME composition tracking: manual compositionStart/End recording plus
  // isComposing + keyCode===229, mirroring Composer/QueuePanel — the Enter
  // that commits a CJK candidate selection must not be treated as "pick the
  // active result" (isComposing alone is unreliable on some macOS IMEs).
  const composingRef = useRef(false);
  // Monotonic seq: an in-flight response for an older query must not overwrite
  // a newer one (clearTimeout only cancels the pending timer, not a request
  // already on the wire).
  const searchSeq = useRef(0);

  const searchActive = searchOpen && query.trim() !== "";
  // History dropdown (#167): focused input + empty query + non-empty history.
  const showHistory = searchOpen && !searchActive && searchFocused && recent.length > 0;

  const exitSearch = useCallback(() => {
    searchSeq.current++;
    setSearchOpen(false);
    setQuery("");
    setResults(null);
    setSearching(false);
    setActiveIdx(0);
    setSearchFocused(false);
    if (searchInputRef.current) searchInputRef.current.value = "";
  }, []);

  const toggleSearch = () => {
    if (searchOpen) {
      exitSearch();
      return;
    }
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  // Debounced fuzzy find over the whole session tree (scope="", limit 50).
  // Empty query keeps the tree visible; clearing resets results.
  useEffect(() => {
    if (!searchOpen) return;
    const q = query.trim();
    if (!q) {
      searchSeq.current++;
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const seq = ++searchSeq.current;
    let cancelled = false;
    const h = setTimeout(() => {
      ChatService.SessionFuzzyFind(sessionId, "", q, SEARCH_LIMIT)
        .then((nodes) => {
          if (cancelled || seq !== searchSeq.current) return;
          setResults(nodes || []);
          setActiveIdx(0);
        })
        .catch(() => {
          if (cancelled || seq !== searchSeq.current) return;
          setResults([]);
        })
        .finally(() => {
          if (!cancelled && seq === searchSeq.current) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [query, searchOpen, sessionId]);

  // Keep the keyboard-active row in view while arrowing through results.
  useEffect(() => {
    activeRowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeIdx, results]);

  // Reveal a directory hit back in the tree: expand + load its ancestors so the
  // row is visible, then select it. Files are opened in the editor instead.
  const revealInTree = (node: FileNode) => {
    const parts = node.path.split("/");
    const dirs: string[] = [];
    for (let i = 1; i < parts.length; i++) dirs.push(parts.slice(0, i).join("/"));
    if (dirs.length > 0) {
      setExpanded((prev) => {
        const n = new Set(prev);
        for (const d of dirs) n.add(d);
        return n;
      });
      for (const d of dirs) {
        if (!children[d]) void loadChildren(d);
      }
    }
    setSelected(node.path);
  };

  const pickResult = (node: FileNode) => {
    // History write at the entry (#167 D3): recording the committed query is
    // decoupled from the exit below. Directory hits keep their reveal-in-tree
    // behavior unchanged; they simply also count as a committed search.
    const q = query.trim();
    if (q) rememberRecentFileSearch(historyKey, q);
    if (node.isDir) revealInTree(node);
    else {
      setSelected(node.path);
      onOpenFile(node.path);
    }
    exitSearch();
  };

  // Keep the latest pick action reachable from the native keydown listener
  // below without re-subscribing on every render.
  const pickResultRef = useRef(pickResult);
  pickResultRef.current = pickResult;

  // The search input is uncontrolled + driven by NATIVE input/keydown listeners.
  // Deliberate deviation from the usual controlled-input + onChange pattern:
  // happy-dom (the mount-test env) drops dispatched input events on inputs that
  // carry React text-event props (value/onChange), which would make the search
  // untestable there; native listeners behave identically in real webviews and
  // keep the DOM as the single source of truth for the typed text.
  useEffect(() => {
    const el = searchInputRef.current;
    if (!searchOpen || !el) return;
    const onInput = () => setQuery(el.value);
    const onKeyDown = (e: KeyboardEvent) => {
      // IME composing (Chinese/Japanese/Korean candidate selection): Enter
      // picks the candidate, arrows/Escape drive the IME — none of them may
      // act on the result list. Triple check per the codebase convention
      // (manual ref tracking + isComposing + deprecated keyCode 229).
      if (composingRef.current || e.isComposing || e.keyCode === 229) return;
      const list = results || [];
      if (e.key === "Escape") {
        e.stopPropagation();
        exitSearch();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (list.length > 0) setActiveIdx((i) => Math.min(i + 1, list.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (list.length > 0) setActiveIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const node = list[activeIdx];
        if (node) pickResultRef.current(node);
      }
    };
    const onCompositionStart = () => { composingRef.current = true; };
    const onCompositionEnd = () => { composingRef.current = false; };
    el.addEventListener("input", onInput);
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("compositionstart", onCompositionStart);
    el.addEventListener("compositionend", onCompositionEnd);
    return () => {
      el.removeEventListener("input", onInput);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("compositionstart", onCompositionStart);
      el.removeEventListener("compositionend", onCompositionEnd);
    };
  }, [searchOpen, results, activeIdx, exitSearch]);

  // History dropdown actions (#167). Backfill sets the DOM value directly (the
  // input is uncontrolled) and lets the debounce effect fire the search; the
  // ✕ removes just that entry and refreshes the open dropdown.
  const applyHistory = (q: string) => {
    const el = searchInputRef.current;
    if (el) {
      el.value = q;
      el.focus();
    }
    setQuery(q);
  };
  const deleteHistory = (q: string) => {
    removeRecentFileSearch(historyKey, q);
    setRecent(loadRecentFileSearches(historyKey));
  };

  // Dropdown focus tracking + restored-input hydration (#167). Deliberately a
  // separate effect so the key-listener chain above stays untouched (D5/D6):
  // it only adds native focus/blur listeners to the same uncontrolled input
  // and re-fills the DOM value when a remount restored searchOpen+query from
  // the snapshot (results are never cached — the debounce effect refetches).
  useEffect(() => {
    const el = searchInputRef.current;
    if (!searchOpen || !el) return;
    if (el.value === "" && query !== "") el.value = query;
    const onFocus = () => setSearchFocused(true);
    const onBlur = () => setSearchFocused(false);
    el.addEventListener("focus", onFocus);
    el.addEventListener("blur", onBlur);
    return () => {
      el.removeEventListener("focus", onFocus);
      el.removeEventListener("blur", onBlur);
    };
  }, [searchOpen, query]);

  const toggleDir = (node: FileNode) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(node.path)) n.delete(node.path);
      else {
        n.add(node.path);
        if (!children[node.path]) void loadChildren(node.path);
      }
      return n;
    });
  };

  const openFile = (node: FileNode) => {
    setSelected(node.path);
    onOpenFile(node.path);
  };

  const openModal = (m: Modal) => {
    setModalName(m.kind === "rename" ? m.initial : "");
    setModal(m);
  };

  const submitModal = async () => {
    if (!modal) return;
    try {
      if (modal.kind === "delete") {
        await ChatService.SessionDeletePath(sessionId, modal.target);
      } else {
        const name = modalName.trim();
        if (!name) return;
        if (modal.kind === "file") await ChatService.SessionCreateFile(sessionId, joinPath(modal.dir, name), "");
        else if (modal.kind === "folder") await ChatService.SessionCreateDir(sessionId, joinPath(modal.dir, name));
        else if (modal.kind === "rename") await ChatService.SessionRenamePath(sessionId, modal.target, name);
      }
      setModal(null);
      setError(null);
      // 刷新受影响目录:父目录 + 其下已展开子目录。
      void loadChildren(modal.dir);
      for (const d of expanded) {
        if (d === modal.dir || d.startsWith(modal.dir + "/")) void loadChildren(d);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  // 目录是否含变更(任意后代路径命中 statusByPath)。
  const dirDirty = (dir: string) => {
    const prefix = dir + "/";
    for (const p in statusByPath) if (p.startsWith(prefix)) return true;
    return false;
  };

  // HTML5 drag-out of a file row (issue #149): the payload carries this panel's
  // session id + the node's original (root-relative) path under the agreed MIME;
  // the chat area turns the drop into an @mention (see ChatView onDrop).
  // effectAllowed=copy + the browser's row-snapshot ghost; no dataTransfer
  // fiddling beyond setData so the default ghost stays intact.
  const dragRowStart = (e: React.DragEvent, node: FileNode) => {
    writePanelFilePayload(e.dataTransfer, { sessionId, path: node.path });
    e.dataTransfer.effectAllowed = "copy";
  };
  const renderNode = (node: FileNode, depth: number) => {
    const pad = 8 + depth * 14;
    if (node.isDir) {
      const isOpen = expanded.has(node.path);
      const isLoading = loading.has(node.path) && !children[node.path];
      const dirty = dirDirty(node.path);
      return (
        <div key={node.path}>
          <div
            className={`tree-row ${selected === node.path ? "sel" : ""}`}
            style={{ paddingLeft: pad }}
            onClick={() => toggleDir(node)}
            onContextMenu={(e) => openCtxMenu(e, node)}
          >
            <span className="tree-caret">
              {isLoading ? <RefreshCw size={11} className="spin" /> : isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
            {isOpen ? <FolderOpen size={14} className="tree-ico-dir" /> : <Folder size={14} className="tree-ico-dir" />}
            <span className={`tree-name ${dirty ? "dirty" : ""}`}>{node.name}</span>
            <span className="tree-acts">
              <button className="tree-act" title={t("common.newFile")} onClick={(e) => { e.stopPropagation(); openModal({ kind: "file", dir: node.path }); }}><FilePlus2 size={13} /></button>
              <button className="tree-act" title={t("common.rename")} onClick={(e) => { e.stopPropagation(); openModal({ kind: "rename", dir: depth === 0 ? "" : node.path.substring(0, node.path.lastIndexOf("/")), target: node.path, initial: node.name }); }}><Pencil size={12} /></button>
              <button className="tree-act danger" title={t("common.delete")} onClick={(e) => { e.stopPropagation(); openModal({ kind: "delete", dir: depth === 0 ? "" : node.path.substring(0, node.path.lastIndexOf("/")), target: node.path, isDir: true }); }}><Trash2 size={12} /></button>
            </span>
          </div>
          {isOpen && (children[node.path] || []).map((c) => renderNode(c, depth + 1))}
        </div>
      );
    }
    const st = statusByPath[node.path];
    return (
      <div
        key={node.path}
        className={`tree-row ${selected === node.path ? "sel" : ""}`}
        style={{ paddingLeft: pad }}
        data-testid="tree-file-row"
        data-path={node.path}
        draggable={!coarsePointer}
        onDragStart={(e) => dragRowStart(e, node)}
        onClick={() => void openFile(node)}
        onContextMenu={(e) => openCtxMenu(e, node)}
      >
        <span className="tree-caret" />
        <FileIcon size={13} className="tree-ico-file" />
        <span className={`tree-name ${st ? "stc-" + st.toLowerCase() : ""}`}>{node.name}</span>
        {st && <span className={`tree-badge st-${st.toLowerCase()}`}>{st}</span>}
        <span className="tree-acts">
          <button className="tree-act" title={t("common.rename")} onClick={(e) => { e.stopPropagation(); openModal({ kind: "rename", dir: node.path.substring(0, node.path.lastIndexOf("/")), target: node.path, initial: node.name }); }}><Pencil size={12} /></button>
          <button className="tree-act danger" title={t("common.delete")} onClick={(e) => { e.stopPropagation(); openModal({ kind: "delete", dir: node.path.substring(0, node.path.lastIndexOf("/")), target: node.path, isDir: false }); }}><Trash2 size={12} /></button>
        </span>
      </div>
    );
  };

  const rootChildren = children[""] || [];
  const rootLoading = loading.has("") && rootChildren.length === 0;

  return (
    <div className="file-panel" data-testid="file-panel">
      <div className="file-toolbar">
        <span className="file-root-name" title={rootName}>{rootName}</span>
        <span className="file-toolbar-acts">
          <button
            className="tool-btn"
            data-testid="file-search-toggle"
            data-tooltip-id="md-tip"
            data-tooltip-content={t("filePanel.search")}
            data-tooltip-place="bottom"
            onClick={toggleSearch}
          >
            <Search size={14} />
          </button>
          <button className="tool-btn" title={t("common.newFile")} onClick={() => openModal({ kind: "file", dir: "" })}><FilePlus2 size={15} /></button>
          <button className="tool-btn" title={t("common.newFolder")} onClick={() => openModal({ kind: "folder", dir: "" })}><FolderPlus size={15} /></button>
          <button className="tool-btn" title={t("common.refresh")} onClick={refresh}><RefreshCw size={14} /></button>
        </span>
      </div>

      {searchOpen && (
        <div className="file-search-row">
          <Search size={12} />
          <input
            ref={searchInputRef}
            className="file-search-input"
            data-testid="file-search-input"
            placeholder={t("filePanel.searchPlaceholder")}
            autoComplete="off"
            spellCheck={false}
          />
          {searching && <span className="search-spinner" data-testid="file-search-spinner" />}
        </div>
      )}

      {error && <div className="file-error">{error}</div>}

      <div className="tree-body">
        {searchActive ? (
          <>
            {searching && !results && <div className="tree-empty">{t("filePanel.searchSearching")}</div>}
            {results && results.length === 0 && (
              <div className="tree-empty" data-testid="file-search-empty">{t("filePanel.searchNoResults")}</div>
            )}
            {(results || []).map((node, i) => (
              <div
                key={node.path}
                ref={i === activeIdx ? (el: HTMLDivElement | null) => { activeRowRef.current = el; } : undefined}
                className={`tree-row file-search-item ${i === activeIdx ? "sel" : ""}`}
                data-testid="file-search-item"
                data-path={node.path}
                style={{ paddingLeft: 8 }}
                onClick={() => pickResult(node)}
                onMouseEnter={() => setActiveIdx(i)}
              >
                {node.isDir ? <Folder size={13} className="tree-ico-dir" /> : <FileIcon size={13} className="tree-ico-file" />}
                {/* Full path is already visible in-row via .file-search-path — no native title (§4.5). */}
                <span className="tree-name">{node.name}</span>
                <span className="file-search-path">{node.path}</span>
              </div>
            ))}
          </>
        ) : showHistory ? (
          <div
            className="file-search-history"
            data-testid="file-search-history"
            aria-label={t("filePanel.searchHistory")}
          >
            {/* Row mousedown preventDefault keeps focus in the input, so the
                dropdown does not vanish between mousedown and click; the ✕
                stops propagation (deleting never backfills) AND cancels the
                default — Chromium-family engines focus buttons on mousedown,
                whose blur would unmount the dropdown before the click lands. */}
            {recent.map((q) => (
              <div
                key={q}
                className="tree-row file-search-item"
                data-testid="file-search-history-item"
                data-query={q}
                data-tooltip-id="md-tip"
                data-tooltip-content={q}
                data-tooltip-place="bottom"
                style={{ paddingLeft: 8 }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyHistory(q)}
              >
                <History size={13} className="tree-ico-file" />
                <span className="tree-name">{q}</span>
                <span className="tree-acts">
                  <button
                    className="tree-act"
                    data-testid="file-search-history-delete"
                    aria-label={t("filePanel.searchHistoryDelete")}
                    data-tooltip-id="md-tip"
                    data-tooltip-content={t("filePanel.searchHistoryDelete")}
                    data-tooltip-place="top"
                    onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onClick={(e) => { e.stopPropagation(); deleteHistory(q); }}
                  >
                    <X size={12} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <>
            {rootLoading && <div className="tree-empty">{t("filePanel.loadingTree")}</div>}
            {!rootLoading && rootChildren.length === 0 && <div className="tree-empty">{t("filePanel.emptyDir")}</div>}
            {rootChildren.map((n) => renderNode(n, 0))}
          </>
        )}
      </div>

      {ctxMenu && (() => {
        const node = ctxMenu.node;
        const parent = node.path.includes("/") ? node.path.substring(0, node.path.lastIndexOf("/")) : "";
        return (
          <div
            ref={ctxMenuRef}
            className="ctx-menu"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button className="ctx-item" onClick={() => { const p = absPath(node.path); if (p) copyTextQuiet(p); closeCtxMenu(); }}>
              <Copy size={13} /> {t("filePanel.copyPath")}
            </button>
            <button className="ctx-item" onClick={() => { const p = absPath(node.path); if (p) void ChatService.RevealPath(p); closeCtxMenu(); }}>
              <FolderOpen size={13} /> {t("filePanel.revealInFinder")}
            </button>
            <div className="ctx-sep" />
            {node.isDir && (
              <button className="ctx-item" onClick={() => { openModal({ kind: "file", dir: node.path }); closeCtxMenu(); }}>
                <FilePlus2 size={13} /> {t("common.newFile")}
              </button>
            )}
            <button className="ctx-item" onClick={() => { openModal({ kind: "rename", dir: parent, target: node.path, initial: node.name }); closeCtxMenu(); }}>
              <Pencil size={13} /> {t("common.rename")}
            </button>
            <button className="ctx-item danger" onClick={() => { openModal({ kind: "delete", dir: parent, target: node.path, isDir: node.isDir }); closeCtxMenu(); }}>
              <Trash2 size={13} /> {t("common.delete")}
            </button>
          </div>
        );
      })()}

      {modal && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">
              {modal.kind === "delete"
                ? (modal.isDir ? t("filePanel.deleteFolderTitle") : t("filePanel.deleteFileTitle"))
                : modal.kind === "rename"
                ? t("filePanel.renameTitle")
                : modal.kind === "file"
                ? t("filePanel.newFileTitle")
                : t("filePanel.newFolderTitle")}
            </div>
            {modal.kind !== "delete" && (
              <input
                className="modal-input"
                autoFocus
                placeholder={t("filePanel.namePlaceholder")}
                value={modalName}
                onChange={(e) => setModalName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitModal();
                  if (e.key === "Escape") setModal(null);
                }}
              />
            )}
            {modal.kind === "delete" && (
              <div className="modal-del-target" title={modal.target}>{modal.target}</div>
            )}
            <div className="modal-actions">
              <button className="modal-btn ghost" onClick={() => setModal(null)}>{t("common.cancel")}</button>
              <button
                className={`modal-btn ${modal.kind === "delete" ? "danger" : "primary"}`}
                onClick={() => void submitModal()}
                disabled={modal.kind !== "delete" && modalName.trim() === ""}
              >
                {modal.kind === "delete" ? t("common.delete") : t("common.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
