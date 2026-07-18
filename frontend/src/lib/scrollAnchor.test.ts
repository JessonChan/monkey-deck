import { describe, expect, test } from "bun:test";
import { findTopAnchor, type AnchorProbe } from "./scrollAnchor";

// 三条各 100px,top 依次 0/100/200(总高 300)。
const probes: AnchorProbe[] = [
  { id: "a", top: 0, height: 100 },
  { id: "b", top: 100, height: 100 },
  { id: "c", top: 200, height: 100 },
];

describe("findTopAnchor", () => {
  test("空列表 → null", () => {
    expect(findTopAnchor([], 0)).toBeNull();
  });

  test("scrollTop 在首条内 → 首条,off 为条内偏移", () => {
    expect(findTopAnchor(probes, 40)).toEqual({ id: "a", off: 40 });
  });

  test("scrollTop 在中间条内 → 命中该条", () => {
    expect(findTopAnchor(probes, 150)).toEqual({ id: "b", off: 50 });
  });

  test("scrollTop 恰在某条底缘 → 归下一条( bottom 不严格大于 scrollTop )", () => {
    expect(findTopAnchor(probes, 100)).toEqual({ id: "b", off: 0 });
    expect(findTopAnchor(probes, 200)).toEqual({ id: "c", off: 0 });
  });

  test("scrollTop 在顶部 padding 内(小于首条 top)→ 首条,off 为负", () => {
    const padded: AnchorProbe[] = [{ id: "x", top: 22, height: 80 }];
    expect(findTopAnchor(padded, 10)).toEqual({ id: "x", off: -12 });
  });

  test("scrollTop 超过所有条目(贴底溢出)→ 最后一条", () => {
    expect(findTopAnchor(probes, 350)).toEqual({ id: "c", off: 150 });
  });

  test("单条列表任意位置都命中它", () => {
    const one: AnchorProbe[] = [{ id: "only", top: 0, height: 50 }];
    expect(findTopAnchor(one, 0)).toEqual({ id: "only", off: 0 });
    expect(findTopAnchor(one, 999)).toEqual({ id: "only", off: 999 });
  });

  test("存取往返约定:恢复 scrollTop = 条目 top + off(off = scrollTop - top)", () => {
    // 恢复侧(ChatView applyInitialPosition / pinTopOf)依赖此约定,符号写反会偏移 2×off。
    for (const st of [0, 40, 100, 150, 250, 350]) {
      const a = findTopAnchor(probes, st)!;
      const restored = probes.find((p) => p.id === a.id)!.top + a.off;
      expect(restored).toBe(st);
    }
  });
});
