# 2026-08-26 Review #126B QueuePanel 窄屏适配(PASS + 1 处 a11y 收尾修复)

Task #24285 / review 对象:commit `4dd327f`(feat(queue): #126B)。

## 审查结论:**PASS**(附 1 处收尾修复,已由 reviewer 落地)

## 逐项验证(反向追踪,不顺着 PR 叙述走)

1. **相邻互换语义(核心正确性)**:按钮宣称「上移/下移复用 onReorder 即精确相邻互换」。
   逐行核对 `reorderQueue`(App.tsx:1352-1366):splice out `from` → insert at `to`。
   上移 `onReorder(cur, prev)`:移除 cur 后 prev 位置不变,insert 在 prev 前 → 精确互换 ✓;
   下移 `onReorder(cur, next)`:移除 cur 后 next 前移一位,insert 在 next 原下标 → 精确互换 ✓。
2. **越界安全**:`queue[idx-1]` / `queue[idx+1]` 仅在 onClick 里解引用,由
   `disabled={idx===0}` / `disabled={idx===queue.length-1}` 拦住(React 不给 disabled
   button 派发 click);mount 测试钉死了「disabled 不触发 + 单项双 disabled」。
3. **Props 不变**:`Props` 接口零改动,单一代码路径(drag 与按钮同走 `onReorder`)✓。
4. **CSS 级联**:base `.queue-btn.move{display:none}`(index.css:1440)vs 断点内
   `display:inline-flex`(:2920)——同特异性、后者源序靠后,断点内必胜;完全复刻
   `.msg-share-btn` 既有模式(:2723/:2841)。新规则全在 `@media (max-width:768px)`
   (:2730)内;未改任何既有选择器 → 桌面(>768px)渲染由构造保证不变 ✓。
5. **两行布局正确性**:`.queue-item` 本就是 flex(:1391),wrap + `flex-basis:100%`
   把动作区整组换到行 2;`.queue-item-text` 有 `overflow:hidden`(:1414)→ flexbox
   自动最小尺寸为 0 → wrap 后 ellipsis 仍生效,长文本不溢出 ✓。编辑/定时行同理
   (`.queue-item-edit` 内的 `.queue-item-actions` 也吃到同一条 basis:100% 规则,
   input 一行、按钮一行,与 worklog 描述一致)。
6. **40px 触摸目标**:`.queue-btn{min-height:40px;min-width:40px}` 覆盖断点内全部
   队列按钮,纯图标的 move 按钮保底 40×40 ✓。
7. **i18n 同步**:zh/en 各 +2 key(`moveUpTip`/`moveDownTip`,两文件均 :385),
   无第三 locale;key 均被 `t()` 消费 ✓。
8. **§4.5 tooltip**:`data-tooltip-id="md-tip"`(react-tooltip),未用原生 title ✓。
9. **类型补丁反模式检查**:新增物全部有消费端——`.move` 类 → CSS 两侧规则、i18n key
   → t() 调用、testid → mount 测试。无死字段 ✓。
10. **测试断言锚定值**:`expect(calls).toEqual(["q2->q1","q2->q3"])` 锚定实参值而非
    「字段存在」;边界 disabled 锚定布尔值 + 点击不触发 ✓。

## 发现的问题与修复(reviewer 落地)

- **图标按钮缺 `aria-label`(a11y)**:新增上移/下移为纯图标按钮(ChevronUp/Down),
  无可访问名,屏幕阅读器只能念 "button"。代码库既有 icon-only 按钮模式是
  tooltip + `aria-label` 双落(ChatView.tsx:665、EditorPane.tsx:437-547、
  SelectionToolbar.tsx:129)。修复:复用既有 tip key 作 aria-label
  (SelectionToolbar 先例:一个 key 同时当 label 与 aria-label,KISS 不加新 key),
  并在 mount 测试补锚定断言(`aria-label` 必须等于 t() 返回的 key)。

## 改了哪些文件

- `frontend/src/components/QueuePanel.tsx`:两个 move 按钮各 +1 行 `aria-label`。
- `frontend/src/components/QueuePanel.mobile-reorder.mount.test.tsx`:+2 断言。

## 验证

- `bun test src/components/QueuePanel`:20 pass / 0 fail(80 expect,含新断言)。
- `bun run build`(tsc + vite):通过(worktree 需先 `wails3 generate bindings -ts`)。
- 三端(§4.7):改动仅给按钮加可访问名 + 测试断言,不动 CSS/布局/交互——桌面
  (>768px)按钮仍 display:none,远程浏览器/PWA 行为不变;逻辑回归由 mount 测试覆盖。
- 遗留(非本次范围):其余队列按钮(schedule/edit/interrupt/revoke/save/cancel 等)
  仍用原生 `title`,违反 §4.5——属 #126B 之前的存量,建议另开小任务统一收敛。

## 下一步

- ≤768px 真机/浏览器冒烟实拍仍待做(原 worklog 已列,testid 已备好)。
