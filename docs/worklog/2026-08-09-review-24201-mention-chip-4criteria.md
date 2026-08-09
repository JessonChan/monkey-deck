# 2026-08-09 · Review #24201 @mention chip name + max-width ellipsis + 目录前缀灰字 + 插入文本不变

## 起因
Task #24215:前端 reviewer 独立复审 #24201(`@mention` 四点显示口径)。#24201 的 coder
落地 commit 是 `84dd914`(单行 CSS `min-width:0`),另 3 点口径此前已在 `Composer.tsx` 落地。
此前已有 #24199 端到端验收;本任务做**独立复核**(从字段定义点逐条追到消费点,不轻信既有结论)。

四点口径:
1. chip 内显 `m.name`(basename,非 path);
2. chip max-width + ellipsis(长名截断);
3. 面板列表项副显目录前缀灰字 + basename(跨目录撞名可区分);
4. 插入文本保持全 path(`@path `,不变)。

## 逐条复核(从定义点追到消费点,对照反模式清单)

| 口径 | 定义 / 消费点 | 结论 |
|---|---|---|
| 1 chip 显 name | `types.ts:135` `Mention{path,name}` 两字段均 required;`Composer.tsx:634` `<span class="att-chip-name"><span class="att-chip-at">@</span>{m.name}</span>` —— 消费 `m.name` | ✓ 显 basename |
| 2 chip ellipsis | `index.css:1078` `.att-chip{display:inline-flex;max-width:220px}`;`index.css:1081` `.att-chip-name{overflow:hidden;text-overflow:ellipsis;...;min-width:0}` | ✓ `min-width:0` 是 flexbox ellipsis 经典坑正解 |
| 3 列表项目录前缀 | `Composer.tsx:586` `dirPrefix = path.slice(0, len-nameLen)`;`597` `<span class="mention-dir">{dirPrefix}</span>`(dim);`598` `{n.name}`(正常色);`index.css:1062` `.mention-dir{color:var(--text-3)}` | ✓ src/foo.ts vs lib/foo.ts 可区分 |
| 4 插入全 path | `Composer.tsx:319` `const token = "@" + node.path + " "`;`321` 拼接进 value | ✓ 全 path + 尾随空格 |

### 口径 2 根因复核
`.att-chip` 是 `inline-flex`,`.att-chip-name` 是其 flex 子项,默认 `min-width:auto`(= 内容固有
宽度)拒绝缩到内容宽以下 → 即便有 `overflow:hidden`+`text-overflow:ellipsis`,子项盒子仍是完整
内容宽,内部不产生 overflow,ellipsis 不触发。`min-width:0` 放开 auto 地板 → 名字盒子可压缩 →
ellipsis 生效。标准修法。落在**共用 class** `.att-chip-name`(paperclip/mention/image/audio 四类
chip 共用),四类长名都受益 —— 修在机制定义处,非夹带(§6.2)。chip 内 `.att-chip-x`(关闭按钮)
无 min-width:0,保持固有宽度不被压缩,行为正确(名字让位、按钮不变)。

## 类型 / 全链路对齐(对照「类型补丁反模式」)
- **Go `FileNode`**(`internal/fsview/fsview.go:23`):`{Name, Path, IsDir, Size}`(`Size` 带 omitempty),
  `Name` 恒为 `filepath.Base(...)`(非空)。
- **TS bindings**(`frontend/bindings/.../fsview/models.js`,本次 `wails3 generate bindings` 生成):
  `{name, path, isDir, size?}`,字段名与 Go json tag 一一对齐。
- **`Mention`**(`types.ts:135`){path, name} 两字段均 required(non-optional);`pickMention`
  (`Composer.tsx:324`)构造 `{path:node.path, name:node.name}` 两字段都填。**无悬挂字段、无 optional 误用。**
- **`dirPrefix`**(`Composer.tsx:586`):局部计算、同处消费(L597),无跨层泄漏。

**无类型补丁反模式**:每个字段(name/path/dirPrefix)从定义点追到消费点都有真实消费。

## 回归保护(断言锚值,非字段存在)
| 口径 | 测试 | 锚定 |
|---|---|---|
| 1 | `Composer.mount.test.tsx:316-331`(describe「chip shows name, not path」) | `textContent` == `"@foo.ts"`、`not contain "src/deep/nested/"`、`title` == `"@src/deep/nested/foo.ts"` |
| 2 | (无 jsdom 测试) | jsdom/happy-dom 不做布局,ellipsis 是否画出不可信断言 —— 与 #24201 一致,靠标准修法 + 代码审查背书 |
| 3 | `Composer.mount.test.tsx:279-282` | `mention-dir` == `"src/"`/`"lib/"`、`mention-path` == `"src/foo.ts"`/`"lib/foo.ts"` |
| 4 | `Composer.mount.test.tsx:440` | 插入文本 == `"@src/foo.ts "`(全 path + 尾随空格) |

口径 1/3/4 全部锚定**值**;口径 2 不加不可信断言(正确取舍)。

## §4.4 / §4.5 合规
- **§4.4 不裸露结构化格式**:列表项以「灰字目录前缀 + 正常色 basename」呈现,非 raw JSON;chip 以
  `@name` 呈现、`title` 给全 path 人话引用。✓
- **§4.5 tooltip**:chip 用**原生 `title=`**(`Composer.tsx:633`)而非 react-tooltip,违反 §4.5。但
  这是 `att-chip` 系统整体 pre-existing 问题(四类 chip 一致用 title),**不在本 PR 范围**,留作后续
  统一 follow-up(改就四类一起改,不顺手夹带)。与 #24199 review 一致判定 OUT OF SCOPE。

## 验证
- `wails3 generate bindings`:成功(293 Packages / 19 Models),生成 `frontend/bindings`。
- `cd frontend && bun install` + `bun run build`:`tsc --noEmit` + `vite build` 全绿(仅 chunk >500kB
  旧告警,与本次无关)。
- `bun test --isolate src/components/Composer.mount.test.tsx`:**22 pass / 0 fail**(含 #24202 branch chip
  的 2 个测试,均绿)。Composer 文件本身 0 fail。

## 改了哪些文件
无(本次为独立复核,实现四点口径均已落地且全链路真实消费,无需改动)。

## 结论
**APPROVE #24201。** 四点显示口径全部端到端落地、全链路真实消费,无类型补丁反模式;Go→TS 类型对齐
(FileNode/Mention 字段非空、optional 正确);i18n mention 子树 zh/en 各 3 key 同步
(goUp/goUpTip/drillTip);data-testid 齐全(mention-popover/att-chips/mention-go-up);断言锚值
(非字段存在);构建通过、22 测试 0 回归。CSS `min-width:0` 落在共用 class 是正解,非夹带。

## 下一步 / OUT OF SCOPE
- `att-chip` 原生 `title=` 违反 §4.5(四类 chip 系统性问题),后续统一 follow-up。
- 全量 `bun test` 的 pre-existing fail(ChatView 虚拟化 / happy-dom 布局等环境问题)与本 PR 无关。
