import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";

// Global "copy icon button": click → write `text` to clipboard → show Check icon +
// "copied" tooltip for 1.2s, then revert. Each instance owns its copied state, so
// several buttons on screen never share feedback (the old ChatView bars shared one
// `errorCopied` flag, so clicking one lit up both).
// §4.5: tooltip via react-tooltip (md-tip); native title is banned.
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
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try {
      navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* noop */ }
  };
  return (
    <button
      type="button"
      className={className}
      onClick={copy}
      data-tooltip-id="md-tip"
      data-tooltip-content={copied ? t("common.copied") : t("common.copy")}
      {...(testId ? { "data-testid": testId } : {})}
    >
      {copied ? <Check size={size} /> : <Copy size={size} />}
    </button>
  );
}
