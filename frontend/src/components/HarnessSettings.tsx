import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { Harness } from "../../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";
import { RefreshCw, ArrowUpCircle, CheckCircle2, AlertCircle, Download } from "lucide-react";

// harness 管理 pane(发现 / 版本检测 / 升级)。
// 展示每个已知 harness 的:名称 + 启动命令 + 本地版本 + 上游最新版本 + 升级按钮 / 状态。
// 数据来自后端 Discover(扫 PATH + 跑 --version + 查 GitHub Releases)。
// 本组件只渲染 pane 内容,由设置中心面板承载。
export default function HarnessPane() {
  const { t } = useTranslation();
  const [list, setList] = useState<Harness[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // per-harness 升级状态:id → "running" | "ok" | "err"
  const [upgrading, setUpgrading] = useState<Record<string, "running" | "ok" | "err">>({});
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const items = await ChatService.ListHarnesses();
      setList(items ?? []);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const items = await ChatService.RefreshHarnesses();
      setList(items ?? []);
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  const upgrade = useCallback(async (id: string) => {
    setUpgrading((prev) => ({ ...prev, [id]: "running" }));
    setError(null);
    try {
      const items = await ChatService.UpgradeHarness(id);
      setList(items ?? []);
      // 后端在升级失败时把错误塞进对应 harness.UpgradeError;成功则该字段为空。
      const target = (items ?? []).find((h) => h.id === id);
      setUpgrading((prev) => ({ ...prev, [id]: target?.upgradeError ? "err" : "ok" }));
      if (target?.upgradeError) setError(target.upgradeError);
    } catch (e) {
      setUpgrading((prev) => ({ ...prev, [id]: "err" }));
      setError(String(e));
    }
  }, []);

  return (
    <div className="settings-pane" data-testid="harness-pane">
      <div className="pane-head">
        <div className="pane-desc">{t("settings.harness.desc")}</div>
        <button
          className="modal-btn ghost"
          data-testid="harness-refresh"
          disabled={refreshing}
          data-tooltip-id="md-tip"
          data-tooltip-content={t("settings.harness.refreshTip")}
          onClick={() => void refresh()}
        >
          <RefreshCw size={13} className={refreshing ? "spin" : ""} /> {t("settings.harness.refresh")}
        </button>
      </div>

      {error && <div className="modal-del-err">{error}</div>}

      <div className="harness-list" data-testid="harness-list">
        {loading && <div className="perm-empty">{t("settings.harness.loading")}</div>}
        {!loading && list.length === 0 && (
          <div className="perm-empty">{t("settings.harness.empty")}</div>
        )}
        {list.map((h) => (
          <HarnessRow
            key={h.id}
            h={h}
            upgrading={upgrading[h.id]}
            onUpgrade={() => void upgrade(h.id)}
          />
        ))}
      </div>
    </div>
  );
}

function HarnessRow({
  h,
  upgrading,
  onUpgrade,
}: {
  h: Harness;
  upgrading: "running" | "ok" | "err" | undefined;
  onUpgrade: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={`harness-row${h.installed ? "" : " not-installed"}`} data-testid={`harness-row-${h.id}`}>
      <div className="harness-row-main">
        <div className="harness-row-head">
          <span className="harness-name">{h.name}</span>
          <span className="harness-id" data-testid={`harness-id-${h.id}`}>{h.id}</span>
          {h.installed ? (
            <span className="harness-badge ok" data-testid={`harness-installed-${h.id}`}>
              <CheckCircle2 size={12} /> {t("settings.harness.installed")}
            </span>
          ) : (
            <span className="harness-badge warn" data-testid={`harness-missing-${h.id}`}>
              <AlertCircle size={12} /> {t("settings.harness.notInstalled")}
            </span>
          )}
        </div>
        <div className="harness-row-meta">
          <span className="harness-cmd" data-tooltip-id="md-tip" data-tooltip-content={t("settings.harness.cmdTip")}>
            <span className="harness-cmd-label">{t("settings.harness.cmd")}</span>
            <code>{h.command}</code>
          </span>
          {h.installedVersion && (
            <span className="harness-ver" data-testid={`harness-installedver-${h.id}`}>
              <span className="harness-cmd-label">{t("settings.harness.current")}</span>
              <code>{h.installedVersion}</code>
            </span>
          )}
          {h.latestVersion && (
            <span className="harness-ver" data-testid={`harness-latestver-${h.id}`}>
              <span className="harness-cmd-label">{t("settings.harness.latest")}</span>
              <code>{h.latestVersion}</code>
            </span>
          )}
        </div>
        {h.path && (
          <div className="harness-path" data-tooltip-id="md-tip" data-tooltip-content={h.path}>
            <span className="harness-cmd-label">{t("settings.harness.path")}</span>
            <code className="harness-path-code">{h.path}</code>
          </div>
        )}
        {h.upgradeError && (
          <div className="harness-err" data-testid={`harness-upgradeerr-${h.id}`}>{h.upgradeError}</div>
        )}
      </div>
      <div className="harness-row-acts">
        {/* 升级按钮:有最新版本或未装时显示;后端无 Upgrader 配置时点上去会返 ErrUpgraderNotConfigured,错误进 error 区。 */}
        {(h.upgradeAvailable || !h.installed) && (
          <button
            className={`modal-btn ${h.upgradeAvailable ? "primary" : "ghost"}`}
            data-testid={`harness-upgrade-${h.id}`}
            disabled={upgrading === "running"}
            data-tooltip-id="md-tip"
            data-tooltip-content={t("settings.harness.upgradeTip")}
            onClick={onUpgrade}
          >
            {upgrading === "running" ? (
              <><RefreshCw size={13} className="spin" /> {t("settings.harness.upgrading")}</>
            ) : h.installed ? (
              <><ArrowUpCircle size={13} /> {t("settings.harness.upgrade")}</>
            ) : (
              <><Download size={13} /> {t("settings.harness.install")}</>
            )}
          </button>
        )}
        {upgrading === "ok" && (
          <span className="harness-status-ok" data-testid={`harness-upgrade-ok-${h.id}`}>
            <CheckCircle2 size={14} /> {t("settings.harness.upgradeDone")}
          </span>
        )}
        {upgrading === "err" && (
          <span className="harness-status-err" data-testid={`harness-upgrade-fail-${h.id}`}>
            <AlertCircle size={14} /> {t("settings.harness.upgradeFailed")}
          </span>
        )}
        {/* 已装且无可用升级 + 无错误 → 显示「已是最新」。 */}
        {h.installed && !h.upgradeAvailable && !h.upgradeError && upgrading !== "running" && (
          <span className="harness-status-ok" data-testid={`harness-uptodate-${h.id}`}>
            <CheckCircle2 size={14} /> {t("settings.harness.upToDate")}
          </span>
        )}
      </div>
    </div>
  );
}
