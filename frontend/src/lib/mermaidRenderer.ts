// Mermaid 渲染封装(Task #21289):动态加载 mermaid + hash 缓存 SVG + 主题同步。
//
// 设计要点(AGENTS.md §4.6 / §5.3):
// - 成熟库优先:mermaid 是事实标准,直接用;不自己造轮子。
// - 动态加载:mermaid 体积大(~500KB),只在首次出现 mermaid 代码块时 `import("mermaid")`,
//   之后模块级 Promise 缓存复用,避免污染首屏。
// - hash 缓存:相同源码 → 相同 SVG(模块级 Map,跨组件实例 / 滚动虚拟化复用)。
//   主题进入 key:主题切换时旧 SVG 失效需重渲(颜色已烤进 SVG)。
// - 主题同步:不耦合具体主题实现,读 documentElement data-theme → 退化为按 body 实际背景亮度判定
//   → 兜底 dark(当前应用是深色)。后续若加主题切换,只要改 data-theme 或 body 背景即可联动。
// - 失败不抛:返回 { error } 由调用方走回退 UI(显示源码 + 提示)。

export type MermaidTheme = "dark" | "light";

export type MermaidRenderResult =
  | { ok: true; svg: string; diagramType?: string; bindFunctions?: (element: Element) => void }
  | { ok: false; error: string };

// 模块级单例:动态加载 + initialize 一次。
let mermaidPromise: Promise<unknown> | null = null;
// 模块级 SVG 缓存:key = `${theme}:${hash}`,value = SVG 字符串。
// 仅缓存 SVG 文本;bindFunctions 不可序列化,但已注入 SVG 的事件绑定大多是
// mermaid 内部交互(tab 可访问性等),即便不重绑也能正常展示,故接受重复渲染时重绑一次。
const svgCache = new Map<string, string>();
// 渲染 ID 计数器:mermaid.render 需要全局唯一的临时 DOM id。
let renderSeq = 0;

// djb2 字符串 hash → base36。够快、够散列,无密码学需求。
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

// 当前应使用的 mermaid 主题。
// 1) documentElement.dataset.theme 显式标注优先(未来主题切换入口);
// 2) 否则按 body 实际计算背景亮度判定(与 CSS 主题实现解耦);
// 3) 兜底 dark(本应用目前固定深色,见 index.css :root)。
export function currentMermaidTheme(): MermaidTheme {
  try {
    const attr = document.documentElement.dataset.theme;
    if (attr === "light" || attr === "dark") return attr;
    const bg = getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const parts = m[1].split(",").map((s) => parseFloat(s));
      const [r, g, b] = parts;
      if ([r, g, b].every((n) => Number.isFinite(n))) {
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return luminance < 0.5 ? "dark" : "light";
      }
    }
  } catch {
    // 非浏览器环境(SSR / 测试)→ 兜底
  }
  return "dark";
}

// 加载 mermaid 并按主题 initialize(每次主题变化重新 initialize 以同步 themeVariables)。
// 维护「已 initialize 的主题」,主题未变则跳过 initialize。
let initializedTheme: MermaidTheme | null = null;

async function ensureMermaid(theme: MermaidTheme): Promise<{
  render: (id: string, text: string) => Promise<{ svg: string; diagramType?: string; bindFunctions?: (el: Element) => void }>;
}> {
  if (!mermaidPromise) {
    // 动态 import:首次出现 mermaid 代码块才加载,避免拖累首屏。
    mermaidPromise = import("mermaid");
  }
  const mod = (await mermaidPromise) as {
    default: {
      initialize: (config: unknown) => void;
      render: (id: string, text: string) => Promise<{
        svg: string;
        diagramType?: string;
        bindFunctions?: (el: Element) => void;
      }>;
    };
  };
  const mermaid = mod.default;
  if (initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme,
      // 仅 dark 显式给一组与 UI 协调的强调色;light 走 mermaid 默认。
      themeVariables: theme === "dark" ? darkThemeVariables : undefined,
    });
    initializedTheme = theme;
  }
  return mermaid;
}

// 与应用 accent / 文字层级协调的 dark 主题变量(参考 index.css 的 --accent / --text 等)。
const darkThemeVariables = {
  background: "#1e1e1e",
  primaryColor: "#333336",
  primaryTextColor: "#f5f5f7",
  primaryBorderColor: "#0a84ff",
  lineColor: "#98989d",
  secondaryColor: "#2c2c2e",
  tertiaryColor: "#1b1b1d",
  textColor: "#f5f5f7",
  // sequence / gantt 等用到 mainBsp / nodeBorder 等,留默认即可。
};

// 渲染入口:成功 → { ok, svg };失败 → { ok: false, error }。
// 命中缓存(按 theme + hash)直接返回 SVG(bindFunctions 缺失可接受,见 svgCache 注释)。
export async function renderMermaid(code: string): Promise<MermaidRenderResult> {
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, error: "empty" };
  const theme = currentMermaidTheme();
  const key = `${theme}:${hashString(trimmed)}`;

  const cached = svgCache.get(key);
  if (cached) return { ok: true, svg: cached };

  try {
    const mermaid = await ensureMermaid(theme);
    const id = `mmd-${renderSeq++}`;
    const { svg, bindFunctions, diagramType } = await mermaid.render(id, trimmed);
    svgCache.set(key, svg);
    // 缓存大小软上限(防极端场景 OOM):LRU 语义过于重量,这里用「超限则清空最早一半」的简单策略。
    if (svgCache.size > 200) {
      const firstKey = svgCache.keys().next().value;
      if (firstKey) svgCache.delete(firstKey);
    }
    return { ok: true, svg, diagramType, bindFunctions };
  } catch (err) {
    // mermaid 解析/渲染失败:不抛,把错误文案传出去供 UI 回退展示。
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// 仅供测试用:清空缓存与单例。
export function __resetMermaidCacheForTest(): void {
  svgCache.clear();
  mermaidPromise = null;
  initializedTheme = null;
}
