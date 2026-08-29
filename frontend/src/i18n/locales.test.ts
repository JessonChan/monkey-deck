// locales.test.ts:zh/en locale key 同步回归。bun test 运行。
//
// 锁定「两份 locale 的 leaf key 集合必须完全一致」不变量——任何只在一侧增删 key
// 都会让另一侧回退到 key 串或空串,UI 出现残缺。起源:Task #23726 删 addIcon* 四条
// key 时靠一次性 node 脚本肉眼比对,此处固化为可重复断言(§5.3 reviewer playbook:
// 把不可重复的人肉验证固化成回归测试)。

import { test, expect } from "bun:test";
import zh from "./locales/zh.json";
import en from "./locales/en.json";

// 递归收集所有 leaf key 路径(用 "." 拼接),叶子 = 非 object 值(null/数组也算叶子)。
function leafPaths(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return prefix ? [prefix] : [];
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.push(...leafPaths(v, path));
  }
  return out.sort();
}

test("zh / en leaf key 集合完全一致(无 zh-only / en-only)", () => {
  const z = leafPaths(zh);
  const e = leafPaths(en);
  const zSet = new Set(z);
  const eSet = new Set(e);
  const zOnly = z.filter((k) => !eSet.has(k));
  const eOnly = e.filter((k) => !zSet.has(k));
  expect(zOnly).toEqual([]);
  expect(eOnly).toEqual([]);
  expect(z.length).toBeGreaterThan(0);
  expect(z.length).toBe(e.length);
});

type ChatLocale = { chat?: { dropMentionTitle?: string } };

test("panel-drag overlay copy pinned (issue #149)", () => {
  expect((zh as ChatLocale).chat?.dropMentionTitle).toBe("释放以 @引用");
  expect((en as ChatLocale).chat?.dropMentionTitle).toBe("Release to @mention");
});
test("已删的 addIcon* key 不复活(regression for Task #23726)", () => {
  const harnessZh = (zh as any).settings?.harness ?? {};
  const harnessEn = (en as any).settings?.harness ?? {};
  for (const k of ["addIconLabel", "addIconPlaceholder", "addIconHint", "addIconTip"]) {
    expect(k in harnessZh).toBe(false);
    expect(k in harnessEn).toBe(false);
  }
});
