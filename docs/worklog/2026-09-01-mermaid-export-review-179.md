# #179 审卡落档:mermaid copy-as-image 移除复审(APPROVE)

- 日期:2026-09-01
- 任务:Task #28941(补审卡 worklog 落档;仅补审计工件,不重做评审)
- 关联:#179(移除拍板)、Task #28939(移除实现,commit `dafda16`)、审卡 #28940(已出 APPROVE,其分支零新提交,本条把审计结论落到 main)
- 基线:main HEAD `7661470`

## 起因

审卡 #28940 对 #28939(移除 mermaid「复制为图片」)出了 APPROVE,但审卡分支没有新提交、main 上也没有审卡 worklog。本条把该次评审结论与复验证据落档,保证审计链完整;零代码改动。

## 评审结论(审 #28939,即 APPROVE 依据)

`dafda16`(feat(frontend): remove mermaid copy-as-image (#179)):7 files,**+2 / −648**,纯删除型改动。

六项移除清单逐项核验通过:

1. **lib 整删**:`lib/mermaidExport.ts` + `lib/mermaidExport.test.ts` 整文件删除,唯一 importer(MermaidRenderer.tsx)的 import 随组件清理。
2. **挂载点整删**:`MermaidRenderer.tsx` 内 `useMermaidImageCopy` tri-state hook、私有 `CopyImageButton` 组件、两处 JSX 挂载(`mermaid-copy-image` inline / `mermaid-fs-copy-image` 全屏)、只为按钮存在的 lucide import(`ImageDown`/`Download`)与 `useCallback`,全部删净。
3. **i18n**:zh/en 各删 4 键(`chat.mermaidCopyImage`/`mermaidImageCopied`/`mermaidImageDownloaded`/`mermaidImageCopyFailed`)。
4. **CSS 零删除**:`CopyImageButton` 只复用共享类(`.msg-action-btn`/`.mermaid-spin`),无孤儿类。
5. **死代码清理**:`lib/mermaidRenderer.ts` 仅删 `themeBackground` dead export(注释自述 "exported for mermaidExport",唯一消费者随功能死亡;渲染链零影响)。
6. **测试**:导出 lib 测试整删;mount 测试删 mock 块与 6 个 copy-image 用例。

红线确认:渲染链(`renderMermaid`/`getCachedSvg`/`svgCache`/懒加载单例)、zoom/全屏/查看源码/源码复制、docs/worklog 历史均未动。

**CopyIconButton 按消费者保留**:共享组件 `CopyIconButton.tsx` 的消费者是 `ChatView.tsx`(merge-result 复制,`ChatView.tsx:951`)与 `ErrorCard.tsx`(错误横幅复制,`ErrorCard.tsx:18`)——MermaidRenderer 从未引用它(mermaid 用的是组件内私有的 `CopyImageButton`)。组件、mount 测试、`.copy-icon-btn` CSS 一律保留。

## 复验(Task #28941,基线 7661470,原始输出留存)

1. **grep 归零**:`frontend/src` 内 `mermaidExport|copyImage|CopyImageButton|useMermaidImageCopy` → **No matches found**;扩展口径 `themeBackground|ImageDown|copyMermaidImage|ImageCopyOutcome|mermaidCopyImage|mermaidImageCopied|mermaidImageDownloaded|mermaidImageCopyFailed` → **No matches found**。
2. **渲染路径未动**:`frontend/src/lib/mermaidRenderer.ts` 在位;`git show dafda16` 对该文件仅 +0/−7(`themeBackground` export 块连同注释),`MermaidRenderer.tsx` 全部 hunk 均为删除型(挂载点/hook/imports/注释),`renderMermaid` 渲染链零改动;`MermaidRenderer.mount.test.tsx` 全量套件中通过。
3. **全量测试绿**:`bun test --isolate` → **532 pass / 0 fail**(73 files,7824 expect() calls)。
4. **tsc**:`bunx tsc` → **exit 0**。

环境备注(踩坑):本 worktree 新检出,`frontend/node_modules/` 与 `frontend/bindings/`(均 gitignore)缺失,先 `bun install` + 仓库根目录 `wails3 generate bindings -clean=true -ts -i`(Makefile `bindings` target 同款)后可测。⚠ 在 `frontend/` 子目录里跑 generate 会把产物落错到 `frontend/frontend/bindings`,必须在仓库根执行。⚠ 直接 `bun test`(不带 `--isolate`)在本环境出现 16 个跨文件全局状态污染的假失败(clipboard 渠道/App 布局/LaTeX 等,单文件复跑即绿);**必须用项目规范命令 `bun run test`(= `bun test --isolate`)**,与移除 worklog 记录的 532/0 完全一致。

三端说明(§4.7):本条为纯文档落档,零代码改动,无前端行为变化,三端无回归面。

## 改了哪些文件

- 新增:`docs/worklog/2026-09-01-mermaid-export-review-179.md`(本文件,单文件单提交)

## 下一步

- 无。#179 移除 + 审计落档闭环;issue 关闭动作由人工决定(本卡不 push 不关 issue)。
