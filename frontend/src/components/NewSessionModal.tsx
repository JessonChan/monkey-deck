import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Harness } from "../../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";
import type { CapabilityMatrix } from "../../bindings/github.com/jessonchan/monkey-deck/internal/acp/models";
import HarnessIcon from "./HarnessIcon";

interface Props {
  harnesses: Harness[];
  // harness 能力矩阵(可选):来自 App 启动拉取 + chat:harness-capabilities 订阅(App.tsx)。
  // 用于在选择项右侧显示精简能力摘要(model + usage)。未就绪(harnessId 不在 map / ProbeErr)
  // 不显示摘要,不阻塞选择(KISS:少一次重复拉,App 已直接渲染本组件,prop 已通)。
  harnessCapabilities?: Record<string, CapabilityMatrix | undefined>;
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
export default function NewSessionModal({ harnesses, harnessCapabilities, isGit, lastHarness, onConfirm, onCancel }: Props) {
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
            {harnesses.map((h) => {
              const cap = harnessCapabilities?.[h.id];
              return (
                <button
                  key={h.id}
                  className={`ns-harness ${harness === h.id ? "active" : ""}`}
                  onClick={() => setHarness(h.id)}
                  data-testid={`ns-harness-${h.id}`}
                >
                  <span className={`ns-radio ${harness === h.id ? "on" : ""}`} />
                  <HarnessIcon harnessId={h.id} size={16} className="ns-harness-icon" />
                  <span className="ns-harness-name">{h.name}</span>
                  <NsCapabilitySummary cap={cap} harnessId={h.id} />
                  <span className="ns-harness-cmd" data-tooltip-id="md-tip" data-tooltip-content={h.command}>{h.command}</span>
                </button>
              );
            })}
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

// 精简能力摘要(放在 harness 名右侧、命令左侧):只显示 model + usage 两项(issue 核心诉求
// 「有的没模型选择,有的没 token 用量」),完整矩阵在 HarnessSettings 看。
//
// 取舍(coder 判断,§5.3):
//   - 未就绪(cap undefined)/ ProbeErr 非空 → 不显示摘要(不阻塞选择,弹窗本就轻量)。
//   - model(configModel):declared 位,true=✓ false=✗。
//   - usage(emitsUsage):observed 位,withProbe=false 默认 undefined → 显示中性「·」(不误判 ✗)。
function NsCapabilitySummary({ cap, harnessId }: { cap: CapabilityMatrix | undefined; harnessId: string }) {
  const { t } = useTranslation();
  if (!cap || cap.probeErr) return null;

  const bits: { key: string; raw: boolean | undefined }[] = [
    { key: "model", raw: cap.configModel },
    { key: "usage", raw: cap.emitsUsage },
  ];

  return (
    <span className="ns-cap-summary" data-testid={`ns-cap-summary-${harnessId}`}>
      {bits.map((b) => {
        const state: "yes" | "no" | "unknown" =
          b.raw === true ? "yes" : b.raw === false ? "no" : "unknown";
        const tipState =
          state === "yes"
            ? t("capability.supported")
            : state === "no"
              ? t("capability.notSupported")
              : t("capability.notObserved");
        return (
          <span
            key={b.key}
            className={`ns-cap-bit ${state}`}
            data-tooltip-id="md-tip"
            data-tooltip-content={`${t(`capability.${b.key}`)}: ${tipState}\n${t(`capability.${b.key}Tip`)}`}
            data-testid={`ns-cap-${harnessId}-${b.key}`}
          >
            {state === "yes" ? "✓" : state === "no" ? "✗" : "·"} {t(`capability.${b.key}`)}
          </span>
        );
      })}
    </span>
  );
}
