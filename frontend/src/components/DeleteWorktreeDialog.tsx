import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { Session } from "../../bindings/github.com/jessonchan/monkey-deck/internal/store/models";

interface Props {
  guests: Session[];
  onConfirm: (mode: "all" | "keep") => void;
  onCancel: () => void;
}

// 3-option dialog shown when deleting an OWNER session whose worktree still has guest chats.
// Removing the worktree affects them, so the user picks:
//   cancel — abort;
//   keep   — detach guests (keep their history, fall back to project dir) + delete worktree + owner;
//   all    — delete worktree + owner + every guest.
// "Delete worktree" is treated as an independent, atomic concept (§ owner/guest model).
export default function DeleteWorktreeDialog({ guests, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card delete-wt-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{t("deleteWt.title")}</div>
        <p className="delete-wt-body">{t("deleteWt.body", { count: guests.length })}</p>
        {guests.length > 0 && (
          <ul className="delete-wt-guests" data-testid="delete-wt-guests">
            {guests.map((g) => (
              <li key={g.id}>{g.title || g.id.slice(0, 8)}</li>
            ))}
          </ul>
        )}
        <div className="modal-actions delete-wt-actions">
          <button className="modal-btn ghost" onClick={onCancel} data-testid="delete-wt-cancel">{t("deleteWt.cancel")}</button>
          <button className="modal-btn ghost" onClick={() => onConfirm("keep")} data-testid="delete-wt-keep">{t("deleteWt.keep")}</button>
          <button className="modal-btn danger" onClick={() => onConfirm("all")} data-testid="delete-wt-all">{t("deleteWt.all")}</button>
        </div>
      </div>
    </div>
  );
}
