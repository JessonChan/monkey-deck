// 统一前端设置 store(§设置中心):把分散在前端 localStorage 的轻量开关(语言 / 提示音)
// 收敛到单一 Context,各设置分类面板经 useFrontendSettings() 读写同一处。
//
// 持久化真相源保持不变:语言 → i18next(md:lang),提示音 → localStorage(md:notify-sound)。
// 此 store 提供响应式 UI 状态 + 统一 setter,避免每个组件各自维护本地镜像。
// 后端 SQLite 持久化的设置(权限规则 / harness)不在此处,由各 pane 直接经 ChatService 读写。
//
// 设计权衡(AGENTS.md §5.3 KISS / §3.1 不提前实现):不为语言/提示音新建 SQLite 配置表
// (那是阶段 2 的事);此处只做「UI 层统一入口 + 响应式状态」,不动后端存储。

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import i18n, { setLanguage as setI18nLanguage, type AppLanguage } from "../i18n";
import { isNotifySoundEnabled, setNotifySoundEnabled } from "./notifySound";

export interface FrontendSettings {
  language: AppLanguage;
  notifySound: boolean;
  setLanguage: (lang: AppLanguage) => void;
  setNotifySound: (on: boolean) => void;
}

const Ctx = createContext<FrontendSettings | null>(null);

export function FrontendSettingsProvider({ children }: { children: ReactNode }) {
  // 语言随 i18next 全局状态:监听 languageChanged 事件保持 store 同步
  // (setLanguage 调 i18n.changeLanguage 后,事件回灌保证 store 与 i18n 不分叉)。
  const [language, setLang] = useState<AppLanguage>((i18n.language === "en" ? "en" : "zh"));
  const [notifySound, setNotify] = useState<boolean>(isNotifySoundEnabled);

  useEffect(() => {
    const handler = (lng: string) => setLang(lng === "en" ? "en" : "zh");
    i18n.on("languageChanged", handler);
    return () => { i18n.off("languageChanged", handler); };
  }, []);

  const setLanguage = useCallback((lang: AppLanguage) => setI18nLanguage(lang), []);
  const setNotifySound = useCallback((on: boolean) => {
    setNotifySoundEnabled(on);
    setNotify(on);
  }, []);

  const value = useMemo<FrontendSettings>(
    () => ({ language, notifySound, setLanguage, setNotifySound }),
    [language, notifySound, setLanguage, setNotifySound],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFrontendSettings(): FrontendSettings {
  const v = useContext(Ctx);
  if (!v) throw new Error("useFrontendSettings must be used within FrontendSettingsProvider");
  return v;
}
