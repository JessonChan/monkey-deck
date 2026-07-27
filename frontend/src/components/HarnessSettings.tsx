import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import * as Popover from "@radix-ui/react-popover";
import { Events } from "@wailsio/runtime";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { Harness } from "../../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";
import type { CapabilityMatrix } from "../../bindings/github.com/jessonchan/monkey-deck/internal/acp/models";
import { RefreshCw, ArrowUpCircle, CheckCircle2, AlertCircle, Download, AlertTriangle, Plus, ChartBar } from "lucide-react";
import AddHarnessModal from "./AddHarnessModal";

// harness 能力位定义:field = CapabilityMatrix 字段名,key = i18n capability.<key> 后缀。
// declared 位(prompt*/config*/sessionList)来自 Initialize/NewSession 声明,确定 ✓/✗;
// observed 位(emitsUsage/emitsPlan)来自 noop Prompt 行为观测,withProbe=false 默认 undefined
// → 渲染中性「未观测」态,不误判为 ✗。
const CAP_BITS: { field: keyof CapabilityMatrix; key: string }[] = [
  { field: "promptImage", key: "image" },
  { field: "promptAudio", key: "audio" },
  { field: "promptEmbeddedContext", key: "embeddedContext" },
  { field: "configModel", key: "model" },
  { field: "configMode", key: "mode" },
  { field: "configEffort", key: "effort" },
  { field: "sessionList", key: "sessionList" },
  { field: "emitsUsage", key: "usage" },
  { field: "emitsPlan", key: "plan" },
];

// harness 管理 pane(发现 / 版本检测 / 升级)。
// 展示每个已知 harness 的:名称 + 启动命令 + 本地版本 + 上游最新版本 + 升级按钮 / 状态 + 能力矩阵。
// 数据来自后端 Discover(扫 PATH + 跑 --version + 查 GitHub Releases)+ ProbeCapabilities(能力位)。
// 本组件只渲染 pane 内容,由设置中心面板承载。
//
// 能力矩阵数据源选式(§5.3 复用):HarnessPane 由设置中心面板承载,不在 App 直接渲染链上,
// 不走 prop-drilling。镜像它现有 ListHarnesses 的「自己拉」范式 + App.tsx 的「订阅 chat:* 重拉」
// 范式,自己调 ListHarnessCapabilities + 订阅 chat:harness-capabilities。与 App 那份
// harnessCapabilities state 并行存在(两处各自拉,数据源单一 = 后端;前端两份只读快照无写冲突,KISS)。
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
  // per-harness 能力矩阵:harnessID → CapabilityMatrix | undefined。自己拉(不靠 App prop 下传,
  // 见顶部注释)。后端探测未就绪时返回 nil → {} ;ProbeErr 非空表示该 harness 探测失败。
  const [caps, setCaps] = useState<Record<string, CapabilityMatrix | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  // 「添加 harness」弹窗开关:HarnessPane 自管(不在 App 渲染链上,见顶部注释),镜像 FilePanel 范式。
  const [adding, setAdding] = useState(false);

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

  // 能力矩阵:启动拉一次快照(可能 nil = 未就绪),后端探测完成后推 chat:harness-capabilities
  // 据此重拉(镜像 App.tsx 的范式)。失败静默(caps 保持 {},HarnessRow 显示「检测中」)。
  const reloadCaps = useCallback(async () => {
    try {
      const m = await ChatService.ListHarnessCapabilities();
      setCaps(m ?? {});
    } catch {
      /* 静默:保持原值,HarnessRow 显示「检测中」态 */
    }
  }, []);

  useEffect(() => {
    void reloadCaps();
    const off = Events.On("chat:harness-capabilities", () => { void reloadCaps(); });
    return () => { off(); };
  }, [reloadCaps]);

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
        <div className="pane-head-acts">
          <button
            className="modal-btn ghost"
            data-testid="add-harness-btn"
            data-tooltip-id="md-tip"
            data-tooltip-content={t("settings.harness.addBtnTip")}
            onClick={() => setAdding(true)}
          >
            <Plus size={13} /> {t("settings.harness.addBtn")}
          </button>
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
            cap={caps[h.id]}
            onUpgrade={() => void upgrade(h.id)}
          />
        ))}
      </div>

      {adding && (
        <AddHarnessModal
          existing={list}
          onDone={(updated) => {
            setList(updated);
            setAdding(false);
            setError(null);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  );
}

function HarnessRow({
  h,
  upgrading,
  cap,
  onUpgrade,
}: {
  h: Harness;
  upgrading: "running" | "ok" | "err" | undefined;
  cap: CapabilityMatrix | undefined;
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
        {/* 能力矩阵已收进 harness-row-acts 的 ChartBar 触发按钮(popover 展开,见 CapabilityMatrixButton)。
            原先这里有一行常驻 chip,行高随 wrap 变化 + 视觉重;收进按钮后行高一致、信息按需查看。 */}
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
        {/* 能力矩阵触发按钮:ChartBar 图标。cap 未就绪(probing)/ 失败(failed)→ 禁用 + 状态图标;
            就绪 → 点击打开 popover 展开完整能力位 chip 行。放在升级按钮之前(信息查看型操作)。 */}
        <CapabilityMatrixButton cap={cap} harnessId={h.id} />
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

// 能力矩阵「收进按钮」(Task #23440):把原先常驻在 harness-row-main 的一行 chip 收进
// harness-row-acts 的 ChartBar 触发按钮,点击用 Radix popover 展开完整矩阵。
//
// 形态选式(coder 判断,§5.3 / §4.6):
//   - popover(非 collapsible):collapsible 展开会撑高本行、挤压相邻 harness 行;popover 浮在
//     之上不顶布局,信息按需查看,三端一致(Radix 已在 Composer 用,已验证)。
//   - 触发按钮在 harness-row-acts(与升级按钮同行):信息查看型操作归一处,行高恒定。
//   - ChartBar 图标(非 Info):「矩阵 / 指标」语义比通用 info 更贴。
//
// 三态(与原 CapabilityChips 一致,尊重数据源 / 不误判,§5.3):
//   - cap undefined:harnessId 不在 map / 后端探测未就绪 → 禁用按钮 + spinner。
//   - cap.probeErr 非空:探测失败 → 禁用按钮 + 警告图标 + 错误 tooltip(读 ProbeErr,§1.6)。
//   - 就绪:ChartBar 按钮,点击 popover 展开能力位 chip(declared ✓/✗;observed 中性「未观测」)。
function CapabilityMatrixButton({
  cap,
  harnessId,
}: {
  cap: CapabilityMatrix | undefined;
  harnessId: string;
}) {
  const { t } = useTranslation();

  // 检测中:cap 未就绪 → 禁用 + spinner(tooltip 提示「能力检测中…」)。
  if (!cap) {
    return (
      <button
        className="harness-cap-trigger probing"
        disabled
        data-testid={`harness-cap-probing-${harnessId}`}
        data-tooltip-id="md-tip"
        data-tooltip-content={t("capability.probing")}
      >
        <RefreshCw size={13} className="spin" />
      </button>
    );
  }

  // 检测失败:probeErr 非空 → 禁用 + 警告图标 + 错误 tooltip。
  if (cap.probeErr) {
    return (
      <button
        className="harness-cap-trigger failed"
        disabled
        data-testid={`harness-cap-failed-${harnessId}`}
        data-tooltip-id="md-tip"
        data-tooltip-content={`${t("capability.probeFailedTip")}\n${cap.probeErr}`}
      >
        <AlertCircle size={13} />
      </button>
    );
  }

  // 就绪:ChartBar 触发按钮 + popover 展开完整能力位。
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          className="harness-cap-trigger"
          data-testid={`harness-cap-trigger-${harnessId}`}
          data-tooltip-id="md-tip"
          data-tooltip-content={t("capability.matrixBtnTip")}
        >
          <ChartBar size={14} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="left"
          align="center"
          sideOffset={6}
          className="harness-cap-popover"
          data-testid={`harness-cap-popover-${harnessId}`}
        >
          <div className="harness-cap-popover-title">{t("capability.matrixTitle")}</div>
          <CapabilityChips cap={cap} harnessId={harnessId} />
          <Popover.Arrow className="harness-cap-popover-arrow" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// 能力矩阵 chip 行(在 popover 内渲染):每项 ✓/✗ + react-tooltip(md-tip,§4.5)+ 人话说明(§4.4)。
// 调用方(CapabilityMatrixButton)保证 cap 已就绪(非 undefined 且无 probeErr),此处只管渲染 chip。
//
// 状态判定:
//   - declared 位(prompt*/config*/sessionList):true=✓ / false=✗(确定)。
//   - observed 位(emitsUsage/emitsPlan):undefined=中性「未观测」(withProbe=false 默认值,不误判 ✗)。
function CapabilityChips({ cap, harnessId }: { cap: CapabilityMatrix; harnessId: string }) {
  const { t } = useTranslation();
  return (
    <div className="harness-cap" data-testid={`harness-cap-${harnessId}`}>
      {CAP_BITS.map((bit) => {
        const raw = cap[bit.field];
        // 观测位(emitsUsage/emitsPlan)undefined = 未观测(中性);declared 位 true/false → ✓/✗。
        const state: "yes" | "no" | "unknown" =
          raw === true ? "yes" : raw === false ? "no" : "unknown";
        const tipBase = t(`capability.${bit.key}Tip`);
        const tipState =
          state === "yes"
            ? t("capability.supported")
            : state === "no"
              ? t("capability.notSupported")
              : t("capability.notObserved");
        return (
          <span
            key={String(bit.field)}
            className={`harness-cap-chip ${state}`}
            data-tooltip-id="md-tip"
            data-tooltip-content={`${t(`capability.${bit.key}`)}: ${tipState}\n${tipBase}`}
            data-testid={`harness-cap-${harnessId}-${bit.key}`}
          >
            {state === "yes" ? <CheckCircle2 size={11} /> : state === "no" ? <AlertCircle size={11} /> : <AlertCircle size={11} className="dim" />}
            {t(`capability.${bit.key}`)}
          </span>
        );
      })}
    </div>
  );
}
