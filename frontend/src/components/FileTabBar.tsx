import { useTranslation } from "react-i18next";
import { MessageCircle, File as FileIcon, GitCompare, X } from "lucide-react";

// FileTabBar = the second row of the middle column (placement A1).
// Renders only when the active session has at least one tab open (file or diff).
//
// Tab list shape (linear, first item is always the non-closeable Chat tab):
//   [ Chat ]  |  [ runner.go ] [ proc.go ]  [± proc.go ]
//   ^ pinned    ^ file tabs (content)        ^ diff tabs (git changes)
//
// Clicking Chat       -> onActivate("chat")    -> middle column shows ChatView.
// Clicking a file tab -> onActivate(file key)  -> middle column shows EditorPane.
// Clicking a diff tab -> onActivate(diff key)  -> middle column shows DiffPane.
//   (ChatView is hidden with display:none, all state preserved.)
//
// A path can be open as BOTH a content tab and diff tab(s) — and staged vs unstaged
// diffs of the same path are distinct — so a tab's identity is `tabKey(tab)`, not
// the path alone. Diff tabs get a GitCompare icon + a staged/unstaged tint.

export interface FileTab {
  path: string;
  line?: number;
  kind: "file" | "diff";
  // diff tabs only: true = diff cached in index vs HEAD; false = working tree vs index.
  staged?: boolean;
}

// Stable identity for a tab. File and diff tabs of the same path must NOT collide,
// and staged/unstaged diffs of the same path must not collide either.
export function tabKey(tab: FileTab): string {
  if (tab.kind === "diff") return `diff:${tab.staged ? "s" : "u"}:${tab.path}`;
  return `file:${tab.path}`;
}

export default function FileTabBar({
  tabs,
  activeKey,
  onActivate,
  onCloseFile,
}: {
  tabs: FileTab[];
  // "chat" | a tabKey(). Determines which tab is highlighted.
  activeKey: string;
  onActivate: (key: string) => void;
  onCloseFile: (key: string) => void;
}) {
  const { t } = useTranslation();
  if (tabs.length === 0) return null;

  return (
    <div className="file-tabbar" data-testid="file-tabbar">
      <div className="file-tabbar-scroll">
        {/* Pinned Chat tab — the session's own chat. Always first, not closeable. */}
        <button
          className={`file-tab chat-tab ${activeKey === "chat" ? "active" : ""}`}
          onClick={() => onActivate("chat")}
          data-testid="file-tab-chat"
          data-tooltip-id="md-tip"
          data-tooltip-content={t("fileTab.chatTip")}
        >
          <MessageCircle size={13} className="file-tab-icon" />
          <span className="file-tab-title">{t("fileTab.chat")}</span>
        </button>
        <span className="file-tabbar-divider" />
        {tabs.map((tab) => {
          const name = tab.path.split("/").pop() || tab.path;
          const key = tabKey(tab);
          const isActive = activeKey === key;
          const isDiff = tab.kind === "diff";
          return (
            <button
              key={key}
              className={`file-tab ${isActive ? "active" : ""} ${isDiff ? "diff-tab" : ""} ${isDiff && tab.staged ? "staged" : "unstaged"}`}
              onClick={() => onActivate(key)}
              data-testid={`file-tab-${key}`}
              data-tooltip-id="md-tip"
              data-tooltip-content={
                isDiff
                  ? `${tab.path} · ${tab.staged ? t("diffPane.staged") : t("diffPane.unstaged")}`
                  : tab.line
                    ? `${tab.path}:${tab.line}`
                    : tab.path
              }
            >
              {isDiff ? (
                <GitCompare size={13} className="file-tab-icon" />
              ) : (
                <FileIcon size={13} className="file-tab-icon" />
              )}
              <span className="file-tab-title">{name}</span>
              <span
                className="file-tab-close"
                role="button"
                tabIndex={-1}
                aria-label={t("fileTab.closeFile")}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseFile(key);
                }}
              >
                <X size={12} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
