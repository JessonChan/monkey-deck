import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Harness } from "../../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";
import type { BranchInfo } from "../../bindings/github.com/jessonchan/monkey-deck/internal/worktree/models";
import HarnessIcon from "./HarnessIcon";

interface Props {
  harnesses: Harness[];
  isGit: boolean;
  lastHarness: string;
  // Detected repo default branch (origin/HEAD → main/master) from ResolveBaseRefDefault.
  // Pinned to the top of the selector as the "Default branch" group + starred. Empty =
  // detection failed (group is simply omitted; user still picks from recent + all).
  defaultBaseRef: string;
  // This project's recently-used base branches (most-recent-first) for the "Recently
  // used" group. Distinct from defaultBaseRef (a repo property) — these reflect user intent.
  recentRefs: string[];
  branches: BranchInfo[];  // one-shot local+remote list (frontend filtering/grouping)
  onConfirm: (harness: string, useWorktree: boolean, baseRef: string) => void;
  onCancel: () => void;
}

// A branch row enriched with a formatted date string for display.
type DecoratedBranch = BranchInfo & { dateStr: string };

// New-chat modal: pick 1) agent harness (omp/opencode) 2) whether to make an isolated
// worktree 3) when worktree, the base branch (explicit base, never falls back to HEAD —
// todo/worktree-base-ref-selection.md §2). harness picks which ACP agent to spawn;
// worktree picks whether to build an isolated git worktree (parallel isolation, §1.4);
// baseRef is the worktree's start point + merge target (checkout-from = merge-back-to).
// harness/worktree both require an explicit choice (null = unselected); worktree=true
// requires an explicit baseRef (NOT pre-selected — pre-selection caused wrong-base
// mistakes; the most-likely answer is just pinned to the top of the list).
// Non-git projects hide the worktree option (no branches to make).
export default function NewSessionModal({ harnesses, isGit, lastHarness, defaultBaseRef, recentRefs, branches, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  // harness 必须显式选择:null = 未选。lastHarness 仍可选时默认选它;单 harness 无歧义自动选;否则 null。
  const [harness, setHarness] = useState<string | null>(() => {
    if (lastHarness && harnesses.some((h) => h.id === lastHarness)) return lastHarness;
    if (harnesses.length === 1) return harnesses[0].id;
    return null;
  });
  // worktree 必须显式选择:null = 未选(默认),true = 新建,false = 使用项目目录。
  const [worktree, setWorktree] = useState<boolean | null>(isGit ? null : false);
  // Base branch: required when worktree=true. NOT pre-selected — starts empty so the user
  // must pick explicitly (avoids wrong-base mistakes); the selector pins the detected
  // default + recently-used to the top so the right answer is one click away. Value is
  // preserved when toggling back to "shared dir" (so a prior pick survives).
  const [baseRef, setBaseRef] = useState<string>("");
  const [refOpen, setRefOpen] = useState(false);      // 选择器下拉开关
  const [refQuery, setRefQuery] = useState("");        // 搜索过滤词
  const [kindFilter, setKindFilter] = useState<"all" | "local" | "remote">("all");  // 本地/远程过滤

  // Group the branch list into three ordered sections (each branch appears once):
  //   1. Default — detected repo default (defaultBaseRef), starred.
  //   2. Recently used — recentRefs order, excluding the default.
  //   3. All — the rest, in backend committerdate-desc order.
  // Two-axis filter (name substring + local/remote) applies within every group; empty
  // groups are hidden. dateStr: unix s → same-year drops year, with HH:MM, local tz.
  // KISS: one-shot fetch + in-memory grouping, no debounced search (local repos are small).
  const grouped = useMemo(() => {
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
    const matches = (b: BranchInfo) => {
      if (kindFilter !== "all" && b.kind !== kindFilter) return false;
      if (q && !b.name.toLowerCase().includes(q)) return false;
      return true;
    };
    const decorate = (b: BranchInfo): DecoratedBranch => ({ ...b, dateStr: fmt(b.date) });

    const byName = new Map(branches.map((b) => [b.name, b]));
    const used = new Set<string>();

    // 1. Default branch (0 or 1).
    let defaultItem: DecoratedBranch | null = null;
    const db = defaultBaseRef ? byName.get(defaultBaseRef) : undefined;
    if (db && matches(db)) {
      defaultItem = decorate(db);
      used.add(db.name);
    }
    // 2. Recently used, in recency order (recentRefs already most-recent-first), excluding default.
    const recentItems: DecoratedBranch[] = [];
    for (const name of recentRefs) {
      const b = byName.get(name);
      if (b && !used.has(b.name) && matches(b)) {
        recentItems.push(decorate(b));
        used.add(b.name);
      }
    }
    // 3. All others in backend date-desc order (branches is already sorted; filter preserves order).
    const restItems = branches.filter((b) => !used.has(b.name) && matches(b)).map(decorate);

    return { defaultItem, recentItems, restItems };
  }, [branches, refQuery, kindFilter, defaultBaseRef, recentRefs]);

  // Esc 关闭(§4.2)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // harness required + (non-git or worktree chosen) + baseRef required when worktree=true;
  // else disable "Create". baseRef is never pre-selected, so worktree sessions always
  // need an explicit pick.
  const canConfirm = harness !== null && (!isGit || worktree !== null) && (worktree !== true || baseRef !== "");

  // Shared option row for all three groups. isDefault adds the ★ marker.
  const renderOption = (b: DecoratedBranch, isDefault: boolean) => (
    <button
      key={b.name}
      type="button"
      className={`ns-baseref-option ${baseRef === b.name ? "active" : ""}`}
      data-testid={`ns-base-ref-option-${b.name}`}
      onClick={() => { setBaseRef(b.name); setRefOpen(false); setRefQuery(""); }}
    >
      {/* two-row layout: name on row 1, date + kind on row 2 (muted small text) */}
      <span className="ns-baseref-row1">
        <span className="ns-baseref-name">
          {isDefault && <span className="ns-baseref-default">★</span>}
          {b.name}
        </span>
      </span>
      <span className="ns-baseref-row2">
        {b.dateStr && <span className="ns-baseref-date">{b.dateStr}</span>}
        <span className={`ns-baseref-kind kind-${b.kind}`}>{b.kind === "local" ? t("newSession.baseRefLocal") : t("newSession.baseRefRemote")}</span>
      </span>
    </button>
  );

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
                    {!grouped.defaultItem && grouped.recentItems.length === 0 && grouped.restItems.length === 0 && (
                      <div className="ns-baseref-empty">{t("newSession.baseRefEmpty")}</div>
                    )}
                    {grouped.defaultItem && (
                      <div className="ns-baseref-group" data-testid="ns-base-ref-group-default">
                        <div className="ns-baseref-grouphead">{t("newSession.baseRefGroupDefault")}</div>
                        {renderOption(grouped.defaultItem, true)}
                      </div>
                    )}
                    {grouped.recentItems.length > 0 && (
                      <div className="ns-baseref-group" data-testid="ns-base-ref-group-recent">
                        <div className="ns-baseref-grouphead">{t("newSession.baseRefGroupRecent")}</div>
                        {grouped.recentItems.map((b) => renderOption(b, false))}
                      </div>
                    )}
                    {grouped.restItems.length > 0 && (
                      <div className="ns-baseref-group" data-testid="ns-base-ref-group-all">
                        <div className="ns-baseref-grouphead">{t("newSession.baseRefGroupAll")}</div>
                        {grouped.restItems.map((b) => renderOption(b, false))}
                      </div>
                    )}
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
