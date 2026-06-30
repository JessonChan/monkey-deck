import { useEffect, useState } from "react";
import type { Harness } from "../../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";

interface Props {
  harnesses: Harness[];
  isGit: boolean;
  onConfirm: (harness: string, useWorktree: boolean) => void;
  onCancel: () => void;
}

// 新建对话弹窗:让用户选择 1) 使用的 agent harness(opencode/mino/omp)2) 是否新建独立分支(worktree)。
// harness 决定 spawn 哪个 ACP agent;worktree 决定是否为该会话建独立 git 工作树(并行隔离,§1.4)。
export default function NewSessionModal({ harnesses, isGit, onConfirm, onCancel }: Props) {
  const [harness, setHarness] = useState(harnesses[0]?.id || "opencode");
  const [useWorktree, setUseWorktree] = useState(true);

  // Esc 关闭(§4.2)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card new-session-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">新建对话</div>

        <div className="ns-field">
          <div className="ns-label">选择 agent</div>
          <div className="ns-harness-list">
            {harnesses.map((h) => (
              <button
                key={h.id}
                className={`ns-harness ${harness === h.id ? "active" : ""}`}
                onClick={() => setHarness(h.id)}
                data-testid={`ns-harness-${h.id}`}
              >
                <span className={`ns-radio ${harness === h.id ? "on" : ""}`} />
                <span className="ns-harness-name">{h.name}</span>
                <span className="ns-harness-cmd" data-tooltip-id="md-tip" data-tooltip-content={h.command}>{h.command}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="ns-field">
          <button
            className={`ns-worktree ${useWorktree && isGit ? "active" : ""}`}
            disabled={!isGit}
            onClick={() => isGit && setUseWorktree((v) => !v)}
            data-testid="ns-worktree-toggle"
          >
            <span className={`ns-check ${useWorktree && isGit ? "on" : ""}`} />
            <span className="ns-worktree-text">
              <span className="ns-worktree-title">新建独立分支（worktree）</span>
              <span className="ns-worktree-desc">
                {isGit
                  ? "为本次对话创建独立的 git 工作树与分支，多会话互不污染，可合并回主仓库"
                  : "当前项目不是 Git 仓库，无法创建独立分支"}
              </span>
            </span>
          </button>
        </div>

        <div className="modal-actions">
          <button className="modal-btn ghost" onClick={onCancel}>取消</button>
          <button
            className="modal-btn primary"
            onClick={() => onConfirm(harness, useWorktree && isGit)}
            data-testid="ns-confirm"
          >
            新建
          </button>
        </div>
      </div>
    </div>
  );
}
