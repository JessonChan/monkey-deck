// 消息列表虚拟化核心(§5.1:纯函数层,可注入 mock 单测,不碰 DOM)。
//
// 背景:content-visibility 只跳过屏外渲染,DOM 节点与内存仍随消息数线性增长
// (docs/worklog/2026-07-02-content-visibility-render-opt.md 的遗留短板,issue #33)。
// 此前 react-virtuoso / 自实现虚拟化两次失败(同 worklog),根因:
//   1. 贴底判断寄托在库的黑盒回调(atBottomStateChange 恒 false);
//   2. 动态高度无持久模型,测一个跳一个(totalHeight 抖动 → 滚动条跳)。
// 本模块把这两点反过来做:
//   - 高度 = 持久 Map(实测覆盖先验)+ 类型先验,变化是 Map 上的一次 set,可预期可补偿;
//   - 贴底/锚点/窗口全是本模块的算术不变量,不依赖任何外部回调状态。
//
// 五个不变量(ChatView 只消费这些,不再读 el.scrollHeight):
//   W 窗口:渲染集 = 与 [scrollTop-overscan, scrollTop+viewport+overscan] 相交的条目(前缀和二分);
//   S 贴底:stick ⟺ total - scrollTop - clientHeight ≤ STICK_THRESHOLD,stick 期间内容增长即重对齐到底;
//   A 锚点:位置 = (iid, off),off = scrollTop - top(iid);锚点上方条目变高 → scrollTop += Δh 补偿;
//   P 前插:loadMore 后 scrollTop += Σ h(新条目),视觉位置不动;
//   M 测量:ResizeObserver 只写 measured Map(实测永远覆盖先验),bump version 触发重算。

import type { ChatItem } from "../types";

/** 贴底判定阈值(px):距底部 ≤ 该值视为贴底,与 ChatView 历史行为一致。 */
export const STICK_THRESHOLD = 80;

/**
 * 类型先验高度(px):未实测条目按此估算。
 * 取真实会话实测分布的 P50 定标(见 docs/worklog/2026-07-22-virtual-message-list.md);
 * 定标前为保守初值——先验偏差只影响滚动条比例与窗口边界,实测后自动收敛,不致滚动跳变
 * (实测覆盖先验时走 A 的 Δh 补偿,见 HeightModel.set)。
 */
export const PRIOR_HEIGHT: Record<ChatItem["type"], number> = {
  user: 45,
  agent: 90,
  thought: 48,
  tool: 56,
  plan: 120,
};

/** 尾部区(加载更多/权限卡/实时 plan/打字指示)未实测前的估算高度(px);实测后覆盖。 */
export const TAIL_PRIOR = 60;
/** 顶部留白(px):与 .chat-body 的 padding-top 一致,使布局坐标与 scrollTop 同系。 */
export const HEAD_PRIOR = 22;

/** 渲染行(虚拟化单元):连续 tool 折叠成组后的一行,与 ChatView 的 .cv-item 一一对应。 */
export interface VRow {
  id: string; // 首条 item 的 id = data-iid 锚点键
  kind: ChatItem["type"]; // 组内首条的类型(决定先验高度)
  first: number; // items 区间 [first, last)
  last: number;
}

/** 把 items 折叠成渲染行:2 个以上连续 tool 合并为一行(与 ChatView ToolGroup 规则一致)。 */
export function buildRows(items: ChatItem[]): VRow[] {
  const rows: VRow[] = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it.type === "tool") {
      let j = i + 1;
      while (j < items.length && items[j].type === "tool") j++;
      rows.push({ id: it.id, kind: "tool", first: i, last: j });
      i = j;
    } else {
      rows.push({ id: it.id, kind: it.type, first: i, last: i + 1 });
      i++;
    }
  }
  return rows;
}

/**
 * 高度模型:实测 Map + 动态类型先验。所有消费方(窗口/贴底/锚点/补偿)的唯一高度事实源。
 *
 * 动态类型先验(核心):虚拟化下窗口外的行永远不在 DOM,无法实测,只能用先验估算。
 * 固定先验(PRIOR_HEIGHT)取全库 P50 定标,但单个 session 的消息高度分布可能远偏 P50
 * (如长 agent 回复真实 250px,先验 90px)→ total 严重偏小 → scrollTop 到不了真底部。
 * 解法:set 时按类型累积样本(均值),h() 未测量行优先用同类型已测量均值,样本不足才用固定先验。
 * 窗口内的实测行越多,类型先验越准,total 越接近真实(R O 收敛后偏差从 ~50% 降到 <5%)。
 *
 * 不变量:实测值一旦写入永远覆盖先验;set 返回是否变化,调用方据此决定是否 bump version。
 */
/** 动态先验生效的最小样本数;不足时退回固定先验(避免 1-2 个样本的噪声)。 */
const MIN_TYPE_SAMPLES = 3;

export class HeightModel {
  private readonly measured = new Map<string, number>();
  // 类型样本:按 row.kind 累积 (sum, count),用于推断同类型未测量行的高度。
  private readonly typeStats = new Map<string, { sum: number; count: number }>();
  private readonly prior: (row: VRow) => number;

  constructor(prior: (row: VRow) => number = (r) => PRIOR_HEIGHT[r.kind] ?? PRIOR_HEIGHT.agent) {
    this.prior = prior;
  }

  h(row: VRow): number {
    const m = this.measured.get(row.id);
    if (m !== undefined) return m;
    // 动态类型先验:同类型已测量行的均值(比固定 P50 准得多);样本不足退回固定先验。
    const stats = this.typeStats.get(row.kind);
    if (stats && stats.count >= MIN_TYPE_SAMPLES) return Math.round(stats.sum / stats.count);
    return this.prior(row);
  }

  /** 写入实测高度;返回 true = 值变化(调用方 bump version 重算)。重复同值不触发。 */
  set(row: VRow, height: number): boolean {
    const rounded = Math.round(height);
    if (rounded <= 0) return false; // 挂载瞬间的 0 高读数无意义,忽略
    const prev = this.measured.get(row.id);
    if (prev === rounded) return false;
    this.measured.set(row.id, rounded);
    // 增量更新类型统计:新行 +1 count、+height sum;已有行高度变化只调 sum。
    let stats = this.typeStats.get(row.kind);
    if (!stats) { stats = { sum: 0, count: 0 }; this.typeStats.set(row.kind, stats); }
    stats.sum += rounded - (prev ?? 0);
    stats.count += prev === undefined ? 1 : 0;
    return true;
  }

  /** 丢弃不在当前行集里的实测值(切 session / 条目消失),防止 Map 无界增长;同步重建类型统计。 */
  prune(liveRows: VRow[]): void {
    const liveIds = new Set(liveRows.map((r) => r.id));
    for (const id of [...this.measured.keys()]) {
      if (!liveIds.has(id)) this.measured.delete(id);
    }
    // 重建类型统计(prune 后 measured 变化,统计必须同步)
    this.typeStats.clear();
    for (const row of liveRows) {
      const h = this.measured.get(row.id);
      if (h !== undefined) {
        let stats = this.typeStats.get(row.kind);
        if (!stats) { stats = { sum: 0, count: 0 }; this.typeStats.set(row.kind, stats); }
        stats.sum += h;
        stats.count++;
      }
    }
  }
}

/**
 * 前缀和布局:tops[i]/heights[i] = 第 i 行顶部偏移/高度,tailTop = 尾部区顶部,total = 内容总高。
 * headPad = 顶部留白(滚动容器 padding 的等价物):所有坐标含 headPad,与 el.scrollTop 同坐标系,
 * 消费方(窗口/贴底/锚点)无需再做偏移换算。
 */
export interface Layout {
  tops: number[];
  heights: number[];
  tailTop: number;
  total: number;
}

export function computeLayout(rows: VRow[], model: HeightModel, tailH: number, headPad = 0): Layout {
  const n = rows.length;
  const tops: number[] = new Array(n);
  const heights: number[] = new Array(n);
  let acc = headPad;
  for (let i = 0; i < n; i++) {
    const h = model.h(rows[i]);
    tops[i] = acc;
    heights[i] = h;
    acc += h;
  }
  return { tops, heights, tailTop: acc, total: acc + tailH };
}

/** 窗口计算(W):返回与 [scrollTop-overscan, scrollTop+viewport+overscan] 相交的行区间 [start, end)。 */
export function computeWindow(
  layout: Layout,
  scrollTop: number,
  viewport: number,
  overscan: number
): { start: number; end: number } {
  const n = layout.tops.length;
  if (n === 0) return { start: 0, end: 0 };
  const lo = Math.max(0, scrollTop - overscan);
  const hi = scrollTop + viewport + overscan;
  // start = 首个 bottom > lo 的行(前缀和二分)
  let a = 0;
  let b = n - 1;
  let hit = -1;
  while (a <= b) {
    const m = (a + b) >> 1;
    if (layout.tops[m] + layout.heights[m] > lo) {
      hit = m;
      b = m - 1;
    } else {
      a = m + 1;
    }
  }
  const start = hit === -1 ? n : hit;
  // end = 首个 top >= hi 的行;找不到则到末尾
  let end = n;
  let c = start;
  let d = n - 1;
  while (c <= d) {
    const m = (c + d) >> 1;
    if (layout.tops[m] >= hi) {
      end = m;
      d = m - 1;
    } else {
      c = m + 1;
    }
  }
  return { start, end };
}

/** 贴底判定(S):纯算术,不依赖任何回调。 */
export function isAtBottom(total: number, scrollTop: number, clientHeight: number): boolean {
  return total - scrollTop - clientHeight <= STICK_THRESHOLD;
}

/** 锚点(A):视口顶部命中的行 + 条内偏移。rows 为空返回 null。 */
export function anchorAt(layout: Layout, scrollTop: number): { index: number; off: number } | null {
  const n = layout.tops.length;
  if (n === 0) return null;
  let lo = 0;
  let hi = n - 1;
  let hit = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (layout.tops[m] + layout.heights[m] > scrollTop) {
      hit = m;
      hi = m - 1;
    } else {
      lo = m + 1;
    }
  }
  const idx = hit === -1 ? n - 1 : hit;
  return { index: idx, off: scrollTop - layout.tops[idx] };
}

/** 由 (iid, off) 恢复 scrollTop;锚点行不在当前行集(如切走丢弃后只剩最新一页)→ null,调用方回退贴底。 */
export function restoreScroll(
  layout: Layout,
  rows: VRow[],
  iid: string,
  off: number
): number | null {
  const idx = rows.findIndex((r) => r.id === iid);
  if (idx === -1) return null;
  return Math.max(0, layout.tops[idx] + off);
}
