import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { Harness } from "../../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";
import { RefreshCw, ArrowUpCircle, CheckCircle2, AlertCircle, Download, AlertTriangle, Plus, Trash2 } from "lucide-react";
import AddHarnessWizard from "./AddHarnessWizard";

// harness 管理 pane(发现 / 版本检测 / 升级)。
// 展示每个已知 harness 的:名称 + 启动命令 + 本地版本 + 上游最新版本 + 升级按钮 / 状态。
// 数据来自后端 Discover(扫 PATH + 跑 --version + 查 GitHub Releases)。
// 本组件只渲染 pane 内容,由设置中心面板承载。
export default function HarnessPane() {
  const { t } = useTranslation();
  const [list, setList] = useState<Harness[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // 「自动检查 harness 更新」开关:真相源在后端 SQLite(check_harness_updates),
  // 后台 ticker 据此启停(Task #22121)。这里经 SetCheckHarnessUpdates 写后端设置实时启停 ticker,
  // 初值经 GetConfig 读取;不另存前端镜像(单一真相源,§5.3 Less is More)。
  const [autoCheck, setAutoCheck] = useState<boolean>(true);
  // 「自动升级 harness」子开关(auto_harness_upgrade 设置,Task #22385 后端落地):
  // 开启后周期 ticker 发现 UpgradeAvailable 且安全时静默跑官方安装脚本。默认关闭(较重 / 有风险)。
  // 与 autoCheck 共用同一 ticker,OR 语义:任一开启即跑 ticker,都关才停。
  const [autoUpgrade, setAutoUpgrade] = useState<boolean>(false);
  // per-harness 升级状态:id → "running" | "ok" | "err"
  const [upgrading, setUpgrading] = useState<Record<string, "running" | "ok" | "err">>({});
  const [error, setError] = useState<string | null>(null);
  // 声明即用向导:展开内联表单(命令+自检+添加)。
  const [showAdd, setShowAdd] = useState(false);

  // 拉后端开关当前值:经 GetConfig 一次取回 checkHarnessUpdates / autoHarnessUpgrade 两个字段
  // (单一真相源 = 后端 SQLite;GetConfig 是后端聚合的只读快照,Task #22385 已暴露 autoHarnessUpgrade)。
  // 缺省 / 解析失败兜底:autoCheck=true / autoUpgrade=false,与后端默认一致。
  useEffect(() => {
    ChatService.GetConfig()
      .then((cfg) => {
        if (cfg && cfg.checkHarnessUpdates != null) setAutoCheck(cfg.checkHarnessUpdates !== "false");
        if (cfg && cfg.autoHarnessUpgrade != null) setAutoUpgrade(cfg.autoHarnessUpgrade === "true");
      })
      .catch(() => {});
  }, []);

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

  // 删除用户声明的 harness(内置不可删,后端 RemoveUserHarness 已拦)。删后绑定它的
  // session 不能再继续对话(后端 startLive 守卫拒绝 spawn,历史保留)。确认后调,失败进 error 区。
  const remove = useCallback(async (id: string) => {
    if (!window.confirm(t("settings.harness.delConfirm"))) return;
    setError(null);
    try {
      await ChatService.RemoveUserHarness(id);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }, [t, reload]);

  // 切换开关:写后端 SQLite 设置(SetCheckHarnessUpdates 实时启停后台 ticker)。
  // 失败回滚 UI 到原值(下次 GetConfig 会把 UI 纠正回真相值)。
  const toggleAutoCheck = useCallback(async () => {
    const next = !autoCheck;
    setAutoCheck(next);
    try {
      await ChatService.SetCheckHarnessUpdates(next);
    } catch (e) {
      setError(String(e));
      setAutoCheck(!next);
    }
  }, [autoCheck]);

  // 切换「自动升级」子开关:写后端 SQLite(auto_harness_upgrade,SetAutoHarnessUpgrade 实时
  // 启停后台 ticker 的 auto 分支)。失败回滚 UI 到原值。
  const toggleAutoUpgrade = useCallback(async () => {
    const next = !autoUpgrade;
    setAutoUpgrade(next);
    try {
      await ChatService.SetAutoHarnessUpgrade(next);
    } catch (e) {
      setError(String(e));
      setAutoUpgrade(!next);
    }
  }, [autoUpgrade]);

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
        <button
          className="modal-btn ghost"
          data-testid="harness-add-btn"
          data-tooltip-id="md-tip"
          data-tooltip-content={t("settings.harness.addBtn")}
          onClick={() => setShowAdd((v) => !v)}
        >
          <Plus size={13} /> {t("settings.harness.addBtn")}
        </button>
      </div>

      {error && <div className="modal-del-err">{error}</div>}

      <div className="settings-row" data-testid="harness-autocheck-row">
        <div className="settings-row-text">
          <div className="settings-row-title">{t("settings.harness.autoCheckTitle")}</div>
          <div className="settings-row-sub">{t("settings.harness.autoCheckDesc")}</div>
        </div>
        <button
          className={`settings-switch ${autoCheck ? "on" : ""}`}
          role="switch"
          aria-checked={autoCheck}
          data-testid="harness-autocheck"
          onClick={() => void toggleAutoCheck()}
        >
          <span className="settings-switch-thumb" />
        </button>
      </div>

      {/* 自动升级子开关:挂在「自动检查」之下(auto_harness_upgrade)。默认关闭,因静默跑官方
          安装脚本较重 / 有风险——整行带风险 tooltip + 警告图标说明(§4.4 不裸露技术格式,
          §4.5 统一 react-tooltip)。与 autoCheck 共用后端 ticker,OR 语义。 */}
      <div
        className="settings-row is-sub"
        data-testid="harness-autoupgrade-row"
        data-tooltip-id="md-tip"
        data-tooltip-content={t("settings.harness.autoUpgradeRiskTip")}
      >
        <div className="settings-row-text">
          <div className="settings-row-title">
            <AlertTriangle size={12} className="harness-risk-icon" />
            {t("settings.harness.autoUpgradeTitle")}
          </div>
          <div className="settings-row-sub">{t("settings.harness.autoUpgradeDesc")}</div>
        </div>
        <button
          className={`settings-switch ${autoUpgrade ? "on" : ""}`}
          role="switch"
          aria-checked={autoUpgrade}
          data-testid="harness-autoupgrade"
          onClick={() => void toggleAutoUpgrade()}
        >
          <span className="settings-switch-thumb" />
        </button>
      </div>

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
            onDelete={() => void remove(h.id)}
          />
        ))}
      </div>

      {showAdd && (
        <AddHarnessWizard
          onDone={() => {
            setShowAdd(false);
            void reload();
          }}
          onCancel={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}

function HarnessRow({
  h,
  upgrading,
  onUpgrade,
  onDelete,
}: {
  h: Harness;
  upgrading: "running" | "ok" | "err" | undefined;
  onUpgrade: () => void;
  onDelete: () => void;
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
        {/* 用户声明的 harness 才显示删除(内置不可删)。删后绑定它的 session 不能再继续对话。 */}
        {h.userDefined && (
          <button
            className="modal-btn ghost danger"
            data-testid={`harness-delete-${h.id}`}
            data-tooltip-id="md-tip"
            data-tooltip-content={t("settings.harness.delTip")}
            onClick={onDelete}
          >
            <Trash2 size={13} /> {t("settings.harness.delete")}
          </button>
        )}
      </div>
    </div>
  );
}
