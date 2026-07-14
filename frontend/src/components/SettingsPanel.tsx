import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Settings, Globe, Palette, SlidersHorizontal, ShieldCheck, Boxes, Bell, MessageSquare } from "lucide-react";
import type { AppLanguage } from "../i18n";
import { useFrontendSettings } from "../lib/settingsStore";
import PermissionRulesPane from "./PermissionSettings";
import HarnessPane from "./HarnessSettings";

// 统一设置中心面板:齿轮入口 → 左侧分类导航 + 右侧表单。
// 把此前散落在侧栏头部的设置项(语言 / 提示音 / 权限规则 / harness)收敛到单一入口,
// 各分类读写同一处(前端轻量开关经 useFrontendSettings;SQLite 持久化的由各 pane 直连 ChatService)。
// 结构可扩展:新增设置只需在 CATEGORIES 加一项 + 渲染对应 pane(§设置中心)。

type CategoryId = "general" | "appearance" | "language" | "conversation" | "permissions" | "models" | "sound";

interface CategoryDef {
  id: CategoryId;
  labelKey: string;
  icon: typeof Settings;
}

const CATEGORIES: CategoryDef[] = [
  { id: "general", labelKey: "settings.center.cat.general", icon: SlidersHorizontal },
  { id: "appearance", labelKey: "settings.center.cat.appearance", icon: Palette },
  { id: "language", labelKey: "settings.center.cat.language", icon: Globe },
  { id: "conversation", labelKey: "settings.center.cat.conversation", icon: MessageSquare },
  { id: "permissions", labelKey: "settings.center.cat.permissions", icon: ShieldCheck },
  { id: "models", labelKey: "settings.center.cat.models", icon: Boxes },
  { id: "sound", labelKey: "settings.center.cat.sound", icon: Bell },
];

interface Props {
  onClose: () => void;
  initialCategory?: CategoryId;
}

export default function SettingsPanel({ onClose, initialCategory = "general" }: Props) {
  const { t } = useTranslation();
  const [active, setActive] = useState<CategoryId>(initialCategory);

  // Esc 关闭(§4.2)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose} data-testid="settings-overlay">
      <div className="settings-card" onClick={(e) => e.stopPropagation()} data-testid="settings-card">
        <div className="settings-head">
          <div className="settings-title">
            <Settings size={16} />
            <span>{t("settings.center.title")}</span>
          </div>
          <button
            className="icon-btn"
            data-testid="settings-close"
            data-tooltip-id="md-tip"
            data-tooltip-content={t("common.closeEsc")}
            data-tooltip-place="left"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
        <div className="settings-body">
          <nav className="settings-nav" data-testid="settings-nav">
            {CATEGORIES.map((c) => {
              const Icon = c.icon;
              return (
                <button
                  key={c.id}
                  className={`settings-nav-item ${active === c.id ? "active" : ""}`}
                  data-testid={`settings-cat-${c.id}`}
                  onClick={() => setActive(c.id)}
                >
                  <Icon size={14} />
                  <span>{t(c.labelKey)}</span>
                </button>
              );
            })}
          </nav>
          <div className="settings-content">
            {/* 懒挂载:仅渲染当前分类的 pane,避免一次性拉取所有分类数据。 */}
            {active === "general" && <GeneralPane />}
            {active === "appearance" && <EmptyPane hintKey="settings.center.empty.appearance" />}
            {active === "language" && <LanguagePane />}
            {active === "conversation" && <EmptyPane hintKey="settings.center.empty.conversation" />}
            {active === "permissions" && <PermissionRulesPane />}
            {active === "models" && <HarnessPane />}
            {active === "sound" && <SoundPane />}
          </div>
        </div>
      </div>
    </div>
  );
}

function GeneralPane() {
  const { t } = useTranslation();
  return (
    <div className="settings-pane" data-testid="general-pane">
      <div className="pane-desc">{t("settings.center.general.desc")}</div>
      <div className="settings-row">
        <div className="settings-row-text">
          <div className="settings-row-title">{t("settings.center.general.version")}</div>
          <div className="settings-row-sub">{t("settings.center.general.versionDesc")}</div>
        </div>
        <code className="settings-version">dev</code>
      </div>
    </div>
  );
}

function LanguagePane() {
  const { t } = useTranslation();
  const { language, setLanguage } = useFrontendSettings();
  const langs: AppLanguage[] = ["zh", "en"];
  return (
    <div className="settings-pane" data-testid="language-pane">
      <div className="pane-desc">{t("settings.center.language.desc")}</div>
      <div className="settings-opt-list">
        {langs.map((lng) => (
          <button
            key={lng}
            className={`settings-opt ${language === lng ? "active" : ""}`}
            data-testid={`settings-lang-${lng}`}
            onClick={() => setLanguage(lng)}
          >
            <span className={`settings-radio ${language === lng ? "on" : ""}`} />
            <span className="settings-opt-name">{lng === "zh" ? t("settings.languageZh") : t("settings.languageEn")}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SoundPane() {
  const { t } = useTranslation();
  const { notifySound, setNotifySound } = useFrontendSettings();
  return (
    <div className="settings-pane" data-testid="sound-pane">
      <div className="pane-desc">{t("settings.center.sound.desc")}</div>
      <div className="settings-row">
        <div className="settings-row-text">
          <div className="settings-row-title">{t("settings.center.sound.notifyTitle")}</div>
          <div className="settings-row-sub">{t("settings.center.sound.notifyDesc")}</div>
        </div>
        <button
          className={`settings-switch ${notifySound ? "on" : ""}`}
          role="switch"
          aria-checked={notifySound}
          data-testid="settings-notify-sound"
          onClick={() => setNotifySound(!notifySound)}
        >
          <span className="settings-switch-thumb" />
        </button>
      </div>
    </div>
  );
}

function EmptyPane({ hintKey }: { hintKey: string }) {
  const { t } = useTranslation();
  return (
    <div className="settings-pane" data-testid="empty-pane">
      <div className="settings-empty">{t(hintKey)}</div>
    </div>
  );
}
