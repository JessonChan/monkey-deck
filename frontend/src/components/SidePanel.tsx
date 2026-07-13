import { useEffect, useState } from "react";
import { Folder, GitBranch, PanelRightClose } from "lucide-react";
import FilePanel from "./FilePanel";
import GitPanel from "./GitPanel";
import type { FileChange } from "../../bindings/github.com/jessonchan/monkey-deck/internal/worktree/models";

interface Props {
  sessionId: string;
  rootName: string;
  changes: FileChange[] | null;
  status: string;
  // SCM(GitPanel):isGitProject=项目是否 git repo(对齐 orca / VS Code repo-kind 判定,跟 session 是否有独立 worktree 解耦);
  // branch=当前分支名(供 GitPanel 展示用, GitPanel 不用于判定 SCM 可见性)。
  isGitProject: boolean;
  branch: string;
  mergeResult: string | null;
  onMerge: () => void;
  onStage: (paths: string[]) => Promise<void>;
  onUnstage: (paths: string[]) => Promise<void>;
  onDiscard: (paths: string[]) => Promise<void>;
  onCommit: (message: string) => Promise<void>;
  // AI 提交:转发给 GitPanel。
  onAICommit: () => Promise<void>;
  onDiff: (path: string, staged: boolean) => Promise<string>;
  busy: boolean;
  onCollapse?: () => void;
}

type Tab = "files" | "scm";

// 右侧面板:仿 VSCode 侧栏「文件 / 源代码管理」两个视图切换。
// isGitProject=true 时显示「源代码管理」tab,否则只有「文件」。
export default function SidePanel(props: Props) {
  const hasSCM = props.isGitProject;
  const [tab, setTab] = useState<Tab>("files");

  // 切到无 SCM 的 session 时,若当前停在 scm tab 则回到 files。
  useEffect(() => {
    if (!hasSCM && tab === "scm") setTab("files");
  }, [hasSCM, tab]);

  return (
    <aside className="side-panel" data-testid="side-panel">
      <div className="side-tabs">
        <button
          className={`side-tab ${tab === "files" ? "active" : ""}`}
          onClick={() => setTab("files")}
          title="文件"
        >
          <Folder size={15} />
          <span>文件</span>
        </button>
        {hasSCM && (
          <button
            className={`side-tab ${tab === "scm" ? "active" : ""}`}
            onClick={() => setTab("scm")}
            title="源代码管理"
          >
            <GitBranch size={15} />
            <span>源代码管理</span>
          </button>
        )}
        <button
          className="icon-btn side-collapse-btn"
          data-testid="collapse-side"
          onClick={() => props.onCollapse?.()}
          data-tooltip-id="md-tip"
          data-tooltip-content="收起右侧面板"
          data-tooltip-place="bottom"
        >
          <PanelRightClose size={15} />
        </button>
      </div>
      <div className="side-body">
        {tab === "files" ? (
          <FilePanel sessionId={props.sessionId} rootName={props.rootName} changes={props.changes} status={props.status} />
        ) : (
          <GitPanel
            embedded
            branch={props.branch}
            changes={props.changes}
            mergeResult={props.mergeResult}
            onMerge={props.onMerge}
            onStage={props.onStage}
            onUnstage={props.onUnstage}
            onDiscard={props.onDiscard}
            onAICommit={props.onAICommit}
            onCommit={props.onCommit}
            onDiff={props.onDiff}
            busy={props.busy}
          />
        )}
      </div>
    </aside>
  );
}
