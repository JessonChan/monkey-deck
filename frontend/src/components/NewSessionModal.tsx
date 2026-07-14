import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Harness } from "../../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";

interface Props {
  harnesses: Harness[];
  isGit: boolean;
  onConfirm: (harness: string, useWorktree: boolean) => void;
  onCancel: () => void;
}

// 新建对话弹窗:让用户选择 1) 使用的 agent harness(omp/opencode)2) 是否新建独立分支(worktree)。
// harness 决定 spawn 哪个 ACP agent;worktree 决定是否为该会话建独立 git 工作树(并行隔离,§1.4)。
// git 项目下 worktree 必须显式二选一(新建分支 / 使用项目目录),无默认,未选时「新建」按钮禁用。
// 非 git 项目不展示 worktree 选项(无法建分支)。
export default function NewSessionModal({ harnesses, isGit, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  const [harness, setHarness] = useState(harnesses[0]?.id || "omp");
  // worktree 必须显式选择:null = 未选(默认),true = 新建,false = 使用项目目录。
  const [worktree, setWorktree] = useState<boolean | null>(isGit ? null : false);

  // Esc 关闭(§4.2)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const canConfirm = !isGit || worktree !== null;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card new-session-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{t("newSession.title")}</div>

        <div className="ns-field">
          <div className="ns-label">{t("newSession.selectAgent")}</div>
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

        {isGit && (
          <div className="ns-field">
            <div className="ns-label">
              {t("newSession.workdir")}
              {worktree === null && <span className="ns-required">{t("newSession.required")}</span>}
            </div>
            <div className="ns-worktree-group">
              <button
                className={`ns-worktree ${worktree === false ? "active" : ""}`}
                onClick={() => setWorktree(false)}
                data-testid="ns-worktree-share"
              >
                <span className={`ns-radio ${worktree === false ? "on" : ""}`} />
                <span className="ns-worktree-text">
                  <span className="ns-worktree-title">{t("newSession.shareTitle")}</span>
                  <span className="ns-worktree-desc">
                    {t("newSession.shareDesc")}
                  </span>
                </span>
              </button>
              <button
                className={`ns-worktree ${worktree === true ? "active" : ""}`}
                onClick={() => setWorktree(true)}
                data-testid="ns-worktree-new"
              >
                <span className={`ns-radio ${worktree === true ? "on" : ""}`} />
                <span className="ns-worktree-text">
                  <span className="ns-worktree-title">{t("newSession.worktreeTitle")}</span>
                  <span className="ns-worktree-desc">
                    {t("newSession.worktreeDesc")}
                  </span>
                </span>
              </button>
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="modal-btn ghost" onClick={onCancel}>{t("common.cancel")}</button>
          <button
            className="modal-btn primary"
            disabled={!canConfirm}
            onClick={() => canConfirm && onConfirm(harness, worktree === true)}
            data-testid="ns-confirm"
          >
            {t("newSession.createBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}
