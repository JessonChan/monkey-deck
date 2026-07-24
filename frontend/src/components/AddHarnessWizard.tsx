import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import { ConformanceReport } from "../../bindings/github.com/jessonchan/monkey-deck/internal/acp/models";
import { Loader2, Plus, ShieldCheck, ShieldAlert } from "lucide-react";

// AddHarnessWizard:声明即用 harness 向导。
// 流程:用户输启动命令(+可选显示名)→ 自检(ProbeNewHarness,严格门槛 end_turn)→
// 展示体检单 → CanAdd 才允许"添加"(AddUserHarness 落库,前端立即可见)。
// 数据源纯 ACP 协议层;零 per-harness 硬编码(见 worklog 交叉验证)。
export default function AddHarnessWizard({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [cmd, setCmd] = useState("");
  const [name, setName] = useState("");
  const [probing, setProbing] = useState(false);
  const [report, setReport] = useState<ConformanceReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // CanAdd 是 Go 方法,不序列化过 binding;前端按 Tier1 字段自算(严格:init+sess+stream+turn)。
  const canAdd = !!(
    report?.initialized?.pass &&
    report?.newSession?.pass &&
    report?.streamed?.pass &&
    report?.promptTurn?.pass
  );

  const probe = async () => {
    setErr(null);
    setReport(null);
    if (!cmd.trim()) {
      setErr(t("settings.harness.addErrCmd"));
      return;
    }
    setProbing(true);
    try {
      const r = await ChatService.ProbeNewHarness(cmd.trim());
      setReport(r);
      if (r?.error) setErr(r.error);
    } catch (e) {
      setErr(String(e));
    } finally {
      setProbing(false);
    }
  };

  const confirm = async () => {
    setErr(null);
    setAdding(true);
    try {
      await ChatService.AddUserHarness(cmd.trim(), name.trim(), "");
      onDone();
    } catch (e) {
      setErr(String(e));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="harness-add-wizard" data-testid="harness-add-wizard">
      <div className="harness-add-title">{t("settings.harness.addTitle")}</div>

      <label className="harness-add-field">
        <span className="harness-add-label">{t("settings.harness.addCmdLabel")}</span>
        <input
          className="modal-input"
          data-testid="harness-add-cmd"
          placeholder={t("settings.harness.addCmdPh")}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          disabled={probing || adding}
          onKeyDown={(e) => {
            if (e.key === "Enter") void probe();
          }}
        />
      </label>

      <label className="harness-add-field">
        <span className="harness-add-label">{t("settings.harness.addNameLabel")}</span>
        <input
          className="modal-input"
          data-testid="harness-add-name"
          placeholder={report?.agentName ? `${t("settings.harness.addNamePh")}(${report.agentName})` : t("settings.harness.addNamePh")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={probing || adding}
        />
      </label>

      <div className="harness-add-actions">
        <button
          className="modal-btn ghost"
          data-testid="harness-add-probe"
          disabled={probing || adding || !cmd.trim()}
          onClick={() => void probe()}
        >
          {probing ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />}
          {probing ? t("settings.harness.addProbing") : t("settings.harness.addProbe")}
        </button>
        <button className="modal-btn ghost" onClick={onCancel} disabled={probing || adding}>
          {t("settings.harness.addCancel")}
        </button>
      </div>

      {err && <div className="modal-del-err">{err}</div>}

      {report && (
        <div className={`harness-add-report ${canAdd ? "ok" : "fail"}`} data-testid="harness-add-report">
          <div className="harness-add-verdict">
            {canAdd ? <ShieldCheck size={14} /> : <ShieldAlert size={14} />}
            {canAdd ? t("settings.harness.addVerdictOk") : t("settings.harness.addVerdictFail")}
          </div>
          <div className="harness-add-tiers">
            <Tier label={t("settings.harness.addTierInit")} pass={!!report.initialized?.pass} />
            <Tier label={t("settings.harness.addTierSess")} pass={!!report.newSession?.pass} />
            <Tier label={t("settings.harness.addTierStream")} pass={!!report.streamed?.pass} />
            <Tier label={t("settings.harness.addTierTurn")} pass={!!report.promptTurn?.pass} />
          </div>
          <div className="harness-add-meta">
            {t("settings.harness.addCapResume")}: {report.resume ? "✓" : "✗"}　
            {t("settings.harness.addCapImage")}: {report.image ? "✓" : "✗"}
          </div>
          <div className="harness-add-meta">
            {report.emitsMessageId ? t("settings.harness.addMsgIdYes") : t("settings.harness.addMsgIdNo")}
          </div>
          {canAdd && (
            <button
              className="modal-btn primary"
              data-testid="harness-add-confirm"
              disabled={adding}
              onClick={() => void confirm()}
            >
              {adding ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
              {adding ? t("settings.harness.addAdding") : t("settings.harness.addConfirm")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Tier({ label, pass }: { label: string; pass: boolean }) {
  return (
    <span className={`harness-add-tier ${pass ? "pass" : "fail"}`}>
      {label} {pass ? "✓" : "✗"}
    </span>
  );
}
