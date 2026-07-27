import { useTranslation } from "react-i18next";
import type { ConformanceReport } from "../../bindings/github.com/jessonchan/monkey-deck/internal/acp/models";
import { ShieldCheck, ShieldAlert } from "lucide-react";

// ProbeReport:ConformanceReport(ACP 自检体检单)的共享渲染。
// AddHarnessModal(添加弹窗)/ HarnessRow(行内复检)/ EditHarnessModal(编辑)三处复用。
//
// CanAdd 是 Go 方法、不序列化过 binding,这里按 Tier1 四项自算(严格:init+session+stream+turn)。
// 调用方负责保证传入的 report 已是针对当前命令的有效结果(命令改动应由调用方判定失效)。
export function canAddFromReport(r: ConformanceReport | null): boolean {
  return (
    !!r &&
    !!r.initialized?.pass &&
    !!r.newSession?.pass &&
    !!r.streamed?.pass &&
    !!r.promptTurn?.pass
  );
}

export default function ProbeReport({ report }: { report: ConformanceReport }) {
  const { t } = useTranslation();
  const canAdd = canAddFromReport(report);
  const gaps = canAdd
    ? [
        !report.hasModelOption && t("settings.harness.addGapModel"),
        !report.reportedUsage && t("settings.harness.addGapUsage"),
        !report.streamedThoughts && t("settings.harness.addGapThought"),
      ].filter(Boolean)
    : [];

  return (
    <div className={`ah-report ${canAdd ? "ok" : "fail"}`} data-testid="probe-report">
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
      {gaps.length > 0 && (
        <div className="ah-warn">{t("settings.harness.addWarnPrefix")}{gaps.join("、")}</div>
      )}
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
