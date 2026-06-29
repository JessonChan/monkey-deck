import { useEffect, useState } from "react";
import { Folder, GitBranch } from "lucide-react";
import FilePanel from "./FilePanel";
import GitPanel from "./GitPanel";
import type { FileChange } from "../../bindings/github.com/jessonchan/monkey-deck/internal/worktree/models";

interface Props {
  sessionId: string;
  rootName: string;
  changes: FileChange[] | null;
  status: string;
  // SCM(GitPanel)
  branch: string;
  mergeResult: string | null;
  onMerge: () => void;
  onStage: (paths: string[]) => Promise<void>;
  onUnstage: (paths: string[]) => Promise<void>;
  onDiscard: (paths: string[]) => Promise<void>;
  onCommit: (message: string) => Promise<void>;
}

type Tab = "files" | "scm";

// 右侧面板:仿 VSCode 侧栏「文件 / 源代码管理」两个视图切换。
// 非分支 session(git 项目未建 worktree / 非 git 项目)只显示「文件」。
export default function SidePanel(props: Props) {
  const hasSCM = !!props.branch;
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
            onCommit={props.onCommit}
          />
        )}
      </div>
    </aside>
  );
}
