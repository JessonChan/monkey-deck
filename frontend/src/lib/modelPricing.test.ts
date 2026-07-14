// modelPricing.test.ts:模型定价查找与成本估算(Task #15138)。bun test 运行。
import { test, expect } from "bun:test";
import { lookupModelPricing, estimateSwitchCost } from "./modelPricing";

test("lookupModelPricing exact match", () => {
  const p = lookupModelPricing("anthropic/claude-sonnet-4");
  expect(p).not.toBeNull();
  expect(p!.input).toBe(3);
});

test("lookupModelPricing fuzzy match via versioned suffix", () => {
  const p = lookupModelPricing("anthropic/claude-sonnet-4-20250514");
  expect(p).not.toBeNull();
  expect(p!.output).toBe(15);
});

test("lookupModelPricing returns null for unknown", () => {
  expect(lookupModelPricing("zai/glm-4.6")).toBeNull();
});

test("lookupModelPricing case-insensitive", () => {
  expect(lookupModelPricing("Anthropic/Claude-Sonnet-4")).not.toBeNull();
});

test("estimateSwitchCost null pricing → null", () => {
  expect(estimateSwitchCost(100000, null)).toBeNull();
});

test("estimateSwitchCost zero context → null", () => {
  expect(estimateSwitchCost(0, { input: 3, output: 15 })).toBeNull();
});

test("estimateSwitchCost computes input + estimated output", () => {
  // 100k context, input $3/1M, output $15/1M, output est = 25k
  // cost = 100k/1M*3 + 25k/1M*15 = 0.3 + 0.375 = 0.675
  const cost = estimateSwitchCost(100000, { input: 3, output: 15 });
  expect(cost).not.toBeNull();
  expect(cost!).toBeCloseTo(0.675, 3);
});
