import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, X } from "lucide-react";
import { canInstall, isStandalone, onInstallAvailable, promptInstall } from "../lib/installPrompt";

const DISMISSED_KEY = "md.pwa-install-dismissed";

// Mobile-only install banner (M2 PWA): after first load in a phone browser,
// offer install until installed or dismissed (localStorage). With a captured
// beforeinstallprompt it's one tap; without one (iOS Safari never fires it)
// it shows the manual "Share → Add to Home Screen" hint. Hidden on desktop
// entirely via CSS (.install-banner defaults to display:none — M2 hard rule:
// >768px render unchanged). Never rendered in popout windows.
export default function InstallBanner() {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === "1");
  const [available, setAvailable] = useState(canInstall());
  useEffect(() => onInstallAvailable(() => setAvailable(true)), []);
  if (dismissed || isStandalone()) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, "1");
    setDismissed(true);
  };
  const install = async () => {
    const outcome = await promptInstall();
    if (outcome === "accepted") dismiss();
    else setAvailable(false); // user dismissed the native sheet → stop offering
  };

  return (
    <div className="install-banner" data-testid="install-banner">
      <span className="install-banner-text">
        {available ? t("pwa.bannerText") : t("pwa.iosHint")}
      </span>
      <span className="install-banner-actions">
        {available && (
          <button
            type="button"
            className="install-banner-btn"
            data-testid="install-banner-install"
            onClick={install}
          >
            <Download size={13} /> {t("pwa.install")}
          </button>
        )}
        <button
          type="button"
          className="install-banner-close"
          data-testid="install-banner-dismiss"
          onClick={dismiss}
          aria-label={t("pwa.notNow")}
          data-tooltip-id="md-tip"
          data-tooltip-content={t("pwa.notNow")}
        >
          <X size={13} />
        </button>
      </span>
    </div>
  );
}
