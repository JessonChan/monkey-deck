import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import QRCode from "react-qr-code";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { RemoteInfo, RemoteSessionInfo } from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/models";
import { copyText } from "../lib/clipboard";
import { isRemoteClient } from "../lib/remote";
import { Copy, KeyRound, QrCode, RefreshCw } from "lucide-react";

// 远程访问 pane(设置中心 → 远程,AGENTS.md §1.8):桌面进程内嵌的 token 鉴权
// HTTP 服务开关 + 端口 + token + 一次性配对码 + 连接地址。浏览器/移动端经
// /pair?code=<一次性配对码> 换 365 天 cookie(长效 token 不再进 URL),
// 与桌面端并存。SQLite settings 为真相源。

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
  // Active pairing code: {code, expiresAt (RFC3339), baseUrl for the QR}.
  const [pairing, setPairing] = useState<{ code: string; sid: string; expiresAt: string; baseUrl: string } | null>(null);
  // Paired devices (per-device sessions): list + individual kick.
  const [devices, setDevices] = useState<RemoteSessionInfo[]>([]);
  const [now, setNow] = useState(() => Date.now());

  // Countdown tick while a pairing code is on screen (1s).
  useEffect(() => {
    if (!pairing) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pairing]);
  const pairingSecsLeft = useMemo(() => {
    if (!pairing) return 0;
    return Math.max(0, Math.floor((new Date(pairing.expiresAt).getTime() - now) / 1000));
  }, [pairing, now]);

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
  const reloadDevices = useCallback(() => {
    ChatService.RemoteListSessions().then((d) => setDevices(d ?? [])).catch(() => {});
  }, []);
  useEffect(() => { reloadDevices(); }, [reloadDevices]);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const toggleRemote = useCallback(async () => {
    if (!info) return;
    // Optimistic flip: the response for the OFF direction can be lost in
    // transport (we just shut our own pipe down) — flip at tap time and roll
    // back on real errors. Remote clients cannot recover a turned-off server
    // from their side (§1.8): show a human message instead of a fetch error.
    const next = !info.Enabled;
    setInfo({ ...info, Enabled: next, Running: next && info.Attached });
    try {
      await run(next ? () => ChatService.SetRemoteEnabled(true) : () => ChatService.SetRemoteEnabled(false));
    } catch (e) {
      setInfo({ ...info });
      setError(window.__mdRemote ? t("settings.center.remote.turnOnFromDesktop") : String(e));
    }
  }, [info, run, t]);

  const revokeDevice = useCallback(async (id: string) => {
    setBusy(true);
    try {
      await ChatService.RemoteRevokeSession(id);
      reloadDevices();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [reloadDevices]);

  const newPairingCode = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      // Go multi-return arrives as a tuple [code, sid, expiresAt(RFC3339)].
      const [code, sid, expiresAt] = await ChatService.GenerateRemotePairingCode();
      const cur = await ChatService.GetRemoteInfo();
      const base = cur?.URLs?.[0] ?? window.location.origin;
      setPairing({ code, sid, expiresAt, baseUrl: base });
      setNow(Date.now());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // Admin separation: the whole pane (toggle/port/token/pairing) is
  // desktop-only — remote browser clients never render it (see
  // SettingsPanel CATEGORIES). Belt-and-braces guard for direct renders.
  if (isRemoteClient()) return null;

  if (!info) return null;

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

      {info.Running && (
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">
              <QrCode size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
              {t("settings.center.remote.pairTitle")}
            </div>
            <div className="settings-row-sub">{t("settings.center.remote.pairDesc")}</div>
            {pairing && pairingSecsLeft > 0 && (
              <div className="remote-pairing-box" data-testid="remote-pairing">
                <div className="remote-pairing-qr" data-testid="remote-pairing-qr" data-pair-url={`${pairing.baseUrl}/pair?sid=${pairing.sid}`}>
                  {/* 2-of-2: the QR/link carries the sid (high-entropy session
                      binding — "where"); the 6-digit code is typed by the human
                      ("authorization"). A leaked link alone has no working code;
                      a glimpsed code alone has nowhere to be typed. */}
                  <QRCode value={`${pairing.baseUrl}/pair?sid=${pairing.sid}`} size={132} bgColor="#ffffff" fgColor="#1a1a1c" />
                </div>
                <div className="remote-pairing-info">
                  <div className="remote-pairing-code" data-testid="remote-pairing-code">{pairing.code}</div>
                  <div className="remote-pairing-countdown">
                    {t("settings.center.remote.pairCountdown", { secs: pairingSecsLeft })}
                  </div>
                  <div className="remote-pairing-hint">{t("settings.center.remote.pairHint")}</div>
                  <button
                    type="button"
                    className="btn remote-pairing-copylink"
                    disabled={busy}
                    data-testid="remote-pairing-copylink"
                    data-tooltip-id="md-tip"
                    data-tooltip-content={t("settings.center.remote.pairLinkTip")}
                    onClick={() => copyText(`${pairing.baseUrl}/pair?sid=${pairing.sid}`)}
                  >
                    {t("settings.center.remote.pairLink")}
                  </button>
                </div>
              </div>
            )}
            {pairing && pairingSecsLeft <= 0 && (
              <div className="settings-row-sub" data-testid="remote-pairing-expired">
                {t("settings.center.remote.pairExpired")}
              </div>
            )}
          </div>
          <div className="pane-actions">
            <button
              className="btn"
              disabled={busy}
              data-testid="settings-remote-pair-btn"
              data-tooltip-id="md-tip"
              data-tooltip-content={t("settings.center.remote.pairBtnTip")}
              onClick={() => void newPairingCode()}
            >
              {t("settings.center.remote.pairBtn")}
            </button>
          </div>
        </div>
      )}

      {info.Running && devices.length > 0 && (
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-title">{t("settings.center.remote.devicesTitle")}</div>
            <div className="settings-row-sub">{t("settings.center.remote.devicesDesc")}</div>
            {devices.map((d) => (
              <div key={d.ID} className="remote-device-row" data-testid="remote-device-row">
                <div className="remote-device-main">
                  <span className="remote-device-label" data-testid="remote-device-label">{d.Label}</span>
                  <span className="remote-device-meta">{t("settings.center.remote.deviceMeta", { paired: d.CreatedAt, seen: d.LastSeen })}</span>
                </div>
                <button
                  className="btn remote-device-kick"
                  disabled={busy}
                  data-testid={`remote-device-kick-${d.ID.slice(0, 6)}`}
                  data-tooltip-id="md-tip"
                  data-tooltip-content={t("settings.center.remote.kickTip")}
                  onClick={() => void revokeDevice(d.ID)}
                >
                  {t("settings.center.remote.kick")}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

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
  if (!token || token.length <= 10) return "••••••";
  return token.slice(0, 5) + "…" + token.slice(-4);
}
