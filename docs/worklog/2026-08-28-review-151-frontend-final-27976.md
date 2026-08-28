# Review #27976:#151 前端面终审(Composer 预算 clamp + chat-footer 内滚兜底)

日期:2026-08-28
状态:**APPROVE**(无阻塞项,3×P3 非阻塞记录在案)
审查对象:`6d43bfe`(Composer.tsx / index.css / 新增 Composer.autogrow.mount.test.tsx),同线 worklog `d2367c9`;纯前端改动,无 Go 面,未开 backend 审。

## 审查方法

反向追踪消费链(防「类型补丁」空壳:从新常量/函数/CSS 规则定义点逐个确认真实读取与写出,不顺着 commit message 叙事走)+ DOM 归属链实证(ChatView 真实结构)+ 全量前端测试与 tsc 构建复跑(worktree 补装依赖 + 生成 bindings 后)。

## 逐项验证(证据)

1. **几何前提与真实 DOM 一致**:`composerInputBudget` 的 `footer.parentElement?.querySelector(".chat-body")` 依赖 body/footer 同父——ChatView.tsx:718(`.chat-body`)与 :829(`<footer class="chat-footer">`)确为同一 flex 包裹层的兄弟节点,解析成立;`.chat-body { flex: 1 }`(index.css:511)证实「footer 贴底、自身 rect 不是空间量度」的论证。
2. **消费链通电(非空壳)**:
   - `clampComposerHeight`(导出纯函数)→ 唯一生产消费点 `autoGrow`(Composer.tsx:212)→ 三个真实触发位:[value,collapsed] effect(:342)、resize+RO effect(:355-369)、focusSignal rAF(:385,模块级化后签名未变);
   - `COMPOSER_INPUT_MIN_H=52 / MAX_H=220` 与 `.composer-input` 既有 CSS `min-height:52px; max-height:220px`(index.css:1406)严格对齐,JS 不会写出 CSS 拒收的值;
   - 新 CSS `.chat-footer{max-height:60vh;overflow-y:auto}`(:1201-1209)与 `:has(.slash-popover)` 逃逸(:1217)类名与组件真实类名逐一匹配。
3. **popover 裁剪面全覆盖**:`.mention-popover` 元素同时带 `slash-popover` 类(Composer.tsx:782),`:has()` 逃逸对 @ 菜单同样生效;config 下拉(model/mode/effort)走 Radix Portal 渲染于 body,不受 footer overflow 影响;errcard/notice/merge-result 均为 footer 兄弟节点非后代。
4. **footer 内滚兜底无连带破坏**:footer 内无 sticky/fixed 后代(FAB sticky 在 .chat-body 内,非 footer);全局 `* { box-sizing: border-box }`(index.css:61)使 inline height/offsetHeight/scrollHeight 同一口径,预算算式自洽;clamp 后 textarea 自身滚动(与旧 220 cap 行为一致,非回归)。
5. **移动端口径**:≤768px 覆盖 `.composer-input { min-height:36px; max-height:140px }`(index.css:3242-3243)——JS 上限 220 高于 CSS 140 时 CSS 胜出(视觉钳制),预算用 `offsetHeight` 读真实盒,算式不受 inline 值虚高影响;52 floor > 36 min-height 无冲突。
6. **display:none 自愈**:切到 editor 标签页隐藏时 RO 观察目标盒归零、切回时恢复,两沿都触发 `rerun` → 以真实几何重 clamp;隐藏期 `rect.top=0` 的退化测量(见 P3-3)不会滞留。
7. **测试断言锚定值,非字段存在**:三档硬验收断言具体输出值(`toBe("220px")`/`toBe("100px")`/`toBe("52px")`,600/300/150px 三档手工推演注释在案);RO 断言**观察目标是 `.queue-panel` 而非 footer**(:284);幂等断言重复投递不振荡(:297-299);无 footer 祖先回退 220 且不挂观察者(:313);纯函数层负预算/边界(0、-80、53、52、220)逐一锚定。
8. **测试/构建复跑**(本 worktree 先 `bun install` + `wails3 generate bindings`,与 Taskfile `bindings` target 同源):`bun test --isolate` 全量 **389 pass / 0 fail**(与 6d43bfe 记录一致);`bun run build`(tsc + vite)绿(仅既有 chunk-size 警告)。顺带确认:#27973 P3-3 的 `frontend/src/bindings` 符号链接 workaround 已不需要——现源码 import 直接解析 `frontend/bindings/`(生成后 3 个历史失败文件全部转绿)。

## P3 非阻塞(记录在案,不要求本次修)

1. **RO 观察目标在 effect epoch 内冻结**:目标选择只在 `[collapsed]` effect 运行时解析一次;QueuePanel 空队列时返回 null(QueuePanel.tsx:98),故「挂载时队列空 → 之后队列才长出来」的 epoch 里观察者落在 **footer** 上。footer 长到 60vh cap 后 border-box 冻结、内容继续长 → 观察者恰在 commit message 声称最需要它的时刻失明,后续排队增长不再触发重 clamp(textarea 高度滞留旧值)。兜底(.chat-footer 内滚)保证发送钮可达,属体验降级非功能破坏。建议(后续):`rerun` 内重解析目标(观察到 footer 且 `.queue-panel` 已出现时换观察),或 QueuePanel 空态渲染占位容器。
2. **body 与 footer 之间的瞬态横幅不参与预算**:notice-bar / merge-result / ErrorCard(ChatView.tsx:817-828)出现期间预算高估其高度——代码注释已声明此残留由 `.chat-footer` max-height 兜底覆盖,属文档化的有意取舍,非缺陷。
3. **隐藏态测量退化(自愈型,无动作项)**:chat 视图 `display:none` 期间 `rect.top=0` → `avail=innerHeight` 虚高;靠 RO 0↔恢复两沿在切回时重 clamp 纠正,用户不可见。

## 结论

消费链全链路通电:两个新纯函数、两处 CSS 规则、三条重算触发路径都有真实读取/渲染/写出端;预算算式与真实 DOM 归属、box-sizing、CSS min/max 逐一口径核对无冲突;测试锚定值断言在位;全量测试与构建复跑绿。APPROVE。P3 三条留档(首条建议后续把 RO 目标选择改成惰性重解析)。
