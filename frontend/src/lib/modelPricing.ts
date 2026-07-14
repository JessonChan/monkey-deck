// modelPricing.ts:目标模型 token 单价估算(Task #15138 模型切换成本提示)。
//
// 定价数据是「尽力而为」快照,非计费依据;无定价的模型返回 null(前端降级为只提示 token 量级)。
// 价格单位:USD / 1M tokens(input/output 各一)。仅收录常见模型,避免维护负担;
// 新增模型按相同结构追加即可。借用思路参考 openwork(references/,MIT)的 model 定价展示。
export interface ModelPricing {
  input: number;   // USD / 1M input tokens
  output: number;  // USD / 1M output tokens
  cachedRead?: number; // USD / 1M cached read tokens(通常为 input 的折扣价)
}

// 按 "provider/model"(小写)匹配。provider 前缀来自 configOption.value。
const PRICING: Record<string, ModelPricing> = {
  // Anthropic
  "anthropic/claude-sonnet-4": { input: 3, output: 15, cachedRead: 0.3 },
  "anthropic/claude-opus-4": { input: 15, output: 75, cachedRead: 1.5 },
  "anthropic/claude-haiku-3.5": { input: 0.8, output: 4, cachedRead: 0.08 },
  // OpenAI
  "openai/gpt-4.1": { input: 2, output: 8, cachedRead: 0.5 },
  "openai/o3": { input: 2, output: 8, cachedRead: 0.5 },
  // Google
  "google/gemini-2.5-pro": { input: 1.25, output: 10 },
};

// lookupModelPricing 按 value("provider/model")查定价;匹配不到返回 null。
// 模糊匹配:value 去掉前缀后与 key 做包含判断(应对版本号/日期后缀)。
export function lookupModelPricing(value: string): ModelPricing | null {
  const v = value.toLowerCase();
  // 精确匹配
  if (PRICING[v]) return PRICING[v];
  // 模糊:key 被 value 包含(如 "zai/glm-4.6" 不命中,"anthropic/claude-sonnet-4-20250514" 命中 sonnet-4)
  for (const key of Object.keys(PRICING)) {
    if (v.includes(key)) return PRICING[key];
  }
  return null;
}

// estimateSwitchCost 估算「以当前上下文继续」的单轮预估成本(USD)。
// 粗估:input = 当前 context tokens(全部作为输入),output 按 input 的 1/4 经验比值估。
// 返回 null 表示无定价数据(前端降级为只提示 token 量级)。
export function estimateSwitchCost(contextTokens: number, pricing: ModelPricing | null): number | null {
  if (!pricing || contextTokens <= 0) return null;
  const inputCost = (contextTokens / 1_000_000) * pricing.input;
  const outputTokens = contextTokens * 0.25;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}
