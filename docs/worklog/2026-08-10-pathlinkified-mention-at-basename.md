# 2026-08-10 PathLinkified 消息气泡 @mention 显 @filename(#118b, Task #24263)

**起因**:issue #118b —— 用户在 composer 用 `@` 引用文件时,chip 显 `@basename`(完整
路径在 title)。但发送后,消息气泡里的 `@src/foo.ts` 走 `PathLinkified` 仍**显完整原始
路径**(`@src/foo.ts`),与 composer chip 的 `@foo.ts` 不一致,长路径还撑爆气泡(违反
§4.4 不裸露歧义技术字段)。要求:气泡里的 @mention 也显 `@filename`,完整路径留 tooltip +
click target。

## 设计(三段)

1. **@前导检测**(`lib/filePath.ts::findPathSpans`):路径匹配命中后,检查前一字符是否 `@`、
   且该 `@` 处于 token 边界(文本开头 / 前一字符非 word 非 `@`)。边界检查排除类 email 的
   `a@b/c.ts`(`@` 紧跟 word → 不算 mention)。命中则把 `@` **吞进 span**(`start -= 1`),
   使整段 `@basename` 渲染成单个可点单元;`raw` 同步含 `@`(`raw = "@" + m[0]`),保持
   `raw == text.slice(start, end)` 不变量。
2. **isMention 标记**:`PathSpan` / `TextPart` 加 `isMention?: boolean`,**仅在 true 时出现**
   (conditional spread)—— 非 mention 的 span/part 形状不变,既有 `toEqual` 测试与 caller 零影响。
3. **渲染分流**(`PathLinkified.tsx` + `CollapsibleText.tsx`):mention 段走 `pathPartLabel`
   显 `@basename[:line]`(纯函数,两处共用,DRY),className 加 `.path-mention`;普通路径段
   仍显 `raw`。click 仍 `onOpen(path, line)`(path 干净、不含 `@`)。tooltip 用 `raw`
   (含 `@` + 完整路径),与 composer chip title(`@path`)一致。

## 改了哪些文件

- `frontend/src/lib/filePath.ts`:`PathSpan`/`TextPart` 加 `isMention?`;`findPathSpans`
  做 @ 前导检测 + 吞 @;`splitByPaths` 透传 isMention(仅 true);新增纯函数 `pathPartLabel`。
- `frontend/src/components/PathLinkified.tsx`:渲染分流 —— mention 用 `pathPartLabel` +
  `.path-mention`,普通路径不变;span 由两份收敛成一份(只 label/className 分支)。
- `frontend/src/components/CollapsibleText.tsx`:工具 I/O 行内路径同步分流(共用
  `pathPartLabel`),保持与气泡一致。
- `frontend/src/index.css`:新增 `.path-link.path-mention`(淡 accent 底 + 实线下边 + 圆角
  + 微 padding,读作「引用 chip」而非「裸检测到的路径」,仍 inline 轻量 §4.6)。
- `frontend/src/lib/filePath.test.ts`:补 8 个 mention 用例(前导 @ 吞 @ / :line 透传 /
  开头边界 / 无 @ 不标记 / word@path 排除 / splitByPaths / pathPartLabel),既有用例全绿。

## 验证

- `bun test src/lib/filePath.test.ts`:20 pass / 0 fail(含新增 8 条)。
- `bun test src/lib/`:除预存在的 `highlight.js/lib/common` 模块缺失(lang.test.ts,与本次
  无关)外全绿。
- `npx tsc --noEmit`:本次改动三文件(filePath / PathLinkified / CollapsibleText)零报错;
  其余报错全为 `bindings/...` 模块缺失(worktree 未跑 `wails3 gen bindings`,预存在)。
- `go build ./...` / `go vet ./...`:exit 0(未改 Go;`frontend/dist` embed 提示为预存在)。

## 下一步

无;功能点完整收口。后续若要给 mention 加 `@` 单独着色(如 accent 高亮 `@`、basename 普通
色),可在 `pathPartLabel` 之外把 label 拆两段 span —— 当前单 span 已满足「显 @filename」
验收,不过度设计(§5.3 KISS)。
