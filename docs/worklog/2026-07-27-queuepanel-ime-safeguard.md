# 2026-07-27 QueuePanel 编辑框加 IME 三重保险(防中文输入法选词 Enter 误保存)

**类型**:fix(queue)

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

## 验证

- `npm run build`(frontend):零 TS / 编译错误。
- `npm run lint`(frontend):clean。
- 定时输入框不受影响(无 Enter 提交路径),无需额外改动。

## 下一步

- 桌面应用实测:中文输入法下编辑队列条目,选词确认的 Enter 不应触发保存。
- 若后续给 queue 编辑框加更多快捷键,记得 composing 守卫在入口已统一拦掉,新分支天然安全。
