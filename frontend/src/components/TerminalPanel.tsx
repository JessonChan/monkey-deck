// TerminalPanel:终端 unit。横向 tab 条 + 下方 xterm 区(只显示 active tab)。
// tab 交互:单击切换、hover × / 中键 kill、右键菜单(改名/Kill)、+ 新建。
// 与 agent 的 ACP 工具卡片完全分离:agent 走对话流,这里纯粹是给人敲命令的 PTY。
import { useEffect, useState } from "react";
import { Plus, X, ChevronDown, Terminal as TerminalIcon } from "lucide-react";
import { useTerminal, type TerminalHandle } from "../hooks/useTerminal";
import type { TerminalTab } from "../lib/terminalTypes";

function TerminalView({ tab, active, onExit }: { tab: TerminalTab; active: boolean; onExit: () => void }) {
  const { containerRef, fit, focus }: TerminalHandle = useTerminal(tab.id, onExit);
  useEffect(() => {
    if (!active) return;
    fit(); // 切到 active 时只重算尺寸,不夺焦(焦点留给 Composer;点终端区才 focus)
  }, [active, fit]);
  return (
    <div
      className="terminal-instance"
      ref={containerRef}
      style={{ display: active ? "block" : "none" }}
      onClick={() => focus()}
      data-testid={`terminal-instance-${tab.id}`}
    />
  );
}

// 右键菜单位置 + 目标 tab。
interface ContextMenu {
  x: number;
  y: number;
  tabId: string;
}

export interface TerminalPanelProps {
  sessionId: string;
  cwd: string;
  tabs: TerminalTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onTabExit: (id: string) => void;
  onNewTab: () => void;
  onRenameTab: (id: string, title: string) => void;
  onClosePanel: () => void;
}

export default function TerminalPanel(props: TerminalPanelProps) {
  const { tabs, activeTabId, onSelectTab, onCloseTab, onNewTab, onRenameTab, onClosePanel } = props;
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // 关闭右键菜单:外部点击 / Esc(§4.2 弹窗必须支持 Esc 关闭)。
  useEffect(() => {
    if (!menu) return;
    const onDown = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [menu]);

  const startRename = (tab: TerminalTab) => {
    setRenamingId(tab.id);
    setRenameValue(tab.userTitle || tab.title);
    setMenu(null);
  };
  const commitRename = () => {
    if (renamingId) onRenameTab(renamingId, renameValue.trim());
    setRenamingId(null);
  };


  return (
    <div className="terminal-panel">
      <div className="terminal-tabs-bar">
        <div className="terminal-tabs-scroll" onClick={(e) => { if (e.target === e.currentTarget) onNewTab(); }}>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`terminal-tab ${tab.id === activeTabId ? "active" : ""} ${tab.status === "dead" ? "dead" : ""}`}
              onClick={() => onSelectTab(tab.id)}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onCloseTab(tab.id); } }}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, tabId: tab.id }); }}
              title={tab.userTitle || tab.title}
            >
              <TerminalIcon size={13} className="terminal-tab-icon" />
              {renamingId === tab.id ? (
                <input
                  className="terminal-tab-rename"
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    else if (e.key === "Escape") setRenamingId(null);
                  }}
                  onBlur={commitRename}
                  size={Math.max(6, renameValue.length)}
                />
              ) : (
                <span className="terminal-tab-title">{tab.userTitle || tab.title}</span>
              )}
              <button
                className="terminal-tab-close"
                onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                data-tooltip-id="md-tip"
                data-tooltip-content="关闭终端"
              ><X size={13} /></button>
            </div>
          ))}
          <button
            className="terminal-icon-btn"
            onClick={onNewTab}
            data-tooltip-id="md-tip"
            data-tooltip-content="新建终端"
          ><Plus size={16} /></button>
        </div>
        <button
          className="terminal-icon-btn"
          onClick={onClosePanel}
          data-tooltip-id="md-tip"
          data-tooltip-content="收起终端面板 (⌘J)"
        ><ChevronDown size={16} /></button>
      </div>

      <div className="terminal-views">
        {tabs.length === 0 ? (
          <div className="terminal-empty">点击 + 或空白处新建终端</div>
        ) : (
          tabs.map((tab) => (
            <TerminalView
              key={tab.id}
              tab={tab}
              active={tab.id === activeTabId}
              onExit={() => props.onTabExit(tab.id)}
            />
          ))
        )}
      </div>

      {menu && (
        <div
          className="terminal-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="terminal-context-item"
            onClick={() => { const t = tabs.find((x) => x.id === menu.tabId); if (t) startRename(t); }}
          >重命名</button>
          <button
            className="terminal-context-item danger"
            onClick={() => { onCloseTab(menu.tabId); setMenu(null); }}
          >关闭终端</button>
        </div>
      )}
    </div>
  );
}
