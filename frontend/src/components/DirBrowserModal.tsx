import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { BrowseDirResult, BrowseEntry } from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/models";
import { extractErrMsg } from "../lib/errorMsg";
import { ArrowUp, ChevronRight, Folder, HardDrive, Home, Loader2 } from "lucide-react";

interface Props {
  onConfirm: (path: string) => void;
  onCancel: () => void;
}

// DirBrowserModal: web directory picker for remote browser / PWA clients
// (#128). The desktop uses the host-native PickDirectory dialog; over the
// remote connection that dialog does nothing visible, so App.addProject
// branches on isRemoteClient() and opens this modal instead. Data comes from
// the read-only BrowseRoots/BrowseDir bindings — never raw fs access.
//
// Navigation model: descend-only browsing (tap a row to open it, ⬆ to go to
// the parent; at the filesystem root "up" returns to the roots view). The
// CONFIRM action always targets the directory currently displayed — the same
// "navigate into, then choose" model as mobile OS folder pickers, no
// separate selection state to keep in sync.
export default function DirBrowserModal({ onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  // Current directory view; null = roots view (BrowseRoots shortcuts).
  const [cur, setCur] = useState<BrowseDirResult | null>(null);
  const [roots, setRoots] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Sequence guard: rapid taps fire overlapping BrowseDir calls; only the
  // latest response may land (stale ones are dropped, no flicker/race).
  const seqRef = useRef(0);

  const openDir = useCallback(async (path: string) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await ChatService.BrowseDir(path);
      if (seq !== seqRef.current) return;
      setCur(res ?? null);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(extractErrMsg(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  const showRoots = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const list = await ChatService.BrowseRoots();
      if (seq !== seqRef.current) return;
      setCur(null);
      setRoots(list ?? []);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(extractErrMsg(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void showRoots();
  }, [showRoots]);

  // Esc closes (§4.2); Enter confirms the displayed directory — but only when
  // no control has focus: Enter on a focused button must run that button's
  // own action (row = descend, cancel = cancel, confirm = confirm via native
  // activation), never be overridden by the global confirm.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter" && cur && !loading && !error) {
        const el = e.target as HTMLElement | null;
        if (el && typeof el.closest === "function" && el.closest("button, input, textarea, select, a, [contenteditable]")) return;
        onConfirm(cur.path);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm, cur, loading, error]);

  const goUp = () => {
    if (cur?.parent) void openDir(cur.parent);
    else void showRoots();
  };

  // Roots rows get a semantic icon (~ = home, / or a volume name = drive).
  const rootIcon = (name: string) => (name === "~" ? <Home size={14} /> : <HardDrive size={14} />);

  const renderRow = (key: string, icon: ReactNode, name: string, path: string, onClick: () => void, testid: string) => (
    <button
      key={key}
      type="button"
      className="dir-browser-entry"
      data-testid={testid}
      onClick={onClick}
      data-tooltip-id="md-tip"
      data-tooltip-content={path}
    >
      <span className="dir-browser-entry-icon">{icon}</span>
      <span className="dir-browser-entry-name">{name}</span>
      <ChevronRight size={13} className="dir-browser-entry-chev" />
    </button>
  );

  return (
    <div className="modal-overlay">
      <div className="modal-card dir-browser-card" data-testid="dir-browser">
        <div className="modal-title">{t("dirBrowser.title")}</div>

        <div className="dir-browser-pathbar">
          <button
            type="button"
            className="dir-browser-up"
            onClick={goUp}
            data-testid="dir-browser-up"
            aria-label={t("dirBrowser.up")}
            data-tooltip-id="md-tip"
            data-tooltip-content={t("dirBrowser.up")}
          >
            <ArrowUp size={14} />
          </button>
          <div className="dir-browser-path" data-testid="dir-browser-path" data-tooltip-id="md-tip" data-tooltip-content={cur?.path ?? t("dirBrowser.locations")}>
            {loading && <Loader2 size={12} className="spin dir-browser-path-spinner" />}
            <span className="dir-browser-path-text">{cur ? cur.path : t("dirBrowser.locations")}</span>
          </div>
        </div>

        <div className="dir-browser-list" data-testid="dir-browser-list">
          {error && <div className="dir-browser-error" data-testid="dir-browser-error">{t("dirBrowser.readFailed", { error })}</div>}
          {!error && loading && <div className="dir-browser-state">{t("common.loading")}</div>}
          {!error && !loading && !cur && roots.length === 0 && <div className="dir-browser-state">{t("dirBrowser.empty")}</div>}
          {!error && !loading && !cur && roots.map((r) =>
            renderRow(r.path, rootIcon(r.name), r.name, r.path, () => void openDir(r.path), `dir-browser-root-${r.name}`)
          )}
          {!error && !loading && cur && cur.dirs.length === 0 && <div className="dir-browser-state">{t("dirBrowser.empty")}</div>}
          {!error && !loading && cur && cur.dirs.map((d) =>
            renderRow(d.path, <Folder size={14} />, d.name, d.path, () => void openDir(d.path), `dir-browser-entry-${d.name}`)
          )}
        </div>

        <div className="modal-actions">
          <button className="modal-btn ghost" onClick={onCancel} data-testid="dir-browser-cancel">
            {t("common.cancel")}
          </button>
          <button
            className="modal-btn primary"
            disabled={!cur || loading || !!error}
            onClick={() => cur && onConfirm(cur.path)}
            data-testid="dir-browser-confirm"
            data-tooltip-id="md-tip"
            data-tooltip-content={cur ? t("dirBrowser.confirm") : t("dirBrowser.confirmDisabled")}
          >
            {t("dirBrowser.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
