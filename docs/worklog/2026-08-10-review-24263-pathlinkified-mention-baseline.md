# 2026-08-10 #118b PathLinkified 气泡 @mention 显 @filename —— 基线隔离验收(Task #24264)

## 起因
Task #24264 = #118b 的**基线隔离验收**:#118b 的实现(#24263)已在另一 worktree 落地,
本任务在**干净 worktree**(基线 = `471ab48`,不含 #24263 的改动)上**独立复现并验证**,
确认实现是可重现的、非依赖某 worktree 偶然状态的,且全部门槛在干净基线上同样达成。

## 做法
- 基线 `git status` 干净、`git log` 不含 #118b 任何 commit。
- 实现层 commit `70b9406`(父即本基线 `471ab48`)是 #24263 落地的真实 diff。验收采取
  **同设计复现**:cherry-pick 该实现 commit 进本 worktree(`08d3b56`),实现层完全等价于
  在干净基线上从零写出同样的代码。cherry-pick 无冲突(父 = HEAD,linear apply)。
- worklog commit `c3aed48` 一并 cherry-pick(`ffbb523`),保留设计文档与改了哪些文件的记录。

## 独立验证(本 worktree 干净基线上重跑,非照搬 #24263 的结论)

| 门槛 | 命令 / 检查 | 结果 |
|---|---|---|
| 单测(filePath) | `bun test src/lib/filePath.test.ts` | **20 pass / 0 fail**(12 旧 + 8 新 mention) |
| 单测(src/lib 全量) | `bun test src/lib/` | **96 pass / 0 fail** |
| TS 类型(改动三文件) | `bun run build`(tsc 阶段)grep `filePath\|PathLinkified\|CollapsibleText` | **0 报错**(其余报错全为预存在 `bindings/...` 缺失,worktree 未跑 `wails3 gen bindings`) |
| Go 验收门槛 | `go build ./... && go vet ./...` | **exit 0**(预存在 `frontend/dist` embed 缺失用 `.gitkeep` 占位绕过,与本次改动无关;未改任何 Go) |

新增 8 个 mention 用例覆盖:@ 前导吞 @ / `:line` 透传 / 文本开头边界 / 无 @ 不标记 /
`word@path`(类 email)排除 / `splitByPaths` 透传 / `pathPartLabel` 四分支。既有 12 用例
全绿——`isMention?` 用 conditional spread(`...(isMention ? {isMention:true} : {})`)保持
非 mention span/part 形状不变,既有 `toEqual({start,end,raw,path,line})` 不断。

## 设计复核(对照 AGENTS.md 硬约束)

- **§5.3 找不变量,不堆 if**:不变量是「token 边界的 `@` + 路径」。检测在路径命中后回看
  前一字符,不做「上一个 token 是什么」的启发式;`raw == text.slice(start, end)` 不变量保持。
- **§5.3 转换层不丢弃标识**:`isMention` 透传不丢;`path` 始终干净(不含 `@`),click/onOpen
  拿到的 path 与普通路径一致(上层 FilePreviewOverlay 无需特判)。
- **§4.4 不裸露技术格式**:气泡显 `@foo.ts`(basename),完整路径在 tooltip + title,不把
  `@src/deep/nested/foo.ts` 这种长技术 token 直接砸给用户。
- **§4.6 轻量 / 跨平台**:`.path-mention` 纯 CSS(`color-mix` + 圆角 + 微 padding),无新依赖、
  无 canvas/重绘,inline 轻量。
- **§5.3 KISS / DRY**:`pathPartLabel` 纯函数,PathLinkified + CollapsibleText 共用,渲染分流
  只在 label + className 两处分叉,span 结构收敛成一份。

## 改了哪些文件
本任务验收**未新增/修改任何源码文件**(纯复现 + 验证)。cherry-pick 进本 worktree 的两 commit
所涉文件清单见 `docs/worklog/2026-08-10-pathlinkified-mention-at-basename.md`「改了哪些文件」一节
(filePath.ts / PathLinkified.tsx / CollapsibleText.tsx / index.css / filePath.test.ts)。

## 结论
**#118b 验收通过。** 在干净基线(`471ab48`)上独立复现实现并重跑全部门槛:20 单测全绿、
96 lib 测试全绿、改动三文件 TS 零报错、Go build/vet exit 0。实现可重现、设计合规、
非依赖特定 worktree 状态。功能点完整收口。

## 下一步
无。
