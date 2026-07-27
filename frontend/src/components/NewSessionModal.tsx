import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Harness } from "../../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";
import HarnessIcon from "./HarnessIcon";

interface Props {
  harnesses: Harness[];
  isGit: boolean;
  lastHarness: string;
  onConfirm: (harness: string, useWorktree: boolean) => void;
  onCancel: () => void;
}

// 新建对话弹窗:让用户选择 1) 使用的 agent harness(omp/opencode)2) 是否新建独立分支(worktree)。
// harness 决定 spawn 哪个 ACP agent;worktree 决定是否为该会话建独立 git 工作树(并行隔离,§1.4)。
// harness 与 worktree 都要求显式选择(null = 未选):没选过(lastHarness 空/失效/列表多 harness)不设默认,
// 未选时「新建」按钮禁用 + label 旁显示 ns-required 提示。单 harness 无歧义,自动选中免纯摩擦。
// 非 git 项目不展示 worktree 选项(无法建分支)。
export default function NewSessionModal({ harnesses, isGit, lastHarness, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  // harness 必须显式选择:null = 未选。lastHarness 仍可选时默认选它;单 harness 无歧义自动选;否则 null。
  const [harness, setHarness] = useState<string | null>(() => {
    if (lastHarness && harnesses.some((h) => h.id === lastHarness)) return lastHarness;
    if (harnesses.length === 1) return harnesses[0].id;
    return null;
  });
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

  // harness 必须已选 + (非 git 或 worktree 已显式选),否则禁用「新建」。
  const canConfirm = harness !== null && (!isGit || worktree !== null);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card new-session-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{t("newSession.title")}</div>

        <div className="ns-field">
          <div className="ns-label">
            {t("newSession.selectAgent")}
            {harness === null && <span className="ns-required">{t("newSession.required")}</span>}
          </div>
          <div className="ns-harness-list">
            {harnesses.map((h) => (
              <button
                key={h.id}
                className={`ns-harness ${harness === h.id ? "active" : ""}`}
                onClick={() => setHarness(h.id)}
                data-testid={`ns-harness-${h.id}`}
              >
                <span className={`ns-radio ${harness === h.id ? "on" : ""}`} />
                <HarnessIcon harnessId={h.id} size={16} className="ns-harness-icon" />
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
            onClick={() => harness !== null && onConfirm(harness, worktree === true)}
            data-testid="ns-confirm"
          >
            {t("newSession.createBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}
