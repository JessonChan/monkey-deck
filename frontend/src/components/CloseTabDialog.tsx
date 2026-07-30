import { useEffect } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  title: string;
  onConfirm: (mode: "stop" | "detach") => void;
  onCancel: () => void;
}

// Confirmation shown when the user closes a tab that is still generating (status "prompting").
// Closing such a tab is ambiguous — the in-flight turn is still running on the backend — so we
// offer two distinct choices instead of silently evicting:
//   cancel  — abort, keep the tab open and the turn running;
//   stop    — StopSession (cancel the turn) then evict the tab;
//   detach  — evict the tab only; the turn keeps running in the background and its streamed
//             output still lands in SQLite (visible again when the session is reopened).
// Idle / error / closed sessions bypass this dialog and close directly.
// Reuses the generic .modal-overlay / .modal-card styles (same as DeleteWorktreeDialog).
export default function CloseTabDialog({ title, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card close-tab-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{t("closeTab.title")}</div>
        <p className="delete-wt-body">{t("closeTab.body", { title })}</p>
        <div className="modal-actions delete-wt-actions">
          <button className="modal-btn ghost" onClick={onCancel} data-testid="close-tab-cancel">{t("closeTab.cancel")}</button>
          <button className="modal-btn ghost" onClick={() => onConfirm("detach")} data-testid="close-tab-detach">{t("closeTab.detach")}</button>
          <button className="modal-btn danger" onClick={() => onConfirm("stop")} data-testid="close-tab-stop">{t("closeTab.stop")}</button>
        </div>
      </div>
    </div>
  );
}
