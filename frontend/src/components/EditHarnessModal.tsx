import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { ConformanceReport } from "../../bindings/github.com/jessonchan/monkey-deck/internal/acp/models";
import type { Harness } from "../../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";
import { Loader2, ShieldCheck } from "lucide-react";
import ProbeReport from "./ProbeReport";

interface Props {
  h: Harness; // 待编辑的用户 harness(仅 user-defined)。
  onDone: (list: Harness[]) => void;
  onCancel: () => void;
}

// 编辑 harness 弹窗:改显示名 + 启动命令(可选先「自检」验证)。id 不可改(session 钉它)。
// 保存不强制要求自检通过(改名这种轻量改动不必跑 90s probe),但提供「自检」按钮供改命令后验证。
export default function EditHarnessModal({ h, onDone, onCancel }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(h.name);
  const [command, setCommand] = useState(h.command);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<ConformanceReport | null>(null);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const cmd = command.trim();
  // 命令改了 → 旧体检单失效。
  const reportValid = !!report && report.command === cmd;
  const canSave = cmd !== "" && !saving && !probing;

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

  const save = async () => {
    setErr(null);
    setSaving(true);
    try {
      const list = await ChatService.UpdateUserHarness(h.id, name.trim(), cmd);
      onDone(list ?? []);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card add-harness-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{t("settings.harness.editTitle")}</div>
        <div className="ah-desc">{t("settings.harness.editDesc")}</div>

        <div className="ah-field">
          <label className="ah-label" htmlFor="eh-name">
            {t("settings.harness.addNameLabel")}
          </label>
          <input
            id="eh-name"
            className="modal-input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={h.id}
            data-testid="eh-name"
            disabled={probing || saving}
          />
        </div>

        <div className="ah-field">
          <label className="ah-label" htmlFor="eh-command">
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
            id="eh-command"
            className="modal-input"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder={t("settings.harness.addCmdPlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter") void probe();
            }}
            data-testid="eh-command"
            disabled={probing || saving}
          />
        </div>

        <div className="ah-probe-row">
          <button
            className="modal-btn ghost"
            data-testid="eh-probe"
            disabled={probing || saving || !cmd}
            onClick={() => void probe()}
          >
            {probing ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />}
            {probing ? t("settings.harness.addProbing") : t("settings.harness.addProbe")}
          </button>
        </div>

        {err && <div className="modal-del-err" data-testid="eh-err">{err}</div>}

        {reportValid && report && <ProbeReport report={report} />}

        <div className="modal-actions">
          <button
            className="modal-btn ghost"
            onClick={onCancel}
            data-testid="eh-cancel"
            disabled={saving || probing}
          >
            {t("common.cancel")}
          </button>
          <button
            className="modal-btn primary"
            disabled={!canSave}
            onClick={() => void save()}
            data-testid="eh-save"
          >
            {saving ? <Loader2 size={13} className="spin" /> : null}
            {t("settings.harness.editSave")}
          </button>
        </div>
      </div>
    </div>
  );
}
