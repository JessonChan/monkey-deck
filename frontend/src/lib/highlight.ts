// 语法高亮封装(Task #15088)。
// 唯一对外能力:highlightToLines —— 把源码按行切分成「已高亮的 HTML 片段」,
// 供 CodeViewer 逐行渲染(行号槽 + 内容对齐,§4.4 不裸露技术格式)。
//
// 选型:highlight.js(lib/common,~40 常用语言,成熟、纯 JS、同步快、跨 webview 一致)。
// AGENTS.md §4.6 / §5.3:成熟库优先 + 轻量;highlight.js 是只读高亮的事实标准,
// 无 canvas/GPU 开销,符合桌面长期驻留的轻量约束。项目原本无任何高亮库,故最小引入。
//
// 关键点:跨行的语法块(块注释 / 模板字符串 / 三引号)若按行单独高亮会断裂。
// 这里先对整段文本高亮,再把结果 HTML 按换行切成多段、并「重开未闭合 span」保证每行自洽,
// 故多行 token 的颜色在每行都正确延续(不变量:每行片段都是平衡的 span 嵌套)。
import hljs from "highlight.js/lib/common";

// 扩展名 → highlight.js 语言名(覆盖本项目与常见语言;未命中走 highlightAuto)。
const EXT_LANG: Record<string, string> = {
  go: "go",
  ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", pyw: "python", rb: "ruby", rs: "rust",
  java: "java", kt: "kotlin", kts: "kotlin", scala: "scala",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", fs: "fsharp", php: "php", swift: "swift", dart: "dart",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  json: "json", jsonc: "json", json5: "json",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini",
  xml: "xml", html: "xml", htm: "xml", svg: "xml", vue: "xml",
  css: "css", scss: "scss", sass: "scss", less: "less",
  sql: "sql", graphql: "graphql", gql: "graphql",
  md: "markdown", markdown: "markdown",
  dockerfile: "dockerfile", makefile: "makefile",
  lua: "lua", pl: "perl", pm: "perl", r: "r", R: "r",
  vim: "vim", diff: "diff", patch: "diff",
  proto: "protobuf", gradle: "groovy", groovy: "groovy",
  elm: "elm", ex: "elixir", exs: "elixir", erl: "erlang", clj: "clojure",
  cljs: "clojure", edn: "clojure", hs: "haskell", ml: "ocaml", nim: "nim",
};

// 由文件名(可为纯扩展名或带路径的文件名)推断语言;大小写不敏感。
export function detectLanguage(filename?: string): string | undefined {
  if (!filename) return undefined;
  const base = filename.split("/").pop() || filename;
  const lower = base.toLowerCase();
  if (EXT_LANG[lower]) return EXT_LANG[lower];
  // Dockerfile / Makefile 等无扩展名文件名。
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile" || lower === "gnumakefile") return "makefile";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_LANG[ext];
}

export interface HighlightResult {
  /** 每行对应的高亮 HTML 片段(已平衡 span,可直接 dangerouslySetInnerHTML)。 */
  lines: string[];
  /** 实际命中的语言名(用于头部展示;未命中时为 "" )。 */
  language: string;
}

// 把整段高亮后的 HTML 按换行切成多段;每段重开/收口未闭合 span,保证单行自洽。
// highlight.js 输出是良构的 <span class=…>…</span> 嵌套,故可用「标签 / 文本」二元扫描。
function splitHtmlByLine(html: string): string[] {
  const out: string[] = [];
  let cur = "";
  const open: string[] = [];
  const re = /<[^>]+>|[^<]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tok = m[0];
    if (tok.charCodeAt(0) === 0x3c /* < */) {
      if (tok.charCodeAt(1) === 0x2f /* / */) {
        open.pop();
        cur += tok;
      } else {
        open.push(tok);
        cur += tok;
      }
    } else {
      const parts = tok.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          // 收口当前行:倒序闭合所有未关 span。
          let frag = cur;
          for (let j = open.length - 1; j >= 0; j--) frag += "</span>";
          out.push(frag);
          // 新行:正序重开同样的 span 栈。
          cur = "";
          for (const tag of open) cur += tag;
        }
        cur += parts[i];
      }
    }
  }
  out.push(cur);
  return out;
}

// 对源码做高亮并按行切分。lang 显式优先;否则按 filename 推断;再不行 highlightAuto。
// 解析失败 / 空文本时安全降级(逐行 HTML 转义),绝不抛错打断渲染。
export function highlightToLines(code: string, opts?: { filename?: string; language?: string }): HighlightResult {
  const text = code || "";
  const lang = opts?.language || detectLanguage(opts?.filename);
  try {
    let value: string;
    let usedLang = "";
    if (lang && hljs.getLanguage(lang)) {
      value = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
      usedLang = lang;
    } else {
      const auto = hljs.highlightAuto(text);
      value = auto.value;
      usedLang = auto.language || "";
    }
    return { lines: splitHtmlByLine(value), language: usedLang };
  } catch {
    return { lines: text.split("\n").map(escapeHtml), language: "" };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
