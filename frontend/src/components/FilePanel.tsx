import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { FileNode } from "../../bindings/github.com/jessonchan/monkey-deck/internal/fsview/models";
import type { FileChange } from "../../bindings/github.com/jessonchan/monkey-deck/internal/worktree/models";
import CodeViewer from "./CodeViewer";
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
  X,
} from "lucide-react";

interface Props {
  sessionId: string;
  rootName: string;
  changes: FileChange[] | null;
  status: string;
}

type ChildrenMap = Record<string, FileNode[]>;

type Modal =
  | { kind: "file"; dir: string }
  | { kind: "folder"; dir: string }
  | { kind: "rename"; dir: string; target: string; initial: string }
  | { kind: "delete"; dir: string; target: string; isDir: boolean };

const joinPath = (dir: string, name: string) => (dir === "" ? name : dir + "/" + name);

export default function FilePanel({ sessionId, rootName, changes, status }: Props) {
  const { t } = useTranslation();
  const [children, setChildren] = useState<ChildrenMap>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ name: string; path: string; content: string } | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [modalName, setModalName] = useState("");
  const [tick, setTick] = useState(0);

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

  // session 切换:重置 + 载入根。
  useEffect(() => {
    setChildren({});
    setExpanded(new Set());
    setSelected(null);
    setPreview(null);
    setModal(null);
    void loadChildren("");
  }, [sessionId, loadChildren]);

  // 预览支持 Esc 关闭(§4.2)。
  useEffect(() => {
    if (!preview && !modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPreview(null);
        setModal(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview, modal]);

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

  const openFile = async (node: FileNode) => {
    setSelected(node.path);
    try {
      const content = await ChatService.SessionReadFile(sessionId, node.path);
      setPreview({ name: node.name, path: node.path, content });
    } catch (e) {
      setPreview({ name: node.name, path: node.path, content: t("filePanel.readFailed", { error: String(e) }) });
    }
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
        onClick={() => void openFile(node)}
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
          <button className="tool-btn" title={t("common.newFile")} onClick={() => openModal({ kind: "file", dir: "" })}><FilePlus2 size={15} /></button>
          <button className="tool-btn" title={t("common.newFolder")} onClick={() => openModal({ kind: "folder", dir: "" })}><FolderPlus size={15} /></button>
          <button className="tool-btn" title={t("common.refresh")} onClick={refresh}><RefreshCw size={14} /></button>
        </span>
      </div>

      {error && <div className="file-error">{error}</div>}

      <div className="tree-body">
        {rootLoading && <div className="tree-empty">{t("filePanel.loadingTree")}</div>}
        {!rootLoading && rootChildren.length === 0 && <div className="tree-empty">{t("filePanel.emptyDir")}</div>}
        {rootChildren.map((n) => renderNode(n, 0))}
      </div>

      {preview && (
        <div className="preview-overlay" onClick={() => setPreview(null)}>
          <div className="preview-card" onClick={(e) => e.stopPropagation()}>
            <div className="preview-head">
              <FileIcon size={14} />
              <span className="preview-name" title={preview.path}>{preview.name}</span>
              <span className="preview-path">{preview.path}</span>
              <button className="tool-btn" title={t("filePanel.copyContent")} onClick={() => { void navigator.clipboard?.writeText(preview.content); }}><Copy size={14} /></button>
              <button className="tool-btn" title={t("common.closeEsc")} onClick={() => setPreview(null)}><X size={16} /></button>
            </div>
            <CodeViewer content={preview.content} filename={preview.name} testId="file-panel-viewer" />
          </div>
        </div>
      )}

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
