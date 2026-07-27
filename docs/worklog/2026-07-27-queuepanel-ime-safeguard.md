# 2026-07-27 QueuePanel 编辑框加 IME 三重保险(防中文输入法选词 Enter 误保存)

**类型**:fix(queue)

> Task #23422(初版)/ #23423(重做,落 main 未合 goose-exp)/ **#23424(重做2:补回归测试 + 合并存活验证)**。前两次 artifact 被判 phantom(代码已落库但缺回归测试、未验证合并存活),本次补齐:新增 IME 回归测试,并在当前 worktree 完整重验 build/test。

## 起因

QueuePanel 的 inline 编辑 textarea(`queue-edit-input`)的 `onEditKey`:Enter(无 Shift)保存、Esc 取消。但**没做 IME 合成态判断** —— 中文输入法选词确认时按下的 Enter 会被直接当成「保存」,导致用户还没选完词、内容就被误提交写回队列。

Composer(`Composer.tsx:106-108,265-266,530-531`)早已用「三重保险」解决同一问题:`composingRef`(compositionStart/End 手动记录)+ `e.nativeEvent.isComposing`(标准)+ `e.keyCode === 229`(已废弃但兜底)。三重并查是因为部分 macOS IME 下 `isComposing` 不可靠,单一信号会漏。

QueuePanel 的编辑框与 Composer 输入框是同一种交互(Enter 提交),却漏了这层防护,体验不一致且会误触发。

## 改法

仿 Composer,给 QueuePanel 编辑框加同样的三重保险:

1. **`composingRef`**(`QueuePanel.tsx:35-37`):新增 `useRef(false)`,与现有 `editRef`/`scheduleRef` 并列。
2. **`onEditKey` 守卫**(`QueuePanel.tsx:51-53`):函数入口加 `if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;` —— composing 中 Enter 用于选词,不保存/不取消。
3. **composition 事件绑定**(`QueuePanel.tsx:132-133`):编辑 textarea 加 `onCompositionStart={() => { composingRef.current = true; }}` 与 `onCompositionEnd={() => { composingRef.current = false; }}`,驱动 ref。

定时(`datetime-local`)输入框不需要 —— 它的提交走按钮点击,没有 Enter 提交路径,无 IME 误触发面。

## 改了哪些文件

- `frontend/src/components/QueuePanel.tsx`:加 `composingRef` + `onEditKey` IME 守卫 + 编辑 textarea 的 `onCompositionStart`/`onCompositionEnd`(共 +8 行)。
- `frontend/src/components/QueuePanel.ime.mount.test.tsx`(**Task #23424 新增**):IME 三重保险回归测试,4 个用例(详见下节)。

## 回归测试(Task #23424 补)

AGENTS §5.3「每个 bug 修复必须配一个能复现该 bug 的测试」——前两次漏了,本次补。新增 `QueuePanel.ime.mount.test.tsx`,4 用例:

1. `KeyboardEvent.isComposing=true` → Enter 不保存;同一输入框 `isComposing=false` → Enter 恢复正常保存(证明标准信号路径生效)。
2. `keyCode===229` → Enter 不保存(证明兜底信号路径生效)。
3. 非合成 Enter 仍正常保存(回归:守卫不误伤正常路径)。
4. composition 接线冒烟:编辑 textarea 派发 `compositionstart`/`compositionend` 不抛异常、组件稳定。

**测试环境局限(已验证并记录在测试文件头)**:React 19 + happy-dom 下,手动 dispatch 的 `compositionstart` 能触发原生 `addEventListener` 回调,但**不触发 React 合成 `onCompositionStart`**(React 事件系统差异)。故 `composingRef` 路径(生产主信号)无法在 happy-dom 端到端模拟;改测可直接从 `KeyboardEvent.nativeEvent` 读到的另两条等价信号(`isComposing`/`keyCode===229`),它们各自独立命中守卫即证明 OR 逻辑生效。`composingRef` 接线由冒烟用例兜底。

## 验证

- `bun test src/components/QueuePanel`(frontend):全部 14 pass(edit/schedule/reorder/ime 四个文件)。
- `npm run build`(frontend,= `tsc && vite build`):零 TS / 编译错误(需先 `wails3 generate bindings` 生成未入库的 bindings)。
- 全量 `bun test`:7 个 fail 全在 `HarnessUpdateAwareness.mount.test.tsx`(`ChatService.GetConfig is not a function` —— HarnessPane 的 mock/binding 问题,与本改动无关,历史既有)。
- 定时(`datetime-local`)输入框不受影响(提交走按钮点击,无 Enter 提交路径,无 IME 误触发面)。
- **合并存活验证**:当前 worktree HEAD = `f6a2e77`(已合 `agent/coder/517f705d`);`git branch --contains df12b06` 显示 IME 代码改动已存在于 `main` + 当前分支,工作树中 `QueuePanel.tsx` 的 `composingRef` + 三重守卫 + composition 接线均健在(非 phantom)。

## 下一步

- 桌面应用实测:中文输入法下编辑队列条目,选词确认的 Enter 不应触发保存。
- 若后续给 queue 编辑框加更多快捷键,记得 composing 守卫在入口已统一拦掉,新分支天然安全。
