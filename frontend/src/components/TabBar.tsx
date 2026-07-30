// TabBar: horizontal strip of "currently open" sessions in the main window, mirroring browser /
// VS Code tab semantics. Click = switch to that session; middle-click or × = close the tab
// (evict its in-memory cache, NOT delete the session); right-click = context menu (move to a
// standalone popout window). Pure presentation + callbacks — all state lives in App.
//
// Visual reference: the project's own .terminal-tab* CSS (TerminalPanel) is the closest existing
// "tab + close button" pattern. We reuse the same .session-dot + status classes as the sidebar
// (Sidebar.tsx ~L342) for the status indicator, so colors stay consistent with the rest of the app.
//
// Wails3 drag region: this strip sits in the title-bar drag region (the area above <main>), so the
// container is `--wails-draggable: drag` (lets the user drag the window by empty tab-bar space) but
// every interactive control (tab, close button) is `--wails-draggable: no-drag` or clicks get
// swallowed by the drag handler. This mirrors the chat-header / sidebar-header convention.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, ExternalLink, Folder } from "lucide-react";

export interface TabBarTab {
  id: string;
  title: string;       // resolved display title (falls back to id upstream)
  projectName: string; // for the hover tooltip (cross-project disambiguation)
  status: string | undefined;      // statusBySession value (started|prompting|idle|error|...)
  activity: "thinking" | "executing" | "replying" | undefined;
  unread: boolean;                  // true when a turn finished while this tab was not the active one
}

interface ContextMenu {
  x: number;
  y: number;
  sessionId: string;
}

export interface TabBarProps {
  tabs: TabBarTab[];
  activeId: string | null;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onPopout: (sessionId: string) => void;
}

export default function TabBar(props: TabBarProps) {
  const { t } = useTranslation();
  const { tabs, activeId } = props;
  const [menu, setMenu] = useState<ContextMenu | null>(null);

  // Close the context menu on outside click / Esc (§4.2 — popups must close on Esc).
  useEffect(() => {
    if (!menu) return;
    const onDown = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [menu]);

  return (
    <div className="tabbar" data-testid="tabbar">
      <div className="tabbar-scroll">
        {tabs.map((tab) => {
          // Status dot class — identical logic to Sidebar.tsx so the indicator color matches
          // the sidebar's session row (error / activity / running / idle).
          const active = tab.status === "prompting";
          const cls = tab.status === "error" ? "error" : active ? tab.activity ?? "running" : "";
          const dotTip = tab.status === "error" ? t("sidebar.status.error")
            : active ? ({ thinking: t("sidebar.status.thinking"), executing: t("sidebar.status.executing"), replying: t("sidebar.status.replying") } as Record<string, string>)[tab.activity ?? ""] ?? t("tabbar.generating")
            : t("sidebar.status.idle");
          return (
            <div
              key={tab.id}
              className={`tabbar-tab ${tab.id === activeId ? "active" : ""}`}
              data-testid={`tab-${tab.id}`}
              onClick={() => props.onSelect(tab.id)}
              // Middle-click closes the tab (browser / VS Code convention).
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); props.onClose(tab.id); } }}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, sessionId: tab.id }); }}
            >
              <span
                className={`session-dot ${cls}`}
                data-tooltip-id="md-tip"
                data-tooltip-content={dotTip}
              />
              <span
                className="tabbar-tab-title"
                data-tooltip-id="md-tip"
                data-tooltip-content={t("tabbar.sessionTooltip", { title: tab.title, project: tab.projectName })}
              >
                {tab.title}
              </span>
              {tab.unread && tab.id !== activeId && (
                <span
                  className="unread-dot"
                  data-tooltip-id="md-tip"
                  data-tooltip-content={t("sidebar.unreadTip")}
                  data-testid={`tab-unread-${tab.id}`}
                />
              )}
              <button
                className="tabbar-tab-close"
                data-testid={`tab-close-${tab.id}`}
                onClick={(e) => { e.stopPropagation(); props.onClose(tab.id); }}
                data-tooltip-id="md-tip"
                data-tooltip-content={t("tabbar.closeTabTip", { title: tab.title })}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>

      {menu && (
        <div
          className="ctx-menu tabbar-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="ctx-item"
            disabled={menu.sessionId === activeId}
            onClick={() => { if (menu.sessionId !== activeId) props.onSelect(menu.sessionId); setMenu(null); }}
          >
            <Folder size={13} /> {t("sidebar.activateSession")}
          </button>
          <button
            className="ctx-item"
            onClick={() => { props.onPopout(menu.sessionId); setMenu(null); }}
          >
            <ExternalLink size={13} /> {t("tabbar.moveToWindow")}
          </button>
          <div className="ctx-sep" />
          <button
            className="ctx-item danger"
            onClick={() => { props.onClose(menu.sessionId); setMenu(null); }}
          >
            <X size={13} /> {t("tabbar.closeTab")}
          </button>
        </div>
      )}
    </div>
  );
}
