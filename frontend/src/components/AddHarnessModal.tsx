import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { ConformanceReport } from "../../bindings/github.com/jessonchan/monkey-deck/internal/acp/models";
import type { Harness } from "../../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";
import type { KnownHarness } from "../../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";
import { Loader2, ShieldCheck, X } from "lucide-react";
import HarnessIcon from "./HarnessIcon";
import ProbeReport, { canAddFromReport } from "./ProbeReport";

interface Props {
  // 添加成功:后端返回更新后的全量列表,交给 pane 刷新 + 关闭 modal。
  onDone: (list: Harness[]) => void;
  onCancel: () => void;
}

// 添加 harness 弹窗(声明即用 + 自检门槛):用户填启动命令(+ 可选显示名)→ 点「自检」跑
// ProbeHarness conformance 探针 → 展示体检单 → CanAdd(Tier1 全过)才允许「添加」。
//
// ID 不由用户填:后端从命令首段 basename 自动派生(用户根本不需要关心内部主键,§4.4)。
// Name 可选(空则后端兜底成派生 ID)。复用现有 modal 范式 + ProbeReport 共享体检单组件。
//
// 命令改动后体检单失效(report.command !== 当前命令),需重新自检 —— 防止用过期报告蒙混门槛。
export default function AddHarnessModal({ onDone, onCancel }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<ConformanceReport | null>(null);
  const [probing, setProbing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // 命令实时匹配已知 harness 目录的结果;命中后据其 ID 展示图标并预填 Name。
  const [matched, setMatched] = useState<KnownHarness | null>(null);
  // 用户是否手动改过 Name:改过则不再自动覆盖(§4.4 不替用户做主)。
  const nameTouched = useRef(false);

  // Esc 关闭(§4.2)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // 命令 → 实时匹配已知 harness 目录(后端 MatchKnownHarness):命中即自动选该 harness。
  useEffect(() => {
    const c = command.trim();
    if (!c) {
      setMatched(null);
      if (!nameTouched.current) setName("");
      return;
    }
    let cancelled = false;
    ChatService.MatchKnownHarness(c)
      .then((r) => { if (!cancelled) setMatched(r ?? null); })
      .catch(() => { if (!cancelled) setMatched(null); });
    return () => { cancelled = true; };
  }, [command]);

  // 命中已知 harness 且用户未手填名称时,自动填 Name(用户可改)。
  useEffect(() => {
    if (!nameTouched.current) setName(matched?.name ?? "");
  }, [matched]);

  const cmd = command.trim();
  // 体检单有效性:存在且针对当前命令(命令改了 → 失效)。
  const reportValid = !!report && report.command === cmd;
  const canAdd = reportValid && canAddFromReport(report);
  const canSubmit = cmd !== "" && canAdd && !submitting && !probing;

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
    if (!canAdd) {
      setErr(t("settings.harness.addNeedProbe"));
      return;
    }
    setErr(null);
    setSubmitting(true);
    try {
      const list = await ChatService.AddHarness(cmd, name.trim());
      onDone(list ?? []);
    } catch (e) {
      // 后端兜底校验失败(如:派生 id 撞内置 / 已有)——直接显示后端错误串。
      setErr(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
      <div className="modal-overlay">
        <div className="modal-card add-harness-card">
          <button
            className="modal-close"
            onClick={onCancel}
            data-tooltip-id="md-tip"
            data-tooltip-content={t("common.close")}
            aria-label={t("common.close")}
          >
            <X size={15} />
          </button>
          <div className="modal-title">{t("settings.harness.addTitle")}</div>
        <div className="ah-desc">{t("settings.harness.addDesc")}</div>

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
            autoFocus
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder={t("settings.harness.addCmdPlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter") void probe();
            }}
            data-testid="ah-command"
            disabled={probing || submitting}
          />
          {matched && (
            <div
              className="ah-matched"
              data-testid="ah-matched"
              style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 12, color: "var(--text-dim, #8a8a8a)" }}
            >
              <HarnessIcon harnessId={matched.id} size={16} />
              <span>{t("settings.harness.addMatched", { name: matched.name })}</span>
            </div>
          )}
        </div>

        <div className="ah-field">
          <label className="ah-label" htmlFor="ah-name">
            {t("settings.harness.addNameLabel")}
          </label>
          <input
            id="ah-name"
            className="modal-input"
            value={name}
            onChange={(e) => { nameTouched.current = true; setName(e.target.value); }}
            placeholder={t("settings.harness.addNamePlaceholder")}
            data-testid="ah-name"
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

        {reportValid && report && <ProbeReport report={report} />}

        {cmd !== "" && !canAdd && !probing && (
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
