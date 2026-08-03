import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Folder,
  GitBranch,
  Plus,
  Minus,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Check,
  Sparkles,
} from "lucide-react";
import type { FileChange } from "../../bindings/github.com/jessonchan/monkey-deck/internal/worktree/models";

interface Props {
  branch: string;
  baseRef: string;  // worktree 基线分支(合并目标);空=旧 session → 合到主仓库 HEAD
  changes: FileChange[] | null;
  mergeResult: string | null;
  mergeable: boolean;  // branch 有无领先基线的已提交 commit(无则 disable + 提示)
  isGuest: boolean;  // guest(进入已有 worktree)→ 合并禁用 + 「无权合并」提示
  onMerge: () => void;
  // VS Code SCM 风格:暂存 / 取消暂存 / 丢弃 / 提交。paths 为空表示「全部」。
  onStage: (paths: string[]) => Promise<void>;
  onUnstage: (paths: string[]) => Promise<void>;
  onDiscard: (paths: string[]) => Promise<void>;
  // AI 提交:让当前 session 的 agent 自动生成提交信息并提交(复用对话,架构 A)。
  onAICommit: () => Promise<void>;
  onCommit: (message: string) => Promise<void>;
  // Click a file: open a diff tab in the middle column (staged picks index vs working tree).
  onOpenDiff: (path: string, staged: boolean) => void;
  // 一轮对话进行中:禁用写操作,避免与 opencode 写文件竞争 git index。
  busy: boolean;
  // embedded=true 时隐藏顶部标题行(由 SidePanel 的 tab 接管标题)。
  embedded?: boolean;
}

// 状态字母 → 文案 + 配色(VS Code 风格)。
const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  M: { label: "M", cls: "st-modified" },
  A: { label: "A", cls: "st-added" },
  D: { label: "D", cls: "st-deleted" },
  U: { label: "U", cls: "st-untracked" },
  R: { label: "R", cls: "st-renamed" },
};

export default function GitPanel({
  branch,
  baseRef,
  changes,
  mergeResult,
  mergeable,
  isGuest,
  onMerge,
  onStage,
  onUnstage,
  onDiscard,
  onAICommit,
  onCommit,
  onOpenDiff,
  busy,
  embedded,
}: Props) {
  const { t } = useTranslation();
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
    if (!msg || staged.length === 0 || busy) return;
    try {
      setErr(null);
      await onCommit(msg);
      setMessage(""); // 成功才清空,失败保留让用户改
    } catch (e) {
      setErr(String(e));
    }
  };

  // AI 提交:让 agent 自动生成信息并提交。失败时显示内联错误。
  const aiCommit = async () => {
    if (busy) return;
    try {
      setErr(null);
      await onAICommit();
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

  // One file row: status badge + name (click → open diff tab in the middle column) + dir + actions.
  const row = (f: FileChange, actions: ReactNode) => {
    const st = STATUS_STYLE[f.status] || STATUS_STYLE.M;
    return (
      <div key={f.path} className="git-file-row-wrap">
        <div className="git-file-row">
          <span className={`git-status-badge ${st.cls}`}>{st.label}</span>
          <button
            className="git-file-name-btn"
            title={t("gitPanel.viewChanges")}
            data-testid="file-toggle"
            onClick={() => onOpenDiff(f.path, f.staged)}
          >
            {fileName(f.path)}
          </button>
          <span className="git-file-dir">{fileDir(f.path)}</span>
          <span className="git-file-actions">{actions}</span>
        </div>
      </div>
    );
  };

  return (
    <aside className={"git-panel" + (busy ? " git-panel-busy" : "")} data-testid="git-panel">
      {!embedded && (
        <div className="git-panel-head">
          <Folder size={13} />
          <span className="git-panel-title">{t("gitPanel.title")}</span>
          {busy && <span className="git-panel-busy-tag">{t("gitPanel.busyTag")}</span>}
        </div>
      )}

      <div className="git-scm-branch" title={branch}>
        <GitBranch size={12} />
        <span className="git-branch-name">{branch}</span>
      </div>

      <textarea
        className="git-commit-msg"
        data-testid="commit-message"
        placeholder={busy ? t("gitPanel.commitPlaceholderBusy") : t("gitPanel.commitPlaceholder")}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        rows={2}
        disabled={busy}
      />
      <button
        className="git-commit-btn"
        data-testid="commit-btn"
        disabled={busy || staged.length === 0 || message.trim() === ""}
        onClick={commit}
      >
        <Check size={14} /> {staged.length > 0 ? t("gitPanel.commitBtnCount", { count: staged.length }) : t("gitPanel.commitBtn")}
      </button>
      <button
        className="git-ai-btn"
        data-testid="ai-commit-btn"
        title={t("gitPanel.aiCommitTip")}
        disabled={busy || (changes != null && changes.length === 0)}
        onClick={aiCommit}
      >
        <Sparkles size={14} /> {t("gitPanel.aiCommit")}
      </button>

      {err && <div className="git-commit-err" data-testid="commit-error">{err}</div>}

      <Group
        title={t("gitPanel.stagedChanges")}
        count={staged.length}
        open={openStaged}
        loading={loading}
        onToggle={() => setOpenStaged((v) => !v)}
        allAction={
          staged.length > 0 ? (
            <button className="git-row-act" title={t("gitPanel.unstageAll")} disabled={busy} onClick={() => onUnstage([])}>
              <Minus size={14} />
            </button>
          ) : null
        }
      >
        {staged.map((f) =>
          row(f, (
            <button className="git-row-act" title={t("gitPanel.unstage")} disabled={busy} onClick={() => onUnstage([f.path])}>
              <Minus size={14} />
            </button>
          ))
        )}
      </Group>

      <Group
        title={t("gitPanel.unstagedChanges")}
        count={unstaged.length}
        open={openChanges}
        loading={loading}
        onToggle={() => setOpenChanges((v) => !v)}
        allAction={
          unstaged.length > 0 ? (
            <button className="git-row-act" title={t("gitPanel.stageAll")} disabled={busy} onClick={() => onStage([])}>
              <Plus size={14} />
            </button>
          ) : null
        }
      >
        {unstaged.map((f) =>
          row(f, (
            <>
              <button
                className="git-row-act"
                title={t("gitPanel.stage")}
                data-testid="stage-one"
                disabled={busy}
                onClick={() => onStage([f.path])}
              >
                <Plus size={14} />
              </button>
              <button
                className="git-row-act git-row-discard"
                title={t("gitPanel.discardTip")}
                data-testid="discard-one"
                disabled={busy}
                onClick={() => discard([f.path])}
              >
                <RotateCcw size={13} />
              </button>
            </>
          ))
        )}
      </Group>

      <button
        className={`merge-btn-full${!mergeable || isGuest ? " disabled-hint" : ""}`}
        onClick={onMerge}
        disabled={busy || !mergeable || isGuest}
        data-testid="merge-btn"
        data-tooltip-id="md-tip"
        data-tooltip-content={isGuest
          ? t("gitPanel.mergeGuestTip")
          : (mergeable
              ? (baseRef ? t("gitPanel.mergeTipBase", { branch: baseRef }) : t("gitPanel.mergeTipLegacy"))
              : t("gitPanel.mergeNothingTip"))}
      >
        {isGuest
          ? t("gitPanel.mergeGuest")
          : (mergeable
              ? (baseRef ? t("gitPanel.mergeIntoBase", { branch: baseRef }) : t("gitPanel.mergeBtn"))
              : t("gitPanel.mergeNothing"))}
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
  const { t } = useTranslation();
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
      {open && count === 0 && !loading && <div className="git-no-changes">{t("gitPanel.noChanges")}</div>}
      {open && children}
    </div>
  );
}

