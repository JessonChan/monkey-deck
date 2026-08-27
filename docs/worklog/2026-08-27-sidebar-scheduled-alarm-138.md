# 2026-08-27 · 侧栏定时发送闹钟标识:scheduledBySession 派生 + draft-indicator 形态(#138 / Task #24914)

## 起因

队列定时发送(#97)落地后,「某 session 队列里挂着未来定时项」这一状态只在**进入该 session 的 QueuePanel** 里可见(队列头 Clock 图标 + 行内 ⏰ 徽标)。侧栏 session 列表对它完全无感知——用户定时了 3 个 session 的消息后切走,没有任何一眼可见的提醒,容易忘记哪些会话还有动作待发。

本次给侧栏 session 行加**闹钟标识**(issue #138):队列存在未到点的定时项时,行尾显示 AlarmClock 圆形小徽标(draft-indicator 同款形态),tooltip 给出最早一条的触发时刻;该项到点被 drain 发出后标识自动消失。

## 方案与决策

### 1. 数据源:权威 chat:queue 快照派生,不新建事件/不新增 binding

App 已消费 `chat:queue` 事件并在 `queueBySession` 持有每个 session 的全量队列快照(后端在每次 enqueue/revoke/edit/schedule/reorder/drain-dequeue 及 OpenSession 时推送)。派生就在这个现成快照上做(`useMemo`,依赖 `[queueBySession]`):

- **值取 `Record<string, number>`( earliest 未来 scheduledAt),不是 boolean**:同一份 prop、同一次遍历顺手算出 min,tooltip 就能直接展示「最早一条将于 {{time}} 自动发送」——零额外通道换来更有用的提示。
- **不需要前端滴答**:到点时刻由后端 one-shot schedule timer 精确驱动,drain 发出即广播新快照,item 移除 → 标识自清。中间态(已到点但 snapshot 未到)由 Sidebar 渲染处的 `> Date.now()` 门兜住提前隐藏。属 §5.3「尊重数据源,不重造协议已给的东西」。

### 2. 形态:draft-indicator 同款芯片,但放**独立标记位**,不吃互斥尾槽

「draft-indicator 形态」采纳为视觉形态(12px 圆形 chip + 8px svg 字形,fab 色系换成 amber):

- **位置**:放在 pin / terminal-mark 等独立标记之后、perm/unread/draft 互斥三元链之前。
- **为什么不进互斥链**:链语义是「高优先级遮蔽低优先级」,无论插在哪一档都会让权限请求/生成中/未读在定时项存在的 session 上被吞掉。闹钟只是信息性信号,不应有任何遮蔽权——独立标记位下草稿 chip 与闹钟 chip 可共存(mount test 有钉)。
- **配色 amber + `rgba(255,214,10,0.16)` 背景**:对齐全站定时发送色语言(`--amber`/`.queue-scheduled.future`/`.st-thinking` 同族),与 draft 蓝(accent-2)、perm 红、unread 绿明确区分;沿用 st-thinking 已验证的同底色组合。
- 尺寸走 `.draft-indicator` 既有的行高不变量结论(12px chip 在 `.session-label` 文字行盒之下,不撑行,#24228/#24229 两轮 review 已验证该几何),无新布局风险。

### 3. i18n

新增 `sidebar.scheduledTip`(en/zh 两端同位,draftTip 之后一行):
- zh:`定时发送:最早一条将于 {{time}} 自动发送`
- en:`Scheduled send: earliest message auto-sends at {{time}}`

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `frontend/src/App.tsx` | 新增 `scheduledBySession` useMemo(earliest future scheduledAt 派生)+ `<Sidebar>` 传 prop |
| `frontend/src/components/Sidebar.tsx` | Props 加 `scheduledBySession?: Record<string, number>`;import `AlarmClock`;session 行独立标记位渲染 IIFE(chip + tooltip + `data-testid="scheduled-${s.id}"` + `> now` 门) |
| `frontend/src/index.css` | `.scheduled-indicator` + `.scheduled-indicator svg`(紧跟 .draft-indicator 块,含英文注释说明配色来源与独立标记定位) |
| `frontend/src/i18n/locales/{en,zh}.json` | `sidebar.scheduledTip` 一条 |
| `frontend/src/components/Sidebar.scheduled.mount.test.tsx` | 新增 mount 测试 ×4 |

## 验证

- **mount 测试**(`Sidebar.scheduled.mount.test.tsx`,4 例全绿):未来时间渲染 chip(svg 字形 + tooltip key);无 prop/空 record 无 chip 且 `.session-time` 兜底不变(3 行全保留——独立标记不占尾槽的行为钉死);过去时间被 `> now` 门隐藏;draft+scheduled 共存双 chip。
- **定向回归**:`bun test src/components/Sidebar src/components/QueuePanel` → 53 pass / 0 fail。
- **类型检查与构建**:`wails3 generate bindings` 后 `tsc --noEmit` 干净;`bun run build`(tsc && vite production)通过(chunk >500kB 警告为既有)。
- **全量套件基线对照**:干净树上全量 `bun test` 本环境即有 ~83 fail/20 errors(sttClient/HarnessPane/clipboard 等,与本改动无关的环境性失败);带本改动为 82 fail/18 errors 且测试数 +4 全过——非回归。
- **三端影响分析**(§4.7):纯增量呈现层改动——无新事件/binding/远程守卫分支,单条 CSS 规则继承 draft-indicator 已在三端实测过的几何形态(12px chip/8px glyph/inline-flex,无引擎特有属性),≤768px 抽屉侧栏同一渲染路径。行为面由 mount 测试确定论覆盖;真 webview(PWA 抽屉内)肉眼看一次 chip 观感属用户侧冒烟项,自动化环境(GUI 会话)不可达,如实标注。
- **踩坑记录**:第一轮编辑曾用 `PUT N.=N` 把相邻的 `hasTermBySession={hasTermBySession}` 整行**替换**成了新 prop 行(应为插入),导致该既有功能从侧栏静默脱落——靠干净树 `tsc --noEmit` 基线对照暴露(TS6133 仅在我的树出现)后修复。教训:**插入一律走 `PUT >N:`,替换型锚点必须核对被替换行的原始内容**。

## 下一步

- 用户侧肉眼确认三端观感(GUI 桌面 / 远程浏览器 / PWA ≤768px 抽屉),尤其 label 极长的截断场景。
- 可选打磨:若用户反馈想知道具体几条定时(而非仅最早一条),再考虑 tooltip 列表化或计数角标——当前 Less is More 不做。
