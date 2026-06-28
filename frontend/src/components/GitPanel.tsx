import { useState } from "react";
import { Folder, ArrowUp } from "lucide-react";
import type { FileChange } from "../../bindings/github.com/jessonchan/monkey-deck/internal/worktree/models";

interface Props {
  branch: string;
  changes: FileChange[] | null;
  commitCount: number;
  mergeResult: string | null;
  onMerge: () => void;
}

// VS Code 风格的 Git 面板:文件级变更列表 + 彩色状态标签 + 合并按钮。
const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  M: { label: "M", cls: "st-modified" },
  A: { label: "A", cls: "st-added" },
  D: { label: "D", cls: "st-deleted" },
  U: { label: "U", cls: "st-untracked" },
  R: { label: "R", cls: "st-renamed" },
};

export default function GitPanel({ branch, changes, commitCount, mergeResult, onMerge }: Props) {
  const hasChanges = changes != null && changes.length > 0;
  const isOk = mergeResult?.startsWith("✅");
  const isFail = mergeResult?.startsWith("❌");
  const [expanded, setExpanded] = useState<string | null>(null);

  const fileName = (p: string) => p.split("/").pop() || p;
  const fileDir = (p: string) => {
    const i = p.lastIndexOf("/");
    return i > 0 ? p.slice(0, i) : "";
  };

  return (
    <aside className="git-panel" data-testid="git-panel">
      <div className="git-panel-head">
        <Folder size={13} />
        <span className="git-panel-title">源代码管理</span>
      </div>

      <div className="git-section">
        <span className="git-branch-name" title={branch}>{branch}</span>
      </div>

      <div className="git-section git-changes">
        <div className="git-section-label">
          {changes == null ? "加载中…" : hasChanges ? `变更 (${changes.length})` : "无变更"}
          {commitCount > 0 && <span className="git-commit-count">{commitCount} 个提交</span>}
        </div>
        {changes?.map((f) => {
          const st = STATUS_STYLE[f.status] || STATUS_STYLE.M;
          const dir = fileDir(f.path);
          return (
            <div key={f.path} className="git-file-row" onClick={() => setExpanded(expanded === f.path ? null : f.path)}>
              <span className={`git-status-badge ${st.cls}`}>{st.label}</span>
              <span className="git-file-name">{fileName(f.path)}</span>
              <span className="git-file-dir">{dir}</span>
            </div>
          );
        })}
      </div>

      {hasChanges && (
        <button className="merge-btn-full" onClick={onMerge} data-testid="merge-btn">
        <ArrowUp size={14} /> 合并进主仓库
        </button>
      )}

      {mergeResult && (
        <div className={`git-merge-result ${isOk ? "ok" : ""} ${isFail ? "fail" : ""}`}>
          {mergeResult}
        </div>
      )}
    </aside>
  );
}
