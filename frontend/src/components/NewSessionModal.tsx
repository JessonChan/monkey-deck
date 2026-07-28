import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Harness } from "../../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";
import type { BranchInfo } from "../../bindings/github.com/jessonchan/monkey-deck/internal/worktree/models";
import HarnessIcon from "./HarnessIcon";

interface Props {
  harnesses: Harness[];
  isGit: boolean;
  lastHarness: string;
  // 基线预选:App 打开 modal 时预取 ResolveBaseRefDefault。空 = 探测失败(必选);非空 = 预选 + 星标。
  defaultBaseRef: string;
  branches: BranchInfo[];  // 一次性拉取的分支列表(供选择器前端过滤)
  onConfirm: (harness: string, useWorktree: boolean, baseRef: string) => void;
  onCancel: () => void;
}

// 新建对话弹窗:让用户选择 1) 使用的 agent harness(omp/opencode)2) 是否新建独立分支(worktree)
// 3) worktree 时选基线分支(显式基线,绝不回退 HEAD,todo/worktree-base-ref-selection.md §2)。
// harness 决定 spawn 哪个 ACP agent;worktree 决定是否建独立 git 工作树(并行隔离,§1.4);
// baseRef 是 worktree 的起点 + 合并的终点(从哪 checkout 就合回哪,对称)。
// harness/worktree 都要求显式选择(null = 未选);worktree=true 时 baseRef 必选(探测到则预选)。
// 非 git 项目不展示 worktree 选项(无法建分支)。
export default function NewSessionModal({ harnesses, isGit, lastHarness, defaultBaseRef, branches, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  // harness 必须显式选择:null = 未选。lastHarness 仍可选时默认选它;单 harness 无歧义自动选;否则 null。
  const [harness, setHarness] = useState<string | null>(() => {
    if (lastHarness && harnesses.some((h) => h.id === lastHarness)) return lastHarness;
    if (harnesses.length === 1) return harnesses[0].id;
    return null;
  });
  // worktree 必须显式选择:null = 未选(默认),true = 新建,false = 使用项目目录。
  const [worktree, setWorktree] = useState<boolean | null>(isGit ? null : false);
  // 基线分支:worktree=true 时必选。初始 = 预选(App 预取探测结果):非空预选(常见情况一键创建),
  // 空 = 探测失败(必选,「新建」禁用)。切回「共享目录」时保留值不重置(再切回来还在)。
  const [baseRef, setBaseRef] = useState<string>(defaultBaseRef);
  const [refOpen, setRefOpen] = useState(false);      // 选择器下拉开关
  const [refQuery, setRefQuery] = useState("");        // 搜索过滤词
  const [kindFilter, setKindFilter] = useState<"all" | "local" | "remote">("all");  // 本地/远程过滤

  // 前端过滤分支列表 + 日期格式化(本地仓库够用,KISS:一次性拉取 + 内存处理,无 debounced 搜索)。
  // 两维过滤:名称模糊(搜索词)+ kind(本地/远程 tab)。后端已按 committerdate 倒序,过滤保序。
  // dateStr:unix 秒 → 同年省年、带时分秒(MM-DD HH:MM 或 YYYY-MM-DD HH:MM),按本地时区。
  const filteredBranches = useMemo(() => {
    const q = refQuery.trim().toLowerCase();
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const fmt = (ts: number): string => {
      if (!ts) return "";
      const d = new Date(ts * 1000);
      const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`;
    };
    return branches.filter((b) => {
      if (kindFilter !== "all" && b.kind !== kindFilter) return false;
      if (q && !b.name.toLowerCase().includes(q)) return false;
      return true;
    }).map((b) => ({ ...b, dateStr: fmt(b.date) })).sort((a, b) => {
      // 默认分支(上次选择或探测到的 main)钉在列表第一,忽略日期排序:
      // main 常是最旧的但几乎总是想要的;上次选择是用户意图,最可信。其余按原日期序(filter 保序)。
      if (a.name === defaultBaseRef) return -1;
      if (b.name === defaultBaseRef) return 1;
      return 0;
    });
  }, [branches, refQuery, kindFilter, defaultBaseRef]);

  // Esc 关闭(§4.2)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // harness 必选 + (非 git 或 worktree 已选)+ worktree=true 时 baseRef 必选;否则禁用「新建」。
  const canConfirm = harness !== null && (!isGit || worktree !== null) && (worktree !== true || baseRef !== "");

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card new-session-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{t("newSession.title")}</div>

        <div className="ns-field">
          <div className="ns-label">
            {t("newSession.selectAgent")}
            {harness === null && <span className="ns-required">{t("newSession.required")}</span>}
          </div>
          <div className="ns-harness-list">
            {harnesses.map((h) => (
              <button
                key={h.id}
                className={`ns-harness ${harness === h.id ? "active" : ""}`}
                onClick={() => setHarness(h.id)}
                data-testid={`ns-harness-${h.id}`}
              >
                <span className={`ns-radio ${harness === h.id ? "on" : ""}`} />
                <HarnessIcon harnessId={h.id} size={16} className="ns-harness-icon" />
                <span className="ns-harness-name">{h.name}</span>
                <span className="ns-harness-cmd" data-tooltip-id="md-tip" data-tooltip-content={h.command}>{h.command}</span>
              </button>
            ))}
          </div>
        </div>

        {isGit && (
          <div className="ns-field">
            <div className="ns-label">
              {t("newSession.workdir")}
              {worktree === null && <span className="ns-required">{t("newSession.required")}</span>}
            </div>
            <div className="ns-worktree-group">
              <button
                className={`ns-worktree ${worktree === false ? "active" : ""}`}
                onClick={() => setWorktree(false)}
                data-testid="ns-worktree-share"
              >
                <span className={`ns-radio ${worktree === false ? "on" : ""}`} />
                <span className="ns-worktree-text">
                  <span className="ns-worktree-title">{t("newSession.shareTitle")}</span>
                  <span className="ns-worktree-desc">
                    {t("newSession.shareDesc")}
                  </span>
                </span>
              </button>
              <button
                className={`ns-worktree ${worktree === true ? "active" : ""}`}
                onClick={() => setWorktree(true)}
                data-testid="ns-worktree-new"
              >
                <span className={`ns-radio ${worktree === true ? "on" : ""}`} />
                <span className="ns-worktree-text">
                  <span className="ns-worktree-title">{t("newSession.worktreeTitle")}</span>
                  <span className="ns-worktree-desc">
                    {t("newSession.worktreeDesc")}
                  </span>
                </span>
              </button>
            </div>
          </div>
        )}

        {isGit && worktree === true && (
          <div className="ns-field">
            <div className="ns-label">
              {t("newSession.baseRef")}
              {baseRef === "" && <span className="ns-required">{t("newSession.required")}</span>}
              <span
                className="ns-label-hint"
                data-tooltip-id="md-tip"
                data-tooltip-content={t("newSession.baseRefTip")}
              >
                ?
              </span>
            </div>
            <div className="ns-baseref">
              <button
                type="button"
                className="ns-baseref-trigger"
                data-testid="ns-base-ref-select"
                onClick={() => { setRefOpen((v) => !v); setRefQuery(""); }}
              >
                {baseRef ? (
                  <span className="ns-baseref-value">
                    {defaultBaseRef === baseRef && <span className="ns-baseref-default">★</span>}
                    {baseRef}
                  </span>
                ) : (
                  <span className="ns-baseref-placeholder">{t("newSession.baseRefPlaceholder")}</span>
                )}
                <span className="ns-baseref-caret">▾</span>
              </button>
              {refOpen && (
                <div className="ns-baseref-dropdown" onClick={(e) => e.stopPropagation()}>
                  <div className="ns-baseref-toolbar">
                    <input
                      className="ns-baseref-search"
                      autoFocus
                      placeholder={t("newSession.baseRefSearch")}
                      value={refQuery}
                      onChange={(e) => setRefQuery(e.target.value)}
                      data-testid="ns-base-ref-search"
                    />
                    {/* 本地/远程 filter:紧凑 chip 组,搜索框右侧,不占额外行高(空间小,KISS) */}
                    <div className="ns-baseref-filters" data-testid="ns-base-ref-filter">
                      {(["all", "local", "remote"] as const).map((k) => (
                        <button
                          key={k}
                          type="button"
                          className={`ns-baseref-filter ${kindFilter === k ? "active" : ""}`}
                          onClick={() => setKindFilter(k)}
                          data-testid={`ns-base-ref-filter-${k}`}
                        >
                          {t(`newSession.baseRefFilter${k.charAt(0).toUpperCase() + k.slice(1)}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="ns-baseref-list">
                    {filteredBranches.length === 0 && (
                      <div className="ns-baseref-empty">{t("newSession.baseRefEmpty")}</div>
                    )}
                    {filteredBranches.map((b) => (
                      <button
                        key={b.name}
                        type="button"
                        className={`ns-baseref-option ${baseRef === b.name ? "active" : ""}`}
                        data-testid={`ns-base-ref-option-${b.name}`}
                        onClick={() => { setBaseRef(b.name); setRefOpen(false); setRefQuery(""); }}
                      >
                        {/* 双行布局:第一行分支名(省空间给名字),第二行日期+kind 副信息(灰小字) */}
                        <span className="ns-baseref-row1">
                          <span className="ns-baseref-name">
                            {defaultBaseRef === b.name && <span className="ns-baseref-default">★</span>}
                            {b.name}
                          </span>
                        </span>
                        <span className="ns-baseref-row2">
                          {b.dateStr && <span className="ns-baseref-date">{b.dateStr}</span>}
                          <span className={`ns-baseref-kind kind-${b.kind}`}>{b.kind === "local" ? t("newSession.baseRefLocal") : t("newSession.baseRefRemote")}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="ns-baseref-note">
              {t("newSession.baseRefNote", { branch: baseRef || t("newSession.baseRefUnselected") })}
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="modal-btn ghost" onClick={onCancel}>{t("common.cancel")}</button>
          <button
            className="modal-btn primary"
            disabled={!canConfirm}
            onClick={() => harness !== null && onConfirm(harness, worktree === true, baseRef)}
            data-testid="ns-confirm"
          >
            {t("newSession.createBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}
