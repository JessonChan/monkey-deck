import { describe, expect, test } from "bun:test";
import {
  buildRows,
  computeLayout,
  computeWindow,
  anchorAt,
  restoreScroll,
  isAtBottom,
  HeightModel,
  PRIOR_HEIGHT,
  STICK_THRESHOLD,
  type VRow,
} from "./virtualList";
import type { ChatItem } from "../types";

// ─── 测试数据构造 ───
const user = (id: string): ChatItem => ({ type: "user", id, text: "hi" });
const agent = (id: string): ChatItem => ({ type: "agent", id, text: "hello" });
const tool = (id: string): ChatItem => ({ type: "tool", id, title: "t", status: "completed", kind: "bash" });
const thought = (id: string): ChatItem => ({ type: "thought", id, text: "hmm" });

/** 固定高度模型:每行 100px(先验被注入覆盖),便于手算断言。 */
const fixedModel = (h = 100) => new HeightModel(() => h);

/** n 行 × 100px 的布局。 */
const fixedLayout = (n: number, tailH = 0) => computeLayout(
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, kind: "agent", first: i, last: i + 1 }) as VRow),
  fixedModel(),
  tailH
);

describe("buildRows", () => {
  test("空 items → 空行集", () => {
    expect(buildRows([])).toEqual([]);
  });

  test("非 tool 条目各自成行", () => {
    const rows = buildRows([user("u1"), agent("a1"), thought("t1")]);
    expect(rows.map((r) => r.id)).toEqual(["u1", "a1", "t1"]);
    expect(rows.every((r) => r.last - r.first === 1)).toBe(true);
  });

  test("单个 tool 不成组,独立成行", () => {
    const rows = buildRows([user("u1"), tool("t1"), agent("a1")]);
    expect(rows.map((r) => r.id)).toEqual(["u1", "t1", "a1"]);
    expect(rows[1].last - rows[1].first).toBe(1);
  });

  test("2 个以上连续 tool 折叠为一行,id = 组首", () => {
    const rows = buildRows([tool("t1"), tool("t2"), tool("t3"), agent("a1"), tool("t4")]);
    expect(rows.map((r) => r.id)).toEqual(["t1", "a1", "t4"]);
    expect(rows[0].first).toBe(0);
    expect(rows[0].last).toBe(3); // [0,3) = t1..t3
    expect(rows[2].last - rows[2].first).toBe(1); // t4 独立
  });

  test("行集是 items 的无重叠全覆盖(first/last 区间拼接 = [0, n))", () => {
    const items: ChatItem[] = [user("u"), tool("t1"), tool("t2"), agent("a"), tool("t3")];
    const rows = buildRows(items);
    let cursor = 0;
    for (const r of rows) {
      expect(r.first).toBe(cursor);
      expect(r.last).toBeGreaterThan(r.first);
      cursor = r.last;
    }
    expect(cursor).toBe(items.length);
  });
});

describe("HeightModel", () => {
  test("未实测 → 类型先验", () => {
    const m = new HeightModel();
    expect(m.h({ id: "x", kind: "user", first: 0, last: 1 })).toBe(PRIOR_HEIGHT.user);
    expect(m.h({ id: "x", kind: "tool", first: 0, last: 1 })).toBe(PRIOR_HEIGHT.tool);
  });

  test("实测覆盖先验,且持久(再查仍是实测值)", () => {
    const m = new HeightModel();
    const row: VRow = { id: "x", kind: "agent", first: 0, last: 1 };
    expect(m.set("x", 333)).toBe(true);
    expect(m.h(row)).toBe(333);
    expect(m.h(row)).toBe(333);
  });

  test("set 同值不报变化(防无谓 bump);变值报 true", () => {
    const m = new HeightModel();
    expect(m.set("x", 100)).toBe(true);
    expect(m.set("x", 100)).toBe(false);
    expect(m.set("x", 100.4)).toBe(false); // 取整后同值
    expect(m.set("x", 101)).toBe(true);
  });

  test("忽略 0/负高度(挂载瞬间的无效读数)", () => {
    const m = new HeightModel();
    expect(m.set("x", 0)).toBe(false);
    expect(m.set("x", -5)).toBe(false);
    expect(m.h({ id: "x", kind: "agent", first: 0, last: 1 })).toBe(PRIOR_HEIGHT.agent);
  });

  test("prune 只丢不在存活集里的实测值", () => {
    const m = new HeightModel();
    m.set("a", 10);
    m.set("b", 20);
    m.set("c", 30);
    m.prune(new Set(["b"]));
    expect(m.h({ id: "a", kind: "agent", first: 0, last: 1 })).toBe(PRIOR_HEIGHT.agent); // 已丢
    expect(m.h({ id: "b", kind: "agent", first: 0, last: 1 })).toBe(20); // 保留
  });
});

describe("computeLayout", () => {
  test("前缀和:tops 递增,heights 一致,total = Σh + tailH", () => {
    const layout = fixedLayout(3, 40);
    expect(layout.tops).toEqual([0, 100, 200]);
    expect(layout.heights).toEqual([100, 100, 100]);
    expect(layout.tailTop).toBe(300);
    expect(layout.total).toBe(340);
  });

  test("headPad:所有坐标整体下移,total 含留白", () => {
    const layout = computeLayout(
      Array.from({ length: 2 }, (_, i) => ({ id: `r${i}`, kind: "agent", first: i, last: i + 1 }) as VRow),
      fixedModel(),
      40,
      22
    );
    expect(layout.tops).toEqual([22, 122]);
    expect(layout.tailTop).toBe(222);
    expect(layout.total).toBe(262);
  });

  test("空行集 → total = tailH", () => {
    const layout = computeLayout([], fixedModel(), 25);
    expect(layout.total).toBe(25);
    expect(layout.tailTop).toBe(0);
  });

  test("实测高度参与布局(不等高)", () => {
    const m = new HeightModel(() => 50);
    m.set("b", 500);
    const rows: VRow[] = [
      { id: "a", kind: "agent", first: 0, last: 1 },
      { id: "b", kind: "agent", first: 1, last: 2 },
    ];
    const layout = computeLayout(rows, m, 0);
    expect(layout.tops).toEqual([0, 50]);
    expect(layout.total).toBe(550);
  });
});

describe("computeWindow(W 不变量)", () => {
  test("空布局 → 空窗口", () => {
    expect(computeWindow(fixedLayout(0), 0, 500, 200)).toEqual({ start: 0, end: 0 });
  });

  test("顶部:只渲染视口 + overscan 覆盖的行", () => {
    // 100 行 × 100px,viewport 250,overscan 100:scrollTop=0 → 覆盖 [0, 350) → 行 0..3
    const w = computeWindow(fixedLayout(100), 0, 250, 100);
    expect(w.start).toBe(0);
    expect(w.end).toBe(4);
  });

  test("中部:上下 overscan 对称扩展", () => {
    // scrollTop=5000 → 视口 [5000,5250],overscan 100 → [4900,5350) → 行 49..53
    const w = computeWindow(fixedLayout(100), 5000, 250, 100);
    expect(w.start).toBe(49);
    expect(w.end).toBe(54);
  });

  test("底部:end 不越界", () => {
    const w = computeWindow(fixedLayout(10), 900, 500, 100);
    expect(w.end).toBe(10);
    expect(w.start).toBeLessThanOrEqual(9);
  });

  test("性质:窗口恰好 = 与 [scrollTop-overscan, scrollTop+viewport+overscan] 相交的行集", () => {
    // 随机不等高,多轮随机 scrollTop,逐行验证相交性(§5.3 不变量,不堆特例)
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const n = 200;
    const rows: VRow[] = Array.from({ length: n }, (_, i) => ({ id: `r${i}`, kind: "agent", first: i, last: i + 1 }));
    const m = new HeightModel(() => 40);
    for (let i = 0; i < n; i++) m.set(`r${i}`, 20 + Math.floor(rand() * 300));
    const layout = computeLayout(rows, m, 0);
    const viewport = 600;
    const overscan = 150;
    for (let round = 0; round < 30; round++) {
      const scrollTop = Math.floor(rand() * (layout.total + 400));
      const { start, end } = computeWindow(layout, scrollTop, viewport, overscan);
      const lo = Math.max(0, scrollTop - overscan);
      const hi = scrollTop + viewport + overscan;
      for (let i = 0; i < n; i++) {
        const bottom = layout.tops[i] + layout.heights[i];
        const intersects = bottom > lo && layout.tops[i] < hi;
        const inWindow = i >= start && i < end;
        expect(inWindow).toBe(intersects);
      }
    }
  });
});

describe("isAtBottom(S 不变量)", () => {
  test("阈值内 → true(含恰等于阈值)", () => {
    expect(isAtBottom(1000, 920, 0)).toBe(true); // 差 = 80,恰等于阈值
    expect(isAtBottom(1000, 1000, 100)).toBe(true); // 贴死底
  });

  test("超出阈值 → false", () => {
    expect(isAtBottom(1000, 919, 0)).toBe(false); // 差 = 81
  });

  test("内容增长(total 变大)而 scrollTop 不动 → 脱离贴底", () => {
    expect(isAtBottom(1000, 900, 100)).toBe(true);
    expect(isAtBottom(2000, 900, 100)).toBe(false);
  });
});

describe("anchorAt / restoreScroll(A 不变量)", () => {
  test("空布局 → null", () => {
    expect(anchorAt(fixedLayout(0), 0)).toBeNull();
  });

  test("命中视口顶部所在行,off = scrollTop - top", () => {
    expect(anchorAt(fixedLayout(5), 250)).toEqual({ index: 2, off: 50 });
    expect(anchorAt(fixedLayout(5), 200)).toEqual({ index: 2, off: 0 }); // 恰在行边界 → 归下一行
  });

  test("scrollTop 超出全部行(贴底溢出)→ 最后一行", () => {
    expect(anchorAt(fixedLayout(3), 999)).toEqual({ index: 2, off: 799 });
  });

  test("存取往返:restore(top(iid)+off) == 原 scrollTop", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, kind: "agent", first: i, last: i + 1 }));
    const layout = computeLayout(rows, fixedModel(), 0);
    for (const st of [0, 40, 100, 250, 480]) {
      const a = anchorAt(layout, st)!;
      expect(restoreScroll(layout, rows, rows[a.index].id, a.off)).toBe(st);
    }
  });

  test("锚点行不在行集(切走丢弃后重载缺页)→ null,调用方回退贴底", () => {
    const rows = [{ id: "r0", kind: "agent", first: 0, last: 1 }];
    const layout = computeLayout(rows, fixedModel(), 0);
    expect(restoreScroll(layout, rows, "missing", 10)).toBeNull();
  });

  test("锚点上方行变高 → 恢复位随之 +Δh(补偿语义的算术基础)", () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, kind: "agent", first: i, last: i + 1 }));
    const m = fixedModel();
    let layout = computeLayout(rows, m, 0);
    const a = anchorAt(layout, 250)!; // 锚在 r2,off=50
    // r0 长高 60:重算布局后,同一 (iid, off) 恢复到 310 = 250 + 60
    m.set("r0", 160);
    layout = computeLayout(rows, m, 0);
    expect(restoreScroll(layout, rows, rows[a.index].id, a.off)).toBe(310);
  });
});
