// TabBar: horizontal strip of "currently open" sessions in the main window, mirroring browser /
// VS Code tab semantics. Click = switch to that session; middle-click or × = close the tab
// (evict its in-memory cache, NOT delete the session); right-click = context menu (move to a
// standalone popout window). Pure presentation + callbacks — all state lives in App.
//
// Chrome-style shrink (#156): the strip never scrolls — tabs compress as it fills. When the
// available width can no longer give every tab title space (tabs.length × WIDE_MIN), titles and
// unread dots unmount and each tab takes the 34px dot+close form; the tab root then carries a
// tooltip with the raw title so it stays reachable. The 50-tab cap is enforced upstream (App
// registerTab); a rejection bumps limitHintSeq and this component flashes a transient hint.
//
// Visual reference: the project's own .terminal-tab* CSS (TerminalPanel) is the closest existing
// "tab + close button" pattern. We reuse the same .session-dot + status classes as the sidebar
// (Sidebar.tsx ~L342) for the status indicator, so colors stay consistent with the rest of the app.
//
// Wails3 drag region: this strip sits in the title-bar drag region (the area above <main>), so the
// container is `--wails-draggable: drag` (lets the user drag the window by empty tab-bar space) but
// every interactive control (tab, close button) is `--wails-draggable: no-drag` or clicks get
// swallowed by the drag handler. This mirrors the chat-header / sidebar-header convention.
import { useEffect, useRef, useState } from "react";
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

// Hard cap on open session tabs (#156): the shrinkable strip has no scrolling, so capacity is
// finite. Enforced by App at every tab-creation entry (registerTab); owned here because the
// limit-hint copy interpolates it.
export const TAB_LIMIT = 50;

export interface TabBarProps {
  tabs: TabBarTab[];
  activeId: string | null;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onPopout: (sessionId: string) => void;
  // Bumped by App every time a tab open is rejected at TAB_LIMIT (#156). A change to a nonzero
  // value shows the limit hint, which self-dismisses after LIMIT_HINT_MS.
  limitHintSeq?: number;
}

// Below tabs.length × WIDE_MIN px of available strip width a with-title tab has no title space
// left (dot 7 + gap 6 + zero-width title + gap 6 + close 16 + padding 12 = 47): all tabs drop
// their titles and take the 34px dot+close form.
const WIDE_MIN = 47;
// Exported for tests: self-dismiss is a real component timer, and bun's fake timers gate the
// real macrotask queue (awaiting a real setTimeout while faked never resolves), so tests
// assert dismissal against actual wall time (LIMIT_HINT_MS + margin) instead of fake clocks.
export const LIMIT_HINT_MS = 1500;

export default function TabBar(props: TabBarProps) {
  const { t } = useTranslation();
  const { tabs, activeId, limitHintSeq = 0 } = props;
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const [stripWidth, setStripWidth] = useState<number | null>(null);
  const [showLimitHint, setShowLimitHint] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Close the context menu on outside click / Esc (§4.2 — popups must close on Esc).
  useEffect(() => {
    if (!menu) return;
    const onDown = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [menu]);

  // Live strip width (#156): fires on mount and on every resize, so the narrow-form switch
  // tracks both window size and tab count without layout reads during render.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[entries.length - 1]?.contentRect.width;
      if (typeof w === "number") setStripWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 50-tab cap hint: every limitHintSeq bump (re)shows the hint for LIMIT_HINT_MS.
  useEffect(() => {
    if (!limitHintSeq) return;
    setShowLimitHint(true);
    const timer = setTimeout(() => setShowLimitHint(false), LIMIT_HINT_MS);
    return () => clearTimeout(timer);
  }, [limitHintSeq]);

  // Narrow (34px) form when titles no longer fit; unknown width (no observer) = wide form.
  const narrow = stripWidth !== null && tabs.length * WIDE_MIN > stripWidth;

  return (
    <div className="tabbar" data-testid="tabbar">
      <div className="tabbar-scroll" ref={scrollRef}>
        {tabs.map((tab) => {
          // Status dot class — identical logic to Sidebar.tsx so the indicator color matches
          // the sidebar's session row (error / activity / running / reconnecting / idle).
          const active = tab.status === "prompting";
          const cls = tab.status === "error" ? "error" : active ? tab.activity ?? "running" : tab.status === "reconnecting" ? "reconnecting" : "";
          const dotTip = tab.status === "error" ? t("sidebar.status.error")
            : active ? ({ thinking: t("sidebar.status.thinking"), executing: t("sidebar.status.executing"), replying: t("sidebar.status.replying") } as Record<string, string>)[tab.activity ?? ""] ?? t("tabbar.generating")
            : tab.status === "reconnecting" ? t("sidebar.status.reconnecting")
            : t("sidebar.status.idle");
          return (
            <div
              key={tab.id}
              className={`tabbar-tab ${tab.id === activeId ? "active" : ""}${narrow ? " narrow" : ""}`}
              data-testid={`tab-${tab.id}`}
              onClick={() => props.onSelect(tab.id)}
              // Middle-click closes the tab (browser / VS Code convention).
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); props.onClose(tab.id); } }}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, sessionId: tab.id }); }}
              // Narrow form carries the raw title as the tab tooltip — the title element is
              // unmounted, this keeps it reachable (wide form: the title span's composite tip).
              data-tooltip-id={narrow ? "md-tip" : undefined}
              data-tooltip-content={narrow ? tab.title : undefined}
            >
              <span
                className={`session-dot ${cls}`}
                data-tooltip-id="md-tip"
                data-tooltip-content={dotTip}
              />
              {!narrow && (
                <span
                  className="tabbar-tab-title"
                  data-tooltip-id="md-tip"
                  data-tooltip-content={t("tabbar.sessionTooltip", { title: tab.title, project: tab.projectName })}
                >
                  {tab.title}
                </span>
              )}
              {!narrow && tab.unread && tab.id !== activeId && (
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

      {showLimitHint && (
        <span className="tabbar-limit-hint" data-testid="tabbar-limit-hint">
          {t("tabbar.limitTip", { limit: TAB_LIMIT })}
        </span>
      )}

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
