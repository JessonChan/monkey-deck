import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { ConformanceReport } from "../../bindings/github.com/jessonchan/monkey-deck/internal/acp/models";
import type { Harness } from "../../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";
import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react";

interface Props {
  // 当前已存在的 harness 全量列表(静态 + 用户合并),用于前端先做 ID 冲突校验(i18n 即时提示)。
  existing: Harness[];
  // 添加成功:后端返回更新后的全量列表,交给 pane 刷新 + 关闭 modal。
  onDone: (list: Harness[]) => void;
  onCancel: () => void;
}

// 添加 harness 弹窗(声明即用 + 自检门槛):用户填 ID / Name / Command → 点「自检」跑
// ProbeHarness conformance 探针 → 展示体检单(ConformanceReport)→ CanAdd(Tier1 全过)才允许「添加」。
//
// 复用现有 modal 范式(modal-overlay/modal-card/modal-input/modal-del-err,§5.3)。自检流程参考
// 声明即用向导(体检单 + CanAdd 门控),但 shell 用当前三字段表单 UI(不换成多步向导)。
//
// CanAdd 是 Go 方法、不序列化过 binding,前端按 Tier1 四项自算(严格:init+session+stream+turn)。
// 命令改动后体检单失效(report.command !== 当前命令),需重新自检 —— 防止用过期报告蒙混门槛。
export default function AddHarnessModal({ existing, onDone, onCancel }: Props) {
  const { t } = useTranslation();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<ConformanceReport | null>(null);
  const [probing, setProbing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Esc 关闭(§4.2)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const cmd = command.trim();
  const idTaken = existing.some((h) => h.id === id.trim());
  const formValid = id.trim() !== "" && name.trim() !== "" && cmd !== "" && !idTaken;
  // 体检单有效性:存在且针对当前命令(命令改了 → 失效)。
  const reportValid = !!report && report.command === cmd;
  // CanAdd 严格门槛:Tier1 四项全过。
  const canAdd =
    reportValid &&
    !!report?.initialized?.pass &&
    !!report?.newSession?.pass &&
    !!report?.streamed?.pass &&
    !!report?.promptTurn?.pass;
  const canSubmit = formValid && canAdd && !submitting && !probing;

  const probe = async () => {
    setErr(null);
    if (!cmd) {
      setErr(t("settings.harness.addErrCmdEmpty"));
      return;
    }
    setReport(null);
    setProbing(true);
    try {
      const r = await ChatService.ProbeNewHarness(cmd);
      setReport(r);
      if (r?.error) setErr(r.error);
    } catch (e) {
      setErr(String(e));
    } finally {
      setProbing(false);
    }
  };

  const submit = async () => {
    if (!formValid) return;
    if (!canAdd) {
      setErr(t("settings.harness.addNeedProbe"));
      return;
    }
    setErr(null);
    setSubmitting(true);
    try {
      const list = await ChatService.AddHarness(id.trim(), name.trim(), cmd);
      onDone(list ?? []);
    } catch (e) {
      // 后端兜底校验失败(如:并发加同 ID / 命令非法)——直接显示后端错误串。
      setErr(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const gaps = canAdd
    ? [
        !report?.hasModelOption && t("settings.harness.addGapModel"),
        !report?.reportedUsage && t("settings.harness.addGapUsage"),
        !report?.streamedThoughts && t("settings.harness.addGapThought"),
      ].filter(Boolean)
    : [];

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card add-harness-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{t("settings.harness.addTitle")}</div>
        <div className="ah-desc">{t("settings.harness.addDesc")}</div>

        <div className="ah-field">
          <label className="ah-label" htmlFor="ah-id">
            {t("settings.harness.addIdLabel")}
            <span className="ah-required">*</span>
          </label>
          <input
            id="ah-id"
            className="modal-input"
            autoFocus
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder={t("settings.harness.addIdPlaceholder")}
            data-testid="ah-id"
            disabled={probing || submitting}
          />
        </div>

        <div className="ah-field">
          <label className="ah-label" htmlFor="ah-name">
            {t("settings.harness.addNameLabel")}
            <span className="ah-required">*</span>
          </label>
          <input
            id="ah-name"
            className="modal-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("settings.harness.addNamePlaceholder")}
            data-testid="ah-name"
            disabled={probing || submitting}
          />
        </div>

        <div className="ah-field">
          <label className="ah-label" htmlFor="ah-command">
            {t("settings.harness.addCmdLabel")}
            <span className="ah-required">*</span>
            <span
              className="ah-hint"
              data-tooltip-id="md-tip"
              data-tooltip-content={t("settings.harness.addCmdTip")}
            >
              {t("settings.harness.addCmdHint")}
            </span>
          </label>
          <input
            id="ah-command"
            className="modal-input"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder={t("settings.harness.addCmdPlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter") void probe();
            }}
            data-testid="ah-command"
            disabled={probing || submitting}
          />
        </div>

        <div className="ah-probe-row">
          <button
            className="modal-btn ghost"
            data-testid="ah-probe"
            disabled={probing || submitting || !cmd}
            onClick={() => void probe()}
          >
            {probing ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />}
            {probing ? t("settings.harness.addProbing") : t("settings.harness.addProbe")}
          </button>
        </div>

        {err && <div className="modal-del-err" data-testid="ah-err">{err}</div>}

        {reportValid && report && (
          <div className={`ah-report ${canAdd ? "ok" : "fail"}`} data-testid="ah-report">
            <div className="ah-verdict">
              {canAdd ? <ShieldCheck size={14} /> : <ShieldAlert size={14} />}
              {canAdd ? t("settings.harness.addVerdictOk") : t("settings.harness.addVerdictFail")}
              {report.agentName ? <span className="ah-agent">{report.agentName}</span> : null}
            </div>
            <div className="ah-tiers">
              <Tier label={t("settings.harness.addTierInit")} pass={!!report.initialized?.pass} />
              <Tier label={t("settings.harness.addTierSess")} pass={!!report.newSession?.pass} />
              <Tier label={t("settings.harness.addTierStream")} pass={!!report.streamed?.pass} />
              <Tier label={t("settings.harness.addTierTurn")} pass={!!report.promptTurn?.pass} />
            </div>
            <div className="ah-caps">
              {t("settings.harness.addCapResume")}:{report.resume ? "✓" : "✗"}　
              {t("settings.harness.addCapImage")}:{report.image ? "✓" : "✗"}　
              {t("settings.harness.addCapList")}:{report.list ? "✓" : "✗"}
            </div>
            {gaps.length > 0 && <div className="ah-warn">{t("settings.harness.addWarnPrefix")}{gaps.join("、")}</div>}
          </div>
        )}

        {formValid && !canAdd && !probing && (
          <div className="ah-need-probe">{t("settings.harness.addNeedProbe")}</div>
        )}

        <div className="modal-actions">
          <button
            className="modal-btn ghost"
            onClick={onCancel}
            data-testid="ah-cancel"
            disabled={submitting || probing}
          >
            {t("common.cancel")}
          </button>
          <button
            className="modal-btn primary"
            disabled={!canSubmit}
            onClick={() => void submit()}
            data-testid="ah-confirm"
          >
            {submitting ? <Loader2 size={13} className="spin" /> : null}
            {t("settings.harness.addConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Tier({ label, pass }: { label: string; pass: boolean }) {
  return (
    <span className={`ah-tier ${pass ? "pass" : "fail"}`}>
      {label} {pass ? "✓" : "✗"}
    </span>
  );
}
