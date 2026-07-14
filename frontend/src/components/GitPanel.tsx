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
  Sparkles,
} from "lucide-react";
import type { FileChange } from "../../bindings/github.com/jessonchan/monkey-deck/internal/worktree/models";
import CollapsibleText from "./CollapsibleText";
import { countDiffLines, diffLineCls } from "../lib/diff";

interface Props {
  branch: string;
  changes: FileChange[] | null;
  mergeResult: string | null;
  onMerge: () => void;
  // VS Code SCM 风格:暂存 / 取消暂存 / 丢弃 / 提交。paths 为空表示「全部」。
  onStage: (paths: string[]) => Promise<void>;
  onUnstage: (paths: string[]) => Promise<void>;
  onDiscard: (paths: string[]) => Promise<void>;
  // AI 提交:让当前 session 的 agent 自动生成提交信息并提交(复用对话,架构 A)。
  onAICommit: () => Promise<void>;
  onCommit: (message: string) => Promise<void>;
  // 点击文件查看改动(staged 区分暂存/工作区上下文)。
  onDiff: (path: string, staged: boolean) => Promise<string>;
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

// 源代码管理面板,参考 VS Code SCM:提交信息框 + 提交按钮 + 暂存/工作区两组 + 逐文件操作 + 点击查看 diff。
export default function GitPanel({
  branch,
  changes,
  mergeResult,
  onMerge,
  onStage,
  onUnstage,
  onDiscard,
  onAICommit,
  onCommit,
  onDiff,
  busy,
  embedded,
}: Props) {
  const [message, setMessage] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [openStaged, setOpenStaged] = useState(true);
  const [openChanges, setOpenChanges] = useState(true);
  // 单文件 diff 展开:key = 组前缀 + path;同一时刻只展开一个。
  const [diffKey, setDiffKey] = useState<string | null>(null);
  const [diffText, setDiffText] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);

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

  // 点击文件名:切换 diff 展开。staged 决定 diff 上下文(暂存 vs 工作区)。
  const toggleDiff = async (key: string, path: string, staged: boolean) => {
    if (diffKey === key) {
      setDiffKey(null);
      return;
    }
    setDiffKey(key);
    setDiffLoading(true);
    setDiffText("");
    try {
      setDiffText(await onDiff(path, staged));
    } catch (e) {
      setDiffText("加载失败:" + String(e));
    } finally {
      setDiffLoading(false);
    }
  };

  const isOk = mergeResult?.startsWith("✅");
  const isFail = mergeResult?.startsWith("❌");

  // 单行文件:状态徽标 + 文件名(可点击查看 diff)+ 目录 + 右侧操作按钮 + 展开的 diff。
  const row = (f: FileChange, keyPrefix: string, actions: ReactNode) => {
    const st = STATUS_STYLE[f.status] || STATUS_STYLE.M;
    const key = keyPrefix + f.path;
    const expanded = diffKey === key;
    return (
      <div key={key} className="git-file-row-wrap">
        <div className="git-file-row">
          <span className={`git-status-badge ${st.cls}`}>{st.label}</span>
          <button
            className="git-file-name-btn"
            title="查看改动"
            data-testid="file-toggle"
            onClick={() => toggleDiff(key, f.path, f.staged)}
          >
            {fileName(f.path)}
          </button>
          <span className="git-file-dir">{fileDir(f.path)}</span>
          <span className="git-file-actions">{actions}</span>
        </div>
        {expanded && (
          <div className="git-file-diff-wrap" data-testid="file-diff">
            {diffLoading ? (
              <div className="git-file-diff-msg">加载中…</div>
            ) : diffText ? (
              <CollapsibleText
                text={diffText}
                lineClassName={diffLineCls}
                preClassName="git-diff-pre"
                testId="file-diff"
                lineUnit="行"
                extra={(() => { const s = countDiffLines(diffText); return (
                  <span className="git-diff-stat">
                    {s.added > 0 && <span className="diff-stat diff-stat-add">+{s.added}</span>}
                    {s.removed > 0 && <span className="diff-stat diff-stat-del">−{s.removed}</span>}
                  </span>
                ); })()}
              />
            ) : (
              <div className="git-file-diff-msg">无差异</div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className={"git-panel" + (busy ? " git-panel-busy" : "")} data-testid="git-panel">
      {!embedded && (
        <div className="git-panel-head">
          <Folder size={13} />
          <span className="git-panel-title">源代码管理</span>
          {busy && <span className="git-panel-busy-tag">对话中</span>}
        </div>
      )}

      <div className="git-scm-branch" title={branch}>
        <GitBranch size={12} />
        <span className="git-branch-name">{branch}</span>
      </div>

      <textarea
        className="git-commit-msg"
        data-testid="commit-message"
        placeholder={busy ? "对话进行中,结束后可提交…" : "提交信息(Cmd / Ctrl + Enter 提交)"}
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
        <Check size={14} /> 提交{staged.length > 0 ? ` (${staged.length})` : ""}
      </button>
      <button
        className="git-ai-btn"
        data-testid="ai-commit-btn"
        title="让当前会话的 AI 审视改动、生成提交信息并提交"
        disabled={busy || (changes != null && changes.length === 0)}
        onClick={aiCommit}
      >
        <Sparkles size={14} /> AI 提交
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
            <button className="git-row-act" title="全部取消暂存" disabled={busy} onClick={() => onUnstage([])}>
              <Minus size={14} />
            </button>
          ) : null
        }
      >
        {staged.map((f) =>
          row(f, "s", (
            <button className="git-row-act" title="取消暂存" disabled={busy} onClick={() => onUnstage([f.path])}>
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
            <button className="git-row-act" title="全部暂存" disabled={busy} onClick={() => onStage([])}>
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
                disabled={busy}
                onClick={() => onStage([f.path])}
              >
                <Plus size={14} />
              </button>
              <button
                className="git-row-act git-row-discard"
                title="丢弃改动 · 不可撤销"
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

      <button className="merge-btn-full" onClick={onMerge} disabled={busy} data-testid="merge-btn">
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
