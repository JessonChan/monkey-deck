import { useState, type ReactNode } from "react";
import {
  Folder,
  GitBranch,
  Plus,
  Minus,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Check,
} from "lucide-react";
import type { FileChange } from "../../bindings/github.com/jessonchan/monkey-deck/internal/worktree/models";

interface Props {
  branch: string;
  changes: FileChange[] | null;
  mergeResult: string | null;
  onMerge: () => void;
  // VS Code SCM 风格:暂存 / 取消暂存 / 丢弃 / 提交。paths 为空表示「全部」。
  onStage: (paths: string[]) => Promise<void>;
  onUnstage: (paths: string[]) => Promise<void>;
  onDiscard: (paths: string[]) => Promise<void>;
  onCommit: (message: string) => Promise<void>;
}

// 状态字母 → 文案 + 配色(VS Code 风格)。
const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  M: { label: "M", cls: "st-modified" },
  A: { label: "A", cls: "st-added" },
  D: { label: "D", cls: "st-deleted" },
  U: { label: "U", cls: "st-untracked" },
  R: { label: "R", cls: "st-renamed" },
};

// 源代码管理面板,参考 VS Code SCM:提交信息框 + 提交按钮 + 暂存/工作区两组 + 逐文件操作。
export default function GitPanel({
  branch,
  changes,
  mergeResult,
  onMerge,
  onStage,
  onUnstage,
  onDiscard,
  onCommit,
}: Props) {
  const [message, setMessage] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [openStaged, setOpenStaged] = useState(true);
  const [openChanges, setOpenChanges] = useState(true);

  const staged = (changes || []).filter((c) => c.staged);
  const unstaged = (changes || []).filter((c) => !c.staged);
  const loading = changes == null;

  const fileName = (p: string) => p.split("/").pop() || p;
  const fileDir = (p: string) => {
    const i = p.lastIndexOf("/");
    return i > 0 ? p.slice(0, i) : "";
  };

  const commit = async () => {
    const msg = message.trim();
    if (!msg || staged.length === 0) return;
    try {
      setErr(null);
      await onCommit(msg);
      setMessage(""); // 成功才清空,失败保留让用户改
    } catch (e) {
      setErr(String(e));
    }
  };

  // 丢弃工作区改动:显式点击触发(WKWebView 不保证桥接 window.confirm,故不依赖它)。
  const discard = async (paths: string[]) => {
    try {
      setErr(null);
      await onDiscard(paths);
    } catch (e) {
      setErr(String(e));
    }
  };

  const isOk = mergeResult?.startsWith("✅");
  const isFail = mergeResult?.startsWith("❌");

  // 单行文件:状态徽标 + 文件名 + 目录 + 右侧操作按钮。
  const row = (f: FileChange, keyPrefix: string, actions: ReactNode) => {
    const st = STATUS_STYLE[f.status] || STATUS_STYLE.M;
    return (
      <div key={keyPrefix + f.path} className="git-file-row">
        <span className={`git-status-badge ${st.cls}`}>{st.label}</span>
        <span className="git-file-name">{fileName(f.path)}</span>
        <span className="git-file-dir">{fileDir(f.path)}</span>
        <span className="git-file-actions">{actions}</span>
      </div>
    );
  };

  return (
    <aside className="git-panel" data-testid="git-panel">
      <div className="git-panel-head">
        <Folder size={13} />
        <span className="git-panel-title">源代码管理</span>
      </div>

      <div className="git-scm-branch" title={branch}>
        <GitBranch size={12} />
        <span className="git-branch-name">{branch}</span>
      </div>

      <textarea
        className="git-commit-msg"
        data-testid="commit-message"
        placeholder="提交信息(Cmd / Ctrl + Enter 提交)"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        rows={2}
      />
      <button
        className="git-commit-btn"
        data-testid="commit-btn"
        disabled={staged.length === 0 || message.trim() === ""}
        onClick={commit}
      >
        <Check size={14} /> 提交{staged.length > 0 ? ` (${staged.length})` : ""}
      </button>

      {err && <div className="git-commit-err" data-testid="commit-error">{err}</div>}

      <Group
        title="暂存的更改"
        count={staged.length}
        open={openStaged}
        loading={loading}
        onToggle={() => setOpenStaged((v) => !v)}
        allAction={
          staged.length > 0 ? (
            <button className="git-row-act" title="全部取消暂存" onClick={() => onUnstage([])}>
              <Minus size={14} />
            </button>
          ) : null
        }
      >
        {staged.map((f) =>
          row(f, "s", (
            <button className="git-row-act" title="取消暂存" onClick={() => onUnstage([f.path])}>
              <Minus size={14} />
            </button>
          ))
        )}
      </Group>

      <Group
        title="更改"
        count={unstaged.length}
        open={openChanges}
        loading={loading}
        onToggle={() => setOpenChanges((v) => !v)}
        allAction={
          unstaged.length > 0 ? (
            <button className="git-row-act" title="全部暂存" onClick={() => onStage([])}>
              <Plus size={14} />
            </button>
          ) : null
        }
      >
        {unstaged.map((f) =>
          row(f, "u", (
            <>
              <button
                className="git-row-act"
                title="暂存"
                data-testid="stage-one"
                onClick={() => onStage([f.path])}
              >
                <Plus size={14} />
              </button>
              <button
                className="git-row-act git-row-discard"
                title="丢弃改动 · 不可撤销"
                data-testid="discard-one"
                onClick={() => discard([f.path])}
              >
                <RotateCcw size={13} />
              </button>
            </>
          ))
        )}
      </Group>

      <button className="merge-btn-full" onClick={onMerge} data-testid="merge-btn">
        合并进主仓库
      </button>

      {mergeResult && (
        <div className={`git-merge-result ${isOk ? "ok" : ""} ${isFail ? "fail" : ""}`}>
          {mergeResult}
        </div>
      )}
    </aside>
  );
}

// 折叠组:标题 + 计数 + 折叠箭头 + 组级操作(全部暂存/全部取消暂存)。
function Group({
  title,
  count,
  open,
  loading,
  onToggle,
  allAction,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  loading: boolean;
  onToggle: () => void;
  allAction: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="git-section git-changes">
      <div className="git-section-label">
        <button className="git-group-toggle" onClick={onToggle}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>{title}</span>
          <span className="git-group-count">{loading ? "…" : count}</span>
        </button>
        {allAction}
      </div>
      {open && count === 0 && !loading && <div className="git-no-changes">无</div>}
      {open && children}
    </div>
  );
}
