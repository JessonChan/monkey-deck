// i18n 初始化(react-i18next)。zh 为默认(对齐现状中文 UI),en 为补充。
// 语言持久化到 localStorage(md:lang),启动时读回;切换经 setLanguage 在入口处调用。
// AGENTS.md §5.3 成熟库优先:react-i18next 是 React 生态事实标准,轻量、可 tree-shake。
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zh from "./locales/zh.json";
import en from "./locales/en.json";

export type AppLanguage = "zh" | "en";

export const LANGUAGES: AppLanguage[] = ["zh", "en"];

const STORAGE_KEY = "md:lang";

// 检测初始语言:localStorage > 浏览器/locale 兜底(默认 zh,对齐现状)。
function detectInitialLanguage(): AppLanguage {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch { /* SSR / 受限环境 */ }
  // navigator.language 兜底:en* → en,其余 → zh(默认中文,对齐项目当前 UI)。
  if (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("en")) return "en";
  return "zh";
}

export const initialLanguage = detectInitialLanguage();

void i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: initialLanguage,
  fallbackLng: "zh",
  interpolation: {
    // React 已默认转义,关闭 i18next 自身的转义避免双重处理。
    escapeValue: false,
  },
  returnNull: false,
});

// 持久化 + 通知(切换语言时调用)。
export function setLanguage(lang: AppLanguage): void {
  void i18n.changeLanguage(lang);
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* noop */ }
}

export default i18n;
