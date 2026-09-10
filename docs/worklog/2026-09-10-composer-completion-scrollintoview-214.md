# #214 补全面板键盘高亮 scrollIntoView(slash/mention 同款)

## 起因

#214:Composer 的 `/` 命令面板与 `@` mention 面板用 ↑↓ 键盘导航时,高亮项超出可视区不会自动滚动——列表一长(命令多/目录项多)高亮就"看不见",只能靠鼠标。根因已实证:列表项没有 `scrollIntoView`,纯遗漏。

## 根因

`FilePanel.tsx` 的搜索结果列表早有先例(原 287-289 行):`activeRowRef` 钉住键盘高亮行,`useEffect` 在 `[activeIdx, results]` 变化时 `scrollIntoView({ block: "nearest" })`。Composer 的两个补全面板没有同款处理。

## 改法

照抄 FilePanel 先例,`frontend/src/components/Composer.tsx` 一个文件:

1. 新增两个 ref:`slashActiveRef` / `mentionActiveRef`(`HTMLButtonElement | null`)。
2. 新增两个 effect:
   - slash:`[slashIdx, filtered]` 变化时滚动;
   - mention:`[mentionIdx, mentionItems, mentionScope]` 变化时滚动。deps 多带 `mentionScope` 是因为「上一级」行的存在与否由它门控(drill 态),DOM 结构随它变。
3. 行上挂条件 ref(同 FilePanel 的 `ref={i === activeIdx ? cb : undefined}` 写法,非活跃行不抢 ref):
   - slash 列表项:`i === slashIdx`;
   - mention「上一级」行:`mentionIdx < 0`(issue 明确要求把该项纳入——↑ 键能到 -1 态,高亮它时同样要滚);
   - mention 文件/目录项:`i === mentionIdx`。

滚动全部用 `{ block: "nearest" }`:只在目标行出视口时最小量滚动,不跳页不居中,与 FilePanel 手感一致。

## 改了哪些文件

- `frontend/src/components/Composer.tsx`(+19/-1,5 处)

## 验证

- `wails3 task bindings` 重新生成后 `bun run build`(= `tsc && vite build --mode production`)通过,无类型错误(仅既有的 chunk >500kB 警告,与本次无关)。
- `bun test --isolate` 全量前端单测通过。
- 无 lint 脚本(package.json scripts 仅 dev/build/preview/test),build 即门禁。

### 三端说明(§4.7)

本次改动是纯行为增强(补全面板内滚动),不触布局/样式/组件结构,三张脸共用同一逻辑:桌面 GUI(hover + 键盘)、远程浏览器(同 React 树)、PWA(≤768px 同组件)行为一致,无 `isRemoteClient()` 分支、无新增依赖、无 DOM 结构变化,另两端无回归风险面。桌面 GUI 已由 build + 单测覆盖编译层;视觉滚动行为待 fe-reviewer 复核(流程 coder→fe-reviewer)。

## 下一步

- 流程走 fe-reviewer,APPROVE 后本卡 completed-ready。
- 真机/真 webview 的滚动手感如需进一步确认,随下一次桌面冒烟顺带看(slash 面板命令数超过可视行数时 ↓ 到底)。
