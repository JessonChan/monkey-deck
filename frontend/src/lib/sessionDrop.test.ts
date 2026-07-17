// sessionDrop.test.ts:切走丢弃判定回归(内存优化)。bun test 运行。
// 锁住安全不变量:prompting(流式中)绝不丢;其余空闲态可丢;无旧 session / 同 session 不丢。
import { test, expect } from "bun:test";
import { shouldDropOnSwitch } from "./sessionDrop";

test("空闲(idle)→ 可丢", () => {
  expect(shouldDropOnSwitch("A", "B", "idle")).toBe(true);
});

test("empty / error 视为空闲 → 可丢", () => {
  expect(shouldDropOnSwitch("A", "B", "empty")).toBe(true);
  expect(shouldDropOnSwitch("A", "B", "error")).toBe(true);
});

test("prompting(流式回合进行中)→ 绝不丢(安全不变量)", () => {
  // 丢 prompting session 会丢失正在流入的 SessionUpdate 内容,必须禁止。
  expect(shouldDropOnSwitch("A", "B", "prompting")).toBe(false);
});

test("无旧 session(首次打开)→ 不丢", () => {
  expect(shouldDropOnSwitch(null, "B", "idle")).toBe(false);
});

test("新旧同一 session(重复打开)→ 不丢", () => {
  expect(shouldDropOnSwitch("A", "A", "idle")).toBe(false);
});

test("未知状态默认按可丢处理(只保护已知的 prompting)", () => {
  // 防御:未来若新增状态枚举,除 prompting 外都允许丢——避免新状态意外变成"永不释放"。
  expect(shouldDropOnSwitch("A", "B", "some-future-status")).toBe(true);
});
