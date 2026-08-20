import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { RemoteInfo } from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/models";
import { copyText } from "../lib/clipboard";
import { Copy, KeyRound, RefreshCw } from "lucide-react";

// 远程访问 pane(设置中心 → 远程,AGENTS.md §1.8):桌面进程内嵌的 token 鉴权
// HTTP 服务开关 + 端口 + token + 连接地址。浏览器/移动端经 /auth?token= 直连
// 同一进程,看历史/发消息/批权限与桌面端并存。SQLite settings 为真相源。

// Set by /wails/custom.js — true only in remote-browser contexts (the desktop
// webview gets a 404 for that file and the runtime skips it).
declare global {
  interface Window { __mdRemote?: boolean; }
}

export default function RemoteSettingsPane() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [error, setError] = useState("");
  const [portDraft, setPortDraft] = useState("");
  const [busy, setBusy] = useState(false);

  // Silent on fetch failure: when the listener is turned off, this pane's own
  // transport goes down with it — keep the last/optimistic state instead of
  // showing a fetch error. Real operation errors surface via run().
  const reload = useCallback(() => {
    ChatService.GetRemoteInfo()
      .then((r) => {
        setInfo(r);
        setPortDraft(String(r?.Port ?? ""));
      })
      .catch(() => {});
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await fn(); reload(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }, [reload]);

  const toggleRemote = useCallback(async () => {
    // NOTE: deps use optional chaining — this hook is declared before the
    // `if (!info)` early return below, so info is null on first render.
    const next = !(info?.Enabled ?? false);
    setBusy(true); setError("");
    // Patch state IMMEDIATELY: stopping the server kills this pane's own
    // transport mid-response, so the awaited call below may never resolve —
    // UI state must not depend on it. Reconcile via reload when it does.
    setInfo((p) => p ? { ...p, Enabled: next, Running: next && p.Attached, URLs: next ? p.URLs : [] } : p);
    try {
      await ChatService.SetRemoteEnabled(next);
      reload();
    } catch (e) {
      // Turning OFF: transport going down mid-response is the expected end
      // state, not an error. Turning ON must surface failures — and from a
      // REMOTE client (our own transport is the server being started, which
      // may be unreachable) it is simply impossible: revert + explain (§4.4).
      if (next) {
        setInfo((p) => p ? { ...p, Enabled: false, Running: false, URLs: [] } : p);
        setError(window.__mdRemote
          ? t("settings.center.remote.turnOnFromDesktop")
          : String(e));
      }
    } finally { setBusy(false); }
  }, [info?.Enabled, reload, t]);

  if (!info) {
    return (
      <div className="settings-pane" data-testid="remote-pane">
        <div className="pane-desc">{error || t("common.loading")}</div>
      </div>
    );
  }

  return (
    <div className="settings-pane" data-testid="remote-pane">
      <div className="pane-desc">{t("settings.center.remote.desc")}</div>
      {error && <div className="settings-error" data-testid="remote-error">{error}</div>}

      <div className="settings-row">
        <div className="settings-row-text">
          <div className="settings-row-title">{t("settings.center.remote.title")}</div>
          <div className="settings-row-sub">
            {info.Running
              ? t("settings.center.remote.statusRunning", { port: info.Port })
              : info.Enabled
                ? t("settings.center.remote.statusEnabledNotRunning")
                : t("settings.center.remote.statusStopped")}
          </div>
        </div>
        <button
          className={`settings-switch ${info.Enabled ? "on" : ""}`}
          role="switch"
          aria-checked={info.Enabled}
          disabled={busy || !info.Attached}
          data-testid="settings-remote-toggle"
          data-tooltip-id="md-tip"
          data-tooltip-content={t("settings.center.remote.toggleTip")}
          onClick={toggleRemote}
        >
          <span className="settings-switch-thumb" />
        </button>
      </div>

      <div className="settings-row">
        <div className="settings-row-text">
          <div className="settings-row-title">{t("settings.center.remote.portTitle")}</div>
          <div className="settings-row-sub">{t("settings.center.remote.portDesc")}</div>
        </div>
        <div className="pane-actions">
          <input
            className="remote-port-input"
            type="number"
            min={1}
            max={65535}
            value={portDraft}
            disabled={busy}
            data-testid="settings-remote-port-input"
            onChange={(e) => setPortDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && portDraft) run(() => ChatService.SetRemotePort(Number(portDraft)));
            }}
          />
          <button
            className="btn"
            disabled={busy || !portDraft || Number(portDraft) === info.Port}
            data-testid="settings-remote-port-apply"
            data-tooltip-id="md-tip"
            data-tooltip-content={t("settings.center.remote.portApply")}
            onClick={() => run(() => ChatService.SetRemotePort(Number(portDraft)))}
          >
            {t("settings.center.remote.portApply")}
          </button>
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-text">
          <div className="settings-row-title">{t("settings.center.remote.tokenTitle")}</div>
          <div className="settings-row-sub settings-token">{t("settings.center.remote.tokenDesc")}</div>
          <code className="settings-version settings-token-value">{maskToken(info.Token)}</code>
        </div>
        <div className="pane-actions">
          <button
            className="copy-icon-btn"
            disabled={busy}
            data-testid="settings-remote-token-copy"
            data-tooltip-id="md-tip"
            data-tooltip-content={t("common.copy")}
            onClick={() => copyText(info.Token)}
          >
            <Copy size={13} />
          </button>
          <button
            className="copy-icon-btn"
            disabled={busy}
            data-testid="settings-remote-token-regen"
            data-tooltip-id="md-tip"
            data-tooltip-content={t("settings.center.remote.regen")}
            onClick={() => run(() => ChatService.RegenerateRemoteToken())}
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {info.Running && info.URLs && info.URLs.length > 0 && (
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">
              <KeyRound size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
              {t("settings.center.remote.urlsTitle")}
            </div>
            <div className="settings-row-sub">{t("settings.center.remote.urlsDesc")}</div>
            {info.URLs.map((u) => (
              <div key={u} className="remote-url-row">
                <code className="remote-url" data-testid="settings-remote-url">{u}</code>
                <button
                  className="copy-icon-btn"
                  data-testid="settings-remote-url-copy"
                  data-tooltip-id="md-tip"
                  data-tooltip-content={t("common.copy")}
                  onClick={() => copyText(u)}
                >
                  <Copy size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {!info.Attached && (
        <div className="settings-row">
          <div className="settings-row-sub">{t("settings.center.remote.notAttached")}</div>
        </div>
      )}
    </div>
  );
}

// Token mask: keep head/tail recognizable, never render the full secret in the DOM.
function maskToken(token: string): string {
  if (!token) return "";
  if (token.length <= 10) return token.slice(0, 2) + "…";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}
