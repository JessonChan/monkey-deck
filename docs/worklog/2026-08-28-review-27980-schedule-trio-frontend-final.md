# Review #27980:定时预设三连(#144/#145/#146)前端面终审(chip 独立行 + 60 档 + 显式 Reset + 列表预算 cap)

日期:2026-08-28
状态:**APPROVE**(无阻塞项,3×P3 非阻塞记录在案)
审查对象:`31c35cb`(QueuePanel.tsx / index.css / 新增 schedule-trio + list-budget 两个 mount 测试),同线 worklog `ecb405a`;纯前端改动,无 Go 面,未开 backend 审。

## 审查方法

反向追踪消费链(防「类型补丁」空壳:从新增 prop/testid/类名/ref 的定义点逐个确认真实读取与写出,不顺着 commit message 叙事走)+ DOM 归属链实证 + 预算算式与 #151 参照实现的逐行对照 + 全量前端测试与 tsc/build 复跑(worktree 补装依赖 + `wails3 generate bindings` 后)。

## 逐项验证(证据)

1. **A #144 布局不变量成立**:staged chip 从 `.queue-item-actions` 移出,包进独立 `.queue-schedule-staged-row` 且位于 actions 行**之后**(QueuePanel.tsx:481 在 :473 之后);`flex-basis:100%` 之所以在桌面也成一行,是因为容器 `.queue-item-edit`(index.css:1682)在**所有宽度**下都有 `flex-wrap: wrap`——CSS 级验证通过,非只窄屏分支。Reset(:461-472)是 actions 行最后一个子元素,其条件渲染几何上不可能移动之前的按钮;cap 提示(:424)插在 presets 之后、save 之前,同样不动 presets。
2. **B #145 零改动声明在 diff 级证实**:`git diff 31c35cb^ 31c35cb` 无任何触及 `presetSchedule`/`SCHEDULE_CAP_MS`/cap 拒绝分支的 +/- 行;`SCHEDULE_PRESETS = [5,10,30,60]`(:264)是唯一逻辑改动。i18n 文件零改动(commit stat 无 locales);`queue.schedulePreset` zh「+{{mins}}分」/ en「+{{mins}}m」(locales :401)对 60 自然渲染「+60分」/「+60m」,全组件无任何小时特例分支。
3. **C #146 Reset 语义复用**:onClick = `resetStagedTime`(:468,与 chip ✕ :498 同一 handler),不动 baseline seeding(`startSchedule` :179-187 原样)、不提交、行不关;仅 `stagedVisible`(:102,与原 chip 条件逐字一致)非空时渲染;md-tip + aria-label 符合 §4.5;`.queue-btn.reset`(index.css:1608)hover 琥珀色,窄屏自动落入 `.queue-btn` 40px 触控家族(#126B)。
4. **D #146 列表预算与 #151 不对抗**:列表 cap 的 `fixed = footer.scrollHeight − list.offsetHeight`(:129)与 Composer 的 `other = footer.scrollHeight − el.offsetHeight`(Composer.tsx:202)是镜像的自消减减法——各自扣除自身占位,互不写对方属性;52px floor 只存在于 `clampComposerHeight`(:175-178),无双重 clamp。幂等性手推成立:线性流模型下两侧减法自消,重算收敛同值(极端档推演:list 0 / ta 52,健康档 152 / 220,与测试断言逐字一致)。双 RO 均观察 `.queue-panel`(Composer.tsx:359、QueuePanel.tsx:140-142);RO 创建有 `typeof ResizeObserver === "function"` + `.chat-footer` 祖先双重守卫(:140),裸挂载不设 cap(:127),符合任务钉死的 QueuePanel.tsx:137-141 要求。
5. **DOM 归属实证**:ChatView.tsx:829-830 确认 QueuePanel 是 `.chat-footer` 直接子节点、`.chat-body`(:718)与其同父——effect 里 `footer.parentElement.querySelector(".chat-body")`(:126)在生产 DOM 可解析(与 #151 已验证的归属链相同);`panel.closest(".chat-footer")` 恒命中,cap 真实生效非死代码。
6. **消费链全通电(非空壳)**:`RotateCcw`(:5→:470)、`panelRef`(:298→:122/125/140/142)、`listRef`(:315→:123/129/130)、`stagedVisible`(:102→:461/:481)逐一有真实读取端;新 testid `queue-list`/`queue-schedule-staged-row`/`queue-schedule-reset` 均被新测试消费;新类名 `.queue-list`/`.queue-schedule-staged-row`/`.queue-btn.reset` 均有匹配 CSS 规则。窄屏分支移除 `.queue-schedule-pending` 的 flex-basis 规则后,chip 触控加大规则(:3292)因类链未变仍生效,无悬空选择器。
7. **测试断言锚定值,非字段存在**:schedule-trio 断言具体提交值区间(`calls[0] ∈ [before+104m, before+106m]`、拒绝场景 `∈ [seed−60s, seed]`、文案逐字 `queue.schedulePreset:mins=60`、chip 冻结 `mins=1435`);list-budget 断言具体固定点(`"152px"`/`"0px"`、ta `"220px"`/`"52px"`)、双 RO 目标 `.queue-panel`、重复投递幂等、裸挂载 `maxHeight === ""`。
8. **测试/构建复跑**(本 worktree 先 `bun install` + `wails3 generate bindings`,与 Makefile `bindings` target 同源):`bun run test`(= `bun test --isolate`)全量 **397 pass / 0 fail**(与 ecb405a 记录一致);两个新测试单独跑 8 pass / 0 fail;`bunx tsc --noEmit` exit 0;`bun run build` 绿(仅既有 chunk-size warning)。环境注:fresh worktree 缺生成的 bindings 时套件会出现 3 条无关文件的模块解析失败(RemoteSettingsPane.devices.mount.test 等),生成后全消——与改动无关,复现路径已定位。

## P3 非阻塞(记录在案,不要求本次修)

1. **list-budget 测试 4 的 RO 断言空真**:裸挂载场景 `FakeResizeObserver.instances.every(ro => ro.observed === null)` 在 instances 为空数组时恒真(afterEach 已清空、守卫保证不建 RO)——「不建 RO」的主张实际由空数组平凡满足。行为本身正确,但改断 `instances.length === 0` 才是非空洞钉子。
2. **不变量基线取在首击之后**:schedule-trio 测试 1 的 `base = presetRects()` 在第一次 +5 点击之后录製,矩形恒定从第 2 击起钉死;「首击即成立」目前靠结构断言(staged 行在 actions 行外且之后、Reset 是行尾子元素)排除两个移位方向支撑。结构断言已锁机制,可接受;若要更紧,可补首击前的 rect 基线对比(假流模型下同样会通过)。
3. **行内条件内容在极端宽度下的弹性挤压(既有行为,非本次回归)**:cap 提示出现/Reset 出现会增加 actions 行内容,当桌面窗口窄于 ~700px(在 >768 分支内)时 flex-shrink 理论上可轻微压缩 preset 按钮宽度。该机制改动前后完全相同(cap 提示本就在行内);#144 移除的 chip 才是逐击增长的主源。≤768 分支的 `.queue-item-actions { flex-basis:100%; flex-wrap:wrap }` 吸收真实窄屏场景。

## 结论

消费链全链路通电:新 ref/派生量/类名/testid 都有真实读取/渲染/写出端;A 的布局不变量有 CSS 级机制支撑(全宽度 `flex-wrap` 容器),B 的「零改动」在 diff 级证实,C 复用既有 handler 语义未被改动,D 与 #151 的预算代数互为镜像自消减、固定点手推与测试断言一致;测试锚定值断言在位;全量测试(397/0)与 tsc/build 复跑绿。APPROVE。P3 三条留档(前两条是测试强度改进项,第三条为既有行为备忘)。#27979 状态未动,待人工复核。
