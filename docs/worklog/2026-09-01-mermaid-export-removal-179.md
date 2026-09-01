# #179 移除 Mermaid「复制为图片」

- 日期:2026-09-01
- 任务:Task #28939(验收=frontend/src 内相关 grep 归零)
- 关联:#179(功能移除拍板)、#86(当初引入「复制为图片」的 worklog,历史保留)

## 起因

「复制为图片」(mermaid SVG → 2x PNG → 剪贴板,剪贴板不支持时降级下载 PNG)被拍板移除(#179)。本条记录移除过程、边界决策与验证。

## 改法(按移除清单逐项)

1. **lib 整删**:`frontend/src/lib/mermaidExport.ts` 与 `frontend/src/lib/mermaidExport.test.ts` 整文件删除;唯一 importer 是 MermaidRenderer.tsx(其 import 随组件清理删除)。
2. **挂载点整删**(`MermaidRenderer.tsx`):
   - 顶部注释中「复制为图片」条目;
   - `ImageCopyState` / `IMAGE_FEEDBACK_MS` / `useMermaidImageCopy`(tri-state 反馈生命周期)整段;
   - `CopyImageButton` 组件(inline 与 fullscreen 的复用实现)整段;
   - 两处 JSX 挂载:`mermaid-copy-image`(success 视图)、`mermaid-fs-copy-image`(全屏 modal);
   - 连带清理只为该按钮存在的 lucide 图标 import(`ImageDown`、`Download`)与 `useCallback`(仅 hook 在用)。`Check`/`X`/`RefreshCw` 与源码复制(zoom/全屏/查看源码)共用,保留。
3. **CopyIconButton 去留决策(红线要求记录):保留组件**。全仓消费者排查:共享 `CopyIconButton` 的消费者是 `ChatView.tsx`(merge-result 复制)与 `ErrorCard.tsx`(错误横幅复制)——**MermaidRenderer 从未引用它**(mermaid 用的是组件内私有的 `CopyImageButton`)。故 `CopyIconButton.tsx`、`CopyIconButton.mount.test.tsx`、`.copy-icon-btn` CSS 一律不动。
4. **i18n**:zh/en 两 locale 各删 4 键——`chat.mermaidCopyImage` / `chat.mermaidImageCopied` / `chat.mermaidImageDownloaded` / `chat.mermaidImageCopyFailed`;删前 grep 确认消费者仅 MermaidRenderer.tsx 与其 mount 测试(同批删除)。
5. **CSS:零删除**。逐类核对:`CopyImageButton` 只复用与 zoom/全屏/源码按钮共享的 `.msg-action-btn`;`.mermaid-spin` 与 loading 态 spinner 共用;`.mermaid-*` 其余类全部服务渲染本体。不存在仅服务复制图片的类。
6. **测试**:`mermaidExport.test.ts` 整删;`MermaidRenderer.mount.test.tsx` 删 `../lib/mermaidExport.ts` 的 `mock.module` 注册块(`copyMermaidImageMock`/`copyImageCalls`/gate)与 6 个 copy-image 用例(visible/streaming 隐藏、click→copied、downloaded、failed、fullscreen 独立反馈、busy guard #24328)。

## 边界决策:mermaidRenderer.ts 的 `themeBackground`

`export const themeBackground` 注释自述 "exported for mermaidExport",唯一消费者即 mermaidExport——随功能死亡。已连同注释删除(渲染链零影响:`currentMermaidTheme` 被渲染缓存 key `cacheKey()` 在用,保留)。属 clean cutover 的死代码清理,非渲染本体改动。

## 红线确认

- `lib/mermaidRenderer.ts` 懒加载单例、svgCache、`renderMermaid`/`getCachedSvg` 渲染链、#135 相关逻辑:未动。
- MermaidRenderer 的 zoom / 全屏 / 查看源码 / 源码复制:未动。
- docs/worklog 历史(含 #86 引入记录):未动。

## 改了哪些文件

- 删:`frontend/src/lib/mermaidExport.ts`、`frontend/src/lib/mermaidExport.test.ts`
- 改:`frontend/src/components/MermaidRenderer.tsx`(挂载点/hook/imports/注释)
- 改:`frontend/src/components/MermaidRenderer.mount.test.tsx`(mock 块 + 6 用例)
- 改:`frontend/src/i18n/locales/zh.json`、`frontend/src/i18n/locales/en.json`(各 4 键)
- 改:`frontend/src/lib/mermaidRenderer.ts`(仅删 dead export `themeBackground`)

## 验证

任务验收口径(grep + bun test + tsc)全过:

1. **grep 归零**:`frontend/src` 内 `mermaidExport|copyMermaidImage|ImageCopyOutcome|useMermaidImageCopy|CopyImageButton|ImageDown|themeBackground` 与 `mermaidCopyImage|mermaidImageCopied|mermaidImageDownloaded|mermaidImageCopyFailed` 均 **0 命中**。
2. **bun test --isolate**:532 pass / 0 fail(73 files)。渲染路径测试(renderMermaid lib describe + 组件状态机/zoom/全屏/查看源码 mount 测试)全绿。
3. **bunx tsc**:exit 0。
4. **bun run build**(tsc + vite build):过(仅既有的 chunk>500kB 警告,与本次无关)。

环境备注:本 worktree 是新检出,`node_modules/` 与 `frontend/bindings/`(均 gitignore 不入库)缺失导致首轮测试 59→11 个 "Cannot find module" 失败——`bun install` + `wails3 generate bindings -clean=true -ts -i`(Makefile 同款命令)后全绿,与本次改动无关。

三端说明(§4.7):纯删除型改动,同一份前端三端同步生效——删除的按钮在桌面 GUI / 远程浏览器 / PWA 三端同帧消失;渲染链与事件通道零改动,mount 测试覆盖渲染路径。无新增交互面,无单端定向逻辑(无 `isRemoteClient()` 分支变化),另两端无回归面。

## 下一步

- 无。#179 移除完成;若后续要恢复图片导出,git 历史可溯(#86 引入 commit)。
