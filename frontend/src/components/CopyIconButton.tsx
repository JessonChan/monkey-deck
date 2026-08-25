import { useTranslation } from "react-i18next";
import { Check, Copy, X } from "lucide-react";
import { useCopyFeedback } from "../hooks/useCopyFeedback";

// Global "copy icon button": click → write `text` to clipboard → show Check icon +
// "copied" tooltip for 1.2s, then revert. Each instance owns its copied state, so
// several buttons on screen never share feedback (the old ChatView bars shared one
// `errorCopied` flag, so clicking one lit up both). Failure feedback (issue #129):
// when no clipboard channel succeeds, show an X icon + "copy failed" tooltip
// instead of a false "copied" (§4.5: tooltip via react-tooltip, md-tip).
export default function CopyIconButton({
  text,
  className = "copy-icon-btn",
  size = 12,
  testId,
}: {
  text: string;
  className?: string;
  size?: number;
  testId?: string;
}) {
  const { t } = useTranslation();
  const { copied, failed, copy } = useCopyFeedback(1200);
  return (
    <button
      type="button"
      className={className}
      onClick={() => void copy(text)}
      data-tooltip-id="md-tip"
      data-tooltip-content={copied ? t("common.copied") : failed ? t("common.copyFailed") : t("common.copy")}
      data-copy-failed={failed ? "true" : undefined}
      {...(testId ? { "data-testid": testId } : {})}
    >
      {copied ? <Check size={size} /> : failed ? <X size={size} /> : <Copy size={size} />}
    </button>
  );
}
