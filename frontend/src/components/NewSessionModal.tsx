import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Harness } from "../../bindings/github.com/jessonchan/monkey-deck/internal/harness/models";
import type { BranchInfo, WorktreeInfo } from "../../bindings/github.com/jessonchan/monkey-deck/internal/worktree/models";
import HarnessIcon from "./HarnessIcon";

// What the modal hands back on confirm. mode drives which backend create path App.tsx uses:
//   "project" → CreateSession(useWorktree=false)   — run in the project's main worktree.
//   "enter"   → CreateGuestSession(enterPath)      — pin to an EXISTING linked worktree (guest).
//   "new"     → CreateSession(useWorktree=true, baseRef) — fork a fresh md/<id> worktree (owner).
export type NewSessionChoice = {
  harness: string;
  mode: "project" | "enter" | "new";
  baseRef?: string;   // mode="new": base branch to fork from
  enterPath?: string; // mode="enter": existing linked worktree path
};

interface Props {
  harnesses: Harness[];
  isGit: boolean;
  lastHarness: string;
  // Detected repo default branch (origin/HEAD → main/master) from ResolveBaseRefDefault.
  // Pinned to the top of the base-ref selector as the "Default branch" group + starred. Empty
  // = detection failed (group omitted; user still picks from recent + all). mode="new" only.
  defaultBaseRef: string;
  // This project's recently-used base branches (most-recent-first) for the "Recently used"
  // group. mode="new" only.
  recentRefs: string[];
  branches: BranchInfo[];     // one-shot local+remote branch list (mode="new" selector)
  worktrees: WorktreeInfo[];  // git worktree list (mode="existing" selector): main + linked
  onConfirm: (choice: NewSessionChoice) => void;
  onCancel: () => void;
}

// A branch row enriched with a formatted date string for display.
type DecoratedBranch = BranchInfo & { dateStr: string };

// New-chat modal: pick 1) agent harness 2) working-directory mode:
//   - "使用已有工作目录" (existing): pick an existing worktree — the project main dir (→ project)
//     or a linked worktree (→ guest, multiple sessions can share it, e.g. two agents reviewing).
//   - "新建独立 worktree" (new): fork a fresh md/<id> branch off a chosen base (→ owner).
// harness + workdir mode both require an explicit choice (null = unselected); each mode then
// requires its own explicit pick (a directory / a base branch) — nothing is pre-selected
// (pre-selection caused wrong-base mistakes). Non-git projects hide the workdir choice.
export default function NewSessionModal({ harnesses, isGit, lastHarness, defaultBaseRef, recentRefs, branches, worktrees, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  // harness 必须显式选择:null = 未选。lastHarness 仍可选时默认选它;单 harness 无歧义自动选;否则 null。
  const [harness, setHarness] = useState<string | null>(() => {
    if (lastHarness && harnesses.some((h) => h.id === lastHarness)) return lastHarness;
    if (harnesses.length === 1) return harnesses[0].id;
    return null;
  });
  // workdir mode: null = unselected, "existing" = use an existing worktree, "new" = fork a new one.
  const [mode, setMode] = useState<"existing" | "new" | null>(null);
  // Existing-worktree pick (mode="existing"): null = not picked yet. IsMain → project; else → guest.
  const [existingDir, setExistingDir] = useState<WorktreeInfo | null>(null);
  // Base branch (mode="new"): required, not pre-selected.
  const [baseRef, setBaseRef] = useState<string>("");
  // base-ref selector dropdown state.
  const [refOpen, setRefOpen] = useState(false);
  const [refQuery, setRefQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "local" | "remote">("all");
  // existing-worktree selector dropdown state.
  const [wtOpen, setWtOpen] = useState(false);
  const [wtQuery, setWtQuery] = useState("");

  // Group the branch list into three ordered sections (each branch appears once):
  //   1. Default — detected repo default (defaultBaseRef), starred.
  //   2. Recently used — recentRefs order, excluding the default.
  //   3. All — the rest, in backend committerdate-desc order.
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

    let defaultItem: DecoratedBranch | null = null;
    const db = defaultBaseRef ? byName.get(defaultBaseRef) : undefined;
    if (db && matches(db)) {
      defaultItem = decorate(db);
      used.add(db.name);
    }
    const recentItems: DecoratedBranch[] = [];
    for (const name of recentRefs) {
      const b = byName.get(name);
      if (b && !used.has(b.name) && matches(b)) {
        recentItems.push(decorate(b));
        used.add(b.name);
      }
    }
    const restItems = branches.filter((b) => !used.has(b.name) && matches(b)).map(decorate);
    return { defaultItem, recentItems, restItems };
  }, [branches, refQuery, kindFilter, defaultBaseRef, recentRefs]);

  // Existing-worktree selector: filter by query (branch or path substring); main first, then
  // linked. Empty groups hidden.
  const wtGrouped = useMemo(() => {
    const q = wtQuery.trim().toLowerCase();
    const matches = (w: WorktreeInfo) => !q || w.branch.toLowerCase().includes(q) || w.path.toLowerCase().includes(q);
    let mainItem: WorktreeInfo | null = null;
    const linked: WorktreeInfo[] = [];
    for (const w of worktrees) {
      if (!matches(w)) continue;
      if (w.isMain && !mainItem) mainItem = w;
      else linked.push(w);
    }
    return { mainItem, linked };
  }, [worktrees, wtQuery]);

  const refBoxRef = useRef<HTMLDivElement>(null);
  const wtBoxRef = useRef<HTMLDivElement>(null);

  // Base-branch quick picks (shown below the trigger — no need to open the dropdown): the
  // detected default (main) + up to 2 recently used; all must still exist in the branch list.
  const branchQuickPicks = useMemo(() => {
    const picks: string[] = [];
    const seen = new Set<string>();
    const push = (name?: string) => {
      if (!name || seen.has(name) || !branches.some((b) => b.name === name)) return;
      seen.add(name);
      picks.push(name);
    };
    push(defaultBaseRef);
    for (const r of recentRefs) { if (picks.length >= 3) break; push(r); }
    return picks;
  }, [defaultBaseRef, recentRefs, branches]);

  // Existing-directory quick picks: project main + up to 2 most-recently-committed linked
  // worktrees (Date = HEAD committerdate from the backend).
  const dirQuickPicks = useMemo(() => {
    const picks: WorktreeInfo[] = [];
    const mainW = worktrees.find((w) => w.isMain);
    if (mainW) picks.push(mainW);
    const linked = worktrees.filter((w) => !w.isMain).sort((a, b) => b.date - a.date);
    for (const w of linked) { if (picks.length >= 3) break; picks.push(w); }
    return picks;
  }, [worktrees]);

  // Collapse an open dropdown on outside click. The modal itself stays open (no overlay
  // click-to-close) — only the dropdown list collapses.
  useEffect(() => {
    if (!refOpen && !wtOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (refOpen && refBoxRef.current && !refBoxRef.current.contains(t)) setRefOpen(false);
      if (wtOpen && wtBoxRef.current && !wtBoxRef.current.contains(t)) setWtOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [refOpen, wtOpen]);

  // Esc close (§4.2).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // harness required + (non-git or mode chosen) + mode's own pick required. Nothing pre-selected.
  const canConfirm = harness !== null
    && (!isGit || mode !== null)
    && (mode !== "existing" || existingDir !== null)
    && (mode !== "new" || baseRef !== "");

  const handleConfirm = () => {
    if (harness === null) return;
    if (!isGit) { onConfirm({ harness, mode: "project" }); return; }
    if (mode === "existing" && existingDir) {
      if (existingDir.isMain) onConfirm({ harness, mode: "project" });
      else onConfirm({ harness, mode: "enter", enterPath: existingDir.path });
    } else if (mode === "new" && baseRef) {
      onConfirm({ harness, mode: "new", baseRef });
    }
  };

  // Shorten a long worktree path for the secondary line: keep the last segment (an app
  // worktree's tail is its session id) prefixed with …; full path is in the tooltip (§4.5).
  const shortPath = (p: string): string => {
    const parts = p.split("/");
    return parts.length > 1 ? "…/" + parts[parts.length - 1] : p;
  };

  // Shared base-ref option row. isDefault adds the ★ marker.
  const renderBranchOption = (b: DecoratedBranch, isDefault: boolean) => (
    <button
      key={b.name}
      type="button"
      className={`ns-baseref-option ${baseRef === b.name ? "active" : ""}`}
      data-testid={`ns-base-ref-option-${b.name}`}
      onClick={() => { setBaseRef(b.name); setRefOpen(false); setRefQuery(""); }}
    >
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

  // Shared existing-worktree option row. isMain shows the ★ + "项目主目录" title.
  const renderWtOption = (w: WorktreeInfo, isMain: boolean) => (
    <button
      key={w.path}
      type="button"
      className={`ns-baseref-option ${existingDir?.path === w.path ? "active" : ""}`}
      data-testid={`ns-wt-option-${w.path}`}
      onClick={() => { setExistingDir(w); setWtOpen(false); setWtQuery(""); }}
    >
      <span className="ns-baseref-row1">
        <span className="ns-baseref-name">
          {isMain && <span className="ns-baseref-default">★</span>}
          {isMain ? t("newSession.worktreeMain") : (w.branch || t("newSession.worktreeDetached"))}
        </span>
      </span>
      <span className="ns-baseref-row2">
        {isMain
          ? (w.branch && <span className="ns-baseref-date">{w.branch}</span>)
          : <span className="ns-baseref-date" data-tooltip-id="md-tip" data-tooltip-content={w.path}>{shortPath(w.path)}</span>}
      </span>
    </button>
  );

  return (
    <div className="modal-overlay">
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
              {mode === null && <span className="ns-required">{t("newSession.required")}</span>}
            </div>
            <div className="ns-worktree-group">
              <button
                className={`ns-worktree ${mode === "existing" ? "active" : ""}`}
                onClick={() => setMode("existing")}
                data-testid="ns-worktree-existing"
              >
                <span className={`ns-radio ${mode === "existing" ? "on" : ""}`} />
                <span className="ns-worktree-text">
                  <span className="ns-worktree-title">{t("newSession.existingTitle")}</span>
                  <span className="ns-worktree-desc">{t("newSession.existingDesc")}</span>
                </span>
              </button>
              <button
                className={`ns-worktree ${mode === "new" ? "active" : ""}`}
                onClick={() => setMode("new")}
                data-testid="ns-worktree-new"
              >
                <span className={`ns-radio ${mode === "new" ? "on" : ""}`} />
                <span className="ns-worktree-text">
                  <span className="ns-worktree-title">{t("newSession.worktreeTitle")}</span>
                  <span className="ns-worktree-desc">{t("newSession.worktreeDesc")}</span>
                </span>
              </button>
            </div>
          </div>
        )}

        {isGit && (
          <div className="ns-selector-area" data-testid="ns-selector-area">
            {mode === "existing" && (
          <div className="ns-field">
            <div className="ns-label">
              {t("newSession.existingDir")}
              {existingDir === null && <span className="ns-required">{t("newSession.required")}</span>}
            </div>
            <div className="ns-baseref" ref={wtBoxRef}>
              <button
                type="button"
                className="ns-baseref-trigger"
                data-testid="ns-existing-select"
                onClick={() => { setWtOpen((v) => !v); setWtQuery(""); }}
              >
                {existingDir ? (
                  <span className="ns-baseref-value">
                    {existingDir.isMain && <span className="ns-baseref-default">★</span>}
                    {existingDir.isMain ? t("newSession.worktreeMain") : (existingDir.branch || t("newSession.worktreeDetached"))}
                  </span>
                ) : (
                  <span className="ns-baseref-placeholder">{t("newSession.existingPlaceholder")}</span>
                )}
                <span className="ns-baseref-caret">▾</span>
              </button>
              {wtOpen && (
                <div className="ns-baseref-dropdown" onClick={(e) => e.stopPropagation()}>
                  <div className="ns-baseref-toolbar">
                    <input
                      className="ns-baseref-search"
                      autoFocus
                      placeholder={t("newSession.existingSearch")}
                      value={wtQuery}
                      onChange={(e) => setWtQuery(e.target.value)}
                      data-testid="ns-existing-search"
                    />
                  </div>
                  <div className="ns-baseref-list">
                    {!wtGrouped.mainItem && wtGrouped.linked.length === 0 && (
                      <div className="ns-baseref-empty">{t("newSession.existingEmpty")}</div>
                    )}
                    {wtGrouped.mainItem && (
                      <div className="ns-baseref-group" data-testid="ns-wt-group-main">
                        <div className="ns-baseref-grouphead">{t("newSession.worktreeMain")}</div>
                        {renderWtOption(wtGrouped.mainItem, true)}
                      </div>
                    )}
                    {wtGrouped.linked.length > 0 && (
                      <div className="ns-baseref-group" data-testid="ns-wt-group-linked">
                        <div className="ns-baseref-grouphead">{t("newSession.worktreeLinked")}</div>
                        {wtGrouped.linked.map((w) => renderWtOption(w, false))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            {dirQuickPicks.length > 0 && (
              <div className="ns-quickpicks" data-testid="ns-wt-quickpicks">
                {dirQuickPicks.map((w) => (
                  <button
                    key={w.path}
                    type="button"
                    className={`ns-quickpick ${existingDir?.path === w.path ? "active" : ""}`}
                    data-testid={`ns-wt-quick-${w.path}`}
                    onClick={() => { setExistingDir(w); setWtOpen(false); setWtQuery(""); }}
                  >
                    {w.isMain ? t("newSession.worktreeMain") : (w.branch || t("newSession.worktreeDetached"))}
                  </button>
                ))}
              </div>
            )}
            <div className="ns-baseref-note">
              {existingDir
                ? (existingDir.isMain
                    ? t("newSession.existingNoteMain")
                    : t("newSession.existingNoteGuest", { branch: existingDir.branch || t("newSession.worktreeDetached") }))
                : t("newSession.existingNoteNone")}
            </div>
          </div>
        )}

            {mode === "new" && (
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
            <div className="ns-baseref" ref={refBoxRef}>
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
                        {renderBranchOption(grouped.defaultItem, true)}
                      </div>
                    )}
                    {grouped.recentItems.length > 0 && (
                      <div className="ns-baseref-group" data-testid="ns-base-ref-group-recent">
                        <div className="ns-baseref-grouphead">{t("newSession.baseRefGroupRecent")}</div>
                        {grouped.recentItems.map((b) => renderBranchOption(b, false))}
                      </div>
                    )}
                    {grouped.restItems.length > 0 && (
                      <div className="ns-baseref-group" data-testid="ns-base-ref-group-all">
                        <div className="ns-baseref-grouphead">{t("newSession.baseRefGroupAll")}</div>
                        {grouped.restItems.map((b) => renderBranchOption(b, false))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            {branchQuickPicks.length > 0 && (
              <div className="ns-quickpicks" data-testid="ns-base-ref-quickpicks">
                {branchQuickPicks.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={`ns-quickpick ${baseRef === name ? "active" : ""}`}
                    data-testid={`ns-base-ref-quick-${name}`}
                    onClick={() => { setBaseRef(name); setRefOpen(false); setRefQuery(""); }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
            <div className="ns-baseref-note">
              {t("newSession.baseRefNote", { branch: baseRef || t("newSession.baseRefUnselected") })}
            </div>
          </div>
        )}
            {mode === null && (
              <div className="ns-selector-placeholder">{t("newSession.selectModeHint")}</div>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button className="modal-btn ghost" onClick={onCancel}>{t("common.cancel")}</button>
          <button
            className="modal-btn primary"
            disabled={!canConfirm}
            onClick={handleConfirm}
            data-testid="ns-confirm"
          >
            {t("newSession.createBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}
