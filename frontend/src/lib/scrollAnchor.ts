// 滚动锚点:用「视口顶部命中条目的 id + 条内偏移」表达滚动位置,供切 session 时存/取。
// 为什么不直接记像素 scrollTop:聊天项开了 content-visibility:auto(见 index.css .cv-item),
// 屏外条目按 contain-intrinsic-size 估算高度(未渲染过 = 120px),真实渲染后 scrollHeight 会变,
// 同一视觉位置在不同时间点的像素值不稳定;条目 id 才是稳定坐标(§5.3 找不变量)。
export interface AnchorProbe {
  id: string;
  top: number; // 条目顶部在滚动内容坐标系里的偏移(与 scrollTop 同坐标系)
  height: number;
}

// 找视口顶部(scrollTop)命中的首条:bottom 严格大于 scrollTop 的第一条(probes 按 top 升序)。
// 全部在视口上方(如贴底溢出)时取最后一条。返回 off = scrollTop - 条目 top(可为负:顶部 padding)。
export function findTopAnchor(items: AnchorProbe[], scrollTop: number): { id: string; off: number } | null {
  if (items.length === 0) return null;
  let lo = 0;
  let hi = items.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].top + items[mid].height > scrollTop) {
      hit = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const idx = hit === -1 ? items.length - 1 : hit;
  return { id: items[idx].id, off: scrollTop - items[idx].top };
}
