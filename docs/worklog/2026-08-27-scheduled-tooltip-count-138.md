# 2026-08-27 · 定时发送 tooltip 补条数 N:scheduledBySession 改 {count,earliest}(#138 设计对齐 / Task #24916)

## 起因

`02b4ae8`(#138)落地的侧栏闹钟标识,tooltip 只报「最早一条将于 {{time}} 自动发送」。当一个 session 队列里挂了多条定时项时,用户看不到规模(是 1 条还是 5 条),与 #138 评审时预留的打磨方向(工作log「下一步」:若想知道具体几条,再考虑计数)对齐。本次把**条数 N 补进 tooltip**,派生层随之从裸时间戳升级为结构化对象。

## 方案与决策

### 1. 派生层改形:`Record<string, number>` → `Record<string, {count, earliest}>`

`App.tsx` 的 `scheduledBySession` useMemo 在既有单次遍历上顺手计数(同一轮 `it.scheduledAt > now` 判定同时累计 `n` 与 `min`),**不引入第二次遍历、不改数据源语义**——仍只统计未来项,仍由 chat:queue 快照驱动、无本地滴答。count 走进 tooltip 后,多定时项的规模信息零额外通道到手。

- **为什么不让 Sidebar 自己数**:Sidebar 只拿到派生结果,拿不到队列全量;在后端权威快照的唯一次消费点(App)算一次,消费方保持纯渲染。
- **不变量不变**:同一 session 的 entry 存在 ⇔ 队列里有 ≥1 条未来定时项;到点 drain 后快照自带新表,entry 自清。

### 2. 渲染层:i18n 模板补 `{{count}}`,`> now` 门改查 `.earliest`

`Sidebar.tsx` 闹钟 IIFE 从 `at && at > Date.now()` 改为 `sch && sch.earliest > Date.now()`,tooltip 参数由 `{ time }` 扩为 `{ count, time }`。芯片形态/独立标记位/testid 均不动。

### 3. i18n

`sidebar.scheduledTip` 一键两端同位更新:
- zh:`定时发送：{{count}} 条待发，最早一条将于 {{time}} 自动发送`
- en:`Scheduled send: {{count}} pending, earliest auto-sends at {{time}}`

不搞 i18next 复数(`_one/_other`)——仓库既有惯例是单模板 + `{{count}}`(如 `batchCount`),一处 key 两端各自成句。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `frontend/src/App.tsx` | `scheduledBySession` useMemo 输出 `{count, earliest}`,注释同步(#138 注释块英文续写) |
| `frontend/src/components/Sidebar.tsx` | Props 类型改 `Record<string, { count: number; earliest: number }>`;闹钟 IIFE 门改 `.earliest`、tooltip 增 `count` |
| `frontend/src/i18n/locales/{en,zh}.json` | `sidebar.scheduledTip` 模板补 `{{count}}` |
| `frontend/src/components/Sidebar.scheduled.mount.test.tsx` | 全部用例换新 prop 形;i18n mock 的 `t` 升级为「key + JSON 回显 opts」以钉住插值;首例新增 `"count":2` 断言 |

## 验证

- **定向测试**:`bun test src/components/Sidebar src/components/QueuePanel` → **53 pass / 0 fail**(与 #138 落地时基线一致;新增 tooltip count 插值断言生效)。
- **类型检查**:`wails3 generate bindings`(本 worktree 缺 bindings,tsc 此前仅报 TS2307 环境性缺失)后 `tsc --noEmit` 干净。
- **构建**:`bun run build`(production)通过(chunk >500kB 警告为既有)。
- **踩坑记录**:本轮两次 hashline 编辑锚点错位造成中间态损坏(Sidebar.tsx ternary consequent 行丢失 / 测试 mock 区孤儿闭合行),均靠 bun 转译报错行号 + 局部重读定位后整段重建修复。教训同 #138 worklog 已记的一条:**编辑前锚点必须取当前 TAG 的真实行号,ranges 不跨未见行**;损坏后尽快局部重读再整段 `PUT N.=M:` 重建,比多个小补丁可靠。
- **三端影响分析**(§4.7):纯呈现层增量改动,无新事件/binding/远程守卫分支;改动沿 `App 派生 → Sidebar 单一渲染点 → react-tooltip` 路径,三端(GUI webview / 远程浏览器 / PWA ≤768px 抽屉侧栏)**同一渲染路径**自然继承,i18n 文案两端 locale 各自完整。行为面由 mount 测试确定性覆盖;GUI 会话内不可达真 webview 肉眼观感(tooltip 实际排版)属用户侧冒烟项,如实标注待验。

## 下一步

- 用户侧肉眼确认三端 tooltip 观感(GUI / 远程浏览器 / PWA 抽屉)。
- 若未来条数大到想看明细,再考虑 tooltip 列表化(后端需随快照带 item 摘要);当前 Less is More 只给 count。
