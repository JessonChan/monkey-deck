import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { Harness } from "../../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";

interface Props {
  // 当前已存在的 harness 全量列表(静态 + 用户合并),用于前端先做 ID 冲突校验(i18n 即时提示)。
  existing: Harness[];
  // 添加成功:后端返回更新后的全量列表,交给 pane 刷新 + 关闭 modal。
  onDone: (list: Harness[]) => void;
  onCancel: () => void;
}

// 添加 harness 弹窗:用户填写 ID / Name / Command(必填)。
//
// 复用现有 modal 范式(modal-overlay/modal-card/modal-input/modal-del-err,§5.3),形态参考
// FilePanel 的「文本输入 modal」(autoFocus + Enter 提交 + Esc 关闭)。
//
// 关闭时机取舍(coder 判断,issue 倾向「modal 内显示能力清单」):
//   - 选「提交成功即关」:probe 能力矩阵最多 30s,让 modal 一直开着等 probe 不友好;
//     且 HarnessPane 已订阅 chat:harness-capabilities 自动刷新 caps,新 harness 行的能力 chip
//     会在 probe 完成后自动填进列表里——与启动时「harness 列表先到、能力矩阵随后填」一致。
//   - 校验:前端先做非空 + ID 冲突(disable 提交 + 即时 i18n 报错);后端再兜底校验
//     (AddHarness 返 ErrUser* 错误串显示在 modal-del-err,极端情况兜底)。
export default function AddHarnessModal({ existing, onDone, onCancel }: Props) {
  const { t } = useTranslation();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Esc 关闭(§4.2)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const idTaken = existing.some((h) => h.id === id.trim());
  const canSubmit =
    id.trim() !== "" &&
    name.trim() !== "" &&
    command.trim() !== "" &&
    !idTaken &&
    !submitting;

  const submit = async () => {
    // 前端基础校验(i18n 即时反馈;后端兜底,见 AddHarness 返错)。
    if (id.trim() === "") {
      setErr(t("settings.harness.addErrIdEmpty"));
      return;
    }
    if (idTaken) {
      setErr(t("settings.harness.addErrIdConflict"));
      return;
    }
    if (name.trim() === "") {
      setErr(t("settings.harness.addErrNameEmpty"));
      return;
    }
    if (command.trim() === "") {
      setErr(t("settings.harness.addErrCmdEmpty"));
      return;
    }
    setErr(null);
    setSubmitting(true);
    try {
      const list = await ChatService.AddHarness(id.trim(), name.trim(), command.trim());
      onDone(list ?? []);
    } catch (e) {
      // 后端兜底校验失败(如:并发加同 ID / 命令非法)——直接显示后端错误串。
      setErr(String(e));
    } finally {
      setSubmitting(false);
    }
  };

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
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            data-testid="ah-id"
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
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            data-testid="ah-name"
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
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            data-testid="ah-command"
          />
        </div>

        {err && <div className="modal-del-err" data-testid="ah-err">{err}</div>}

        <div className="modal-actions">
          <button className="modal-btn ghost" onClick={onCancel} data-testid="ah-cancel">
            {t("common.cancel")}
          </button>
          <button
            className="modal-btn primary"
            disabled={!canSubmit}
            onClick={() => void submit()}
            data-testid="ah-confirm"
          >
            {t("settings.harness.addConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
