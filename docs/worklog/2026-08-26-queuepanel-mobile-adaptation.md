# 2026-08-26 QueuePanel 窄屏适配(≤768px 两行布局 + 上移/下移复用 onReorder)

Task #24284 / issue #126B。

## 起因

QueuePanel 沿用桌面单行布局:idx + 拖拽手柄 + 文本 + 定时徽标 + 4 个文字按钮挤一行,在 ~370px
手机视口完全不可用;且重排只有 HTML5 drag 一个入口——触摸上 drag 不可达,移动端无法调整发送顺序。

## 改法(全部收在 ≤768px 断点内,桌面零修改,M2 硬约束)

1. **两行布局**:`.queue-item { flex-wrap: wrap }` + `.queue-item-actions { flex-basis: 100% }`
   —— 行 1 保留 idx + 文本 + 定时徽标(文本仍 ellipsis),动作按钮整组换到满宽的行 2;
   编辑/定时行(`.queue-item-edit`)同样 wrap,input 一行、按钮(preset/save/cancel/clear)一行。
2. **按钮 ≥40px 触摸目标**:`.queue-btn { min-height: 40px; min-width: 40px; padding: 8px 12px }`。
3. **grip 隐藏 + 上移/下移按钮**:`.queue-grip { display: none }`;动作区头部新增两个图标按钮
   (ChevronUp/ChevronDown,`queue-move-up`/`queue-move-down` testid),**复用 `onReorder`**:
   上移 = `onReorder(item.id, queue[idx-1].id)`、下移 = `onReorder(item.id, queue[idx+1].id)`
   ——父层 `reorderQueue` 是 splice 语义(splice out from → insert at to),对相邻项恰好是精确
   相邻互换;边界(首行上移/末行下移)`disabled`。**Props 不变**,单一代码路径,桌面端按钮
   `display: none`(仿 `.msg-share-btn` 的 base-hidden + 断点内 inline-flex 既有模式)。
4. tooltip 按 §4.5 走 `data-tooltip-id="md-tip"`(未用原生 title);i18n 新增
   `queue.moveUpTip` / `queue.moveDownTip`(zh/en)。

## 改了哪些文件

- `frontend/src/components/QueuePanel.tsx`:新增上移/下移按钮 + 英文注释(§3.7)。
- `frontend/src/index.css`:base 加 `.queue-btn.move { display: none }`;≤768px 块加 9 条规则。
- `frontend/src/i18n/locales/{zh,en}.json`:2 个新 key。
- `frontend/src/components/QueuePanel.mobile-reorder.mount.test.tsx`(新):3 个 mount 测试。

## 验证

- `bun test src/components/QueuePanel`:20 pass(含新增 3 个:上/下移调 onReorder 相邻目标、
  边界 disabled 不触发、单项队列双 disabled)。
- `bun run build`(tsc + vite):通过(worktree 里 bindings 不在 git,先 `wails3 generate bindings -ts`
  生成——注意默认不带 `-ts` 只出 .js,tsc 解析不了)。
- `go build ./...` / `go vet ./...`:clean(本任务无 Go 改动,例行确认)。
- 全量 `bun test`:253 pass / 6 fail——6 个 fail 全在 `NewSessionModal.mount.test.tsx`,
  **stash 后干净 HEAD 上同样 fail,预存在,与本任务无关**。
- 三端(§4.7):
  - 桌面 GUI(>768px):新增按钮 base `display:none`,未改任何既有选择器 → 渲染不变(由构造保证;
    未跑像素 diff)。
  - 远程浏览器:同一份 CSS/组件,>768px 同桌面结论;无 `isRemoteClient` 分支触及。
  - PWA(≤768px):本任务目标端;wiring 已由 mount 测试钉死,CSS 断点规则为声明式。
    **冒烟(视口 375px 实拍两行布局/按钮高度/上下移)待做**,testid 已备好供 E2E。

## 下一步

- ≤768px 浏览器/真机冒烟实拍(§5.6),确认编辑/定时行的 wrap 与长文本表现。
- 若后续要给移动端更多重排能力(如长按拖拽),再评估;当前显式按钮够用(KISS)。
