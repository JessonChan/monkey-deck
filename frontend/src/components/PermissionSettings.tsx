import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import { PermissionRule } from "../../bindings/github.com/jessonchan/monkey-deck/internal/store/models";
import { Plus, Trash2, RotateCcw, ChevronUp, ChevronDown } from "lucide-react";

// 分级权限规则设置 pane(§3.4)。规则按优先级(sort_order ASC)逐条判定,首条命中者决定裁决。
// 每条规则的约束(工具名/动作/路径/命令)AND 语义,空约束 = 通配。
// 默认规则:危险命令 deny > 只读 allow > 写/执行 ask。
//
// 本组件只渲染 pane 内容(规则列表 + 增删改 + 恢复默认),由设置中心面板承载;
// 数据读写经 ChatService → SQLite permission_rules 表,变更后端即时刷进活跃 session handler。
const ACTION_OPTIONS = [
  { value: "any", labelKey: "settings.perm.actionAny" },
  { value: "read", labelKey: "settings.perm.actionRead" },
  { value: "write", labelKey: "settings.perm.actionWrite" },
  { value: "exec", labelKey: "settings.perm.actionExec" },
  { value: "other", labelKey: "settings.perm.actionOther" },
];

const LEVEL_OPTIONS = [
  { value: "allow", labelKey: "settings.perm.levelAllow", cls: "perm-level-allow" },
  { value: "ask", labelKey: "settings.perm.levelAsk", cls: "perm-level-ask" },
  { value: "deny", labelKey: "settings.perm.levelDeny", cls: "perm-level-deny" },
];

export default function PermissionRulesPane() {
  const { t } = useTranslation();
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await ChatService.ListPermissionRules();
      setRules(list ?? []);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 懒加载:设置中心切到本 pane 时才挂载并拉取,避免无谓请求。
  useEffect(() => { void reload(); }, [reload]);

  const update = useCallback(async (rule: PermissionRule) => {
    try {
      await ChatService.UpdatePermissionRule(rule);
      setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...rule } : r)));
    } catch (e) {
      setError(String(e));
      void reload();
    }
  }, [reload]);

  const remove = useCallback(async (id: string) => {
    try {
      await ChatService.DeletePermissionRule(id);
      setRules((prev) => prev.filter((r) => r.id !== id));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const add = useCallback(async () => {
    try {
      const created = await ChatService.CreatePermissionRule(
        new PermissionRule({ level: "ask", enabled: true, sortOrder: rules.length })
      );
      if (created) setRules((prev) => [...prev, created]);
    } catch (e) {
      setError(String(e));
    }
  }, [rules.length]);

  const move = useCallback(async (id: string, dir: -1 | 1) => {
    const idx = rules.findIndex((r) => r.id === id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= rules.length) return;
    const next = [...rules];
    [next[idx], next[target]] = [next[target], next[idx]];
    setRules(next); // 乐观更新
    try {
      await ChatService.ReorderPermissionRules(next.map((r) => r.id));
    } catch (e) {
      setError(String(e));
      void reload();
    }
  }, [rules, reload]);

  const reset = useCallback(async () => {
    try {
      await ChatService.ResetPermissionRules();
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }, [reload]);

  return (
    <div className="settings-pane" data-testid="perm-pane">
      <div className="pane-head">
        <div className="pane-desc">{t("settings.perm.desc")}</div>
        <button
          className="modal-btn ghost"
          data-testid="perm-reset"
          data-tooltip-id="md-tip"
          data-tooltip-content={t("settings.perm.resetTip")}
          onClick={() => void reset()}
        >
          <RotateCcw size={13} /> {t("settings.perm.reset")}
        </button>
      </div>

      {error && <div className="modal-del-err">{error}</div>}

      <div className="perm-rule-list" data-testid="perm-rule-list">
        {loading && <div className="perm-empty">{t("settings.perm.loading")}</div>}
        {!loading && rules.length === 0 && (
          <div className="perm-empty">{t("settings.perm.empty")}</div>
        )}
        {rules.map((rule, i) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            first={i === 0}
            last={i === rules.length - 1}
            onChange={update}
            onRemove={remove}
            onMove={move}
          />
        ))}
      </div>

      <div className="pane-actions">
        <button className="modal-btn ghost" data-testid="perm-add" onClick={() => void add()}>
          <Plus size={13} /> {t("settings.perm.add")}
        </button>
      </div>
    </div>
  );
}

function RuleRow({
  rule,
  first,
  last,
  onChange,
  onRemove,
  onMove,
}: {
  rule: PermissionRule;
  first: boolean;
  last: boolean;
  onChange: (r: PermissionRule) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
}) {
  const { t } = useTranslation();
  const levelOpt = LEVEL_OPTIONS.find((l) => l.value === rule.level) || LEVEL_OPTIONS[1];
  return (
    <div className={`perm-rule ${rule.enabled ? "" : "disabled"}`} data-testid="perm-rule">
      <input
        className="perm-toggle"
        type="checkbox"
        checked={rule.enabled}
        data-testid="perm-enabled"
        onChange={(e) => void onChange({ ...rule, enabled: e.target.checked })}
        data-tooltip-id="md-tip"
        data-tooltip-content={t("settings.perm.enableTip")}
      />
      <div className="perm-rule-main">
        <div className="perm-rule-row">
          <label className="perm-field">
            <span className="perm-field-label">{t("settings.perm.tool")}</span>
            <input
              className="perm-input"
              data-testid="perm-tool"
              value={rule.toolName}
              placeholder={t("settings.perm.any")}
              onChange={(e) => void onChange({ ...rule, toolName: e.target.value })}
            />
          </label>
          <label className="perm-field">
            <span className="perm-field-label">{t("settings.perm.action")}</span>
            <select
              className="perm-select"
              data-testid="perm-action"
              value={rule.actionType || "any"}
              onChange={(e) => void onChange({ ...rule, actionType: e.target.value })}
            >
              {ACTION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
              ))}
            </select>
          </label>
          <label className="perm-field">
            <span className="perm-field-label">{t("settings.perm.level")}</span>
            <select
              className={`perm-select perm-level ${levelOpt.cls}`}
              data-testid="perm-level"
              value={rule.level}
              onChange={(e) => void onChange({ ...rule, level: e.target.value })}
            >
              {LEVEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="perm-rule-row">
          <label className="perm-field perm-field-grow">
            <span className="perm-field-label">{t("settings.perm.path")}</span>
            <input
              className="perm-input perm-input-mono"
              data-testid="perm-path"
              value={rule.pathPattern}
              placeholder={t("settings.perm.any")}
              onChange={(e) => void onChange({ ...rule, pathPattern: e.target.value })}
            />
          </label>
          <label className="perm-field perm-field-grow">
            <span className="perm-field-label">{t("settings.perm.command")}</span>
            <input
              className="perm-input perm-input-mono"
              data-testid="perm-command"
              value={rule.commandPattern}
              placeholder={t("settings.perm.cmdPlaceholder")}
              onChange={(e) => void onChange({ ...rule, commandPattern: e.target.value })}
            />
          </label>
        </div>
      </div>
      <div className="perm-rule-acts">
        <button
          className="perm-move"
          disabled={first}
          data-testid="perm-up"
          data-tooltip-id="md-tip"
          data-tooltip-content={t("settings.perm.moveUp")}
          onClick={() => onMove(rule.id, -1)}
        >
          <ChevronUp size={14} />
        </button>
        <button
          className="perm-move"
          disabled={last}
          data-testid="perm-down"
          data-tooltip-id="md-tip"
          data-tooltip-content={t("settings.perm.moveDown")}
          onClick={() => onMove(rule.id, 1)}
        >
          <ChevronDown size={14} />
        </button>
        <button
          className="perm-del"
          data-testid="perm-delete"
          data-tooltip-id="md-tip"
          data-tooltip-content={t("settings.perm.delete")}
          onClick={() => onRemove(rule.id)}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
