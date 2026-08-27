# 2026-08-27 · 闹钟标识醒目化:实心反色 14px 方形芯片 + is-due-soon 脉冲(#141 / Task #25104)

## 起因

#138 落地的侧栏定时发送闹钟芯片沿用了 draft-indicator 的弱形态(12px 圆形 + tint 底 + amber 字形)。用户反馈(#141)它淹没在行内:outline-on-tint 在一排弱色小图标里不显眼,而「队列里挂着未来定时项」恰恰是需要被看见的状态。本次按 issue 要求做醒目化:**实心反色 + 14px + 方形**,并在临近触发时进入 **`is-due-soon` 脉冲**。

## 方案与决策

### 1. 视觉:实心反色(实心 amber 底 + 深色字形)、14px、方形 3px 圆角

- **反色**:底 `var(--amber)` 实心 + 字形 `#4a3b00`(深暖褐,在 #ffd60a 上对比度 ≈6.5:1)。与 `.session-check.checked`(实心 accent + 白字)同一「实心 = 高强调」语言;琥珀底配深字比纯黑更协调。
- **方形**:`border-radius: 3px`,取 `.session-harness-icon` 同值——与行的圆点系标记(dot/spinner/unread 全 50%)轮廓上彻底区分。
- **尺寸**:12→14px,svg 字形 8→10px 等比放大。行内最高元素仍是 label 文字行盒(12.5px 字号),14px 芯片垂直居中后不会撑行(draft 的行高不变量结论仍有余量,#24228/#24229 两轮验证过该几何模型)。
- **脉冲**:复用既有 `perm-pulse` keyframes(opacity + scale 呼吸),零新增 keyframes;周期略快(1.1s)以示紧急。仓库无 `prefers-reduced-motion` 先例(perm-dot 也无条件常驻脉冲),不为单点引入新约定。

### 2. is-due-soon 判定:DUE_SOON_MS = 60s(issue 未给数值,本实现自选)

对齐 QueuePanel 活跃倒计时的粒度语义:最后一分钟才是用户语境里的「马上要发」。

### 3. 关键难点:侧栏不滴答,窗口翻转靠一次性唤醒定时器

#138 明确决策「无本地 tick、快照派生」。但 `is-due-soon` 是渲染期派生的布尔(`earliest - now <= DUE_SOON_MS`)——空闲 app 在调度点前可能几分钟没有任何快照到达,**纯渲染派生会让脉冲在主场景(调度后走开、临发前回来看)根本不亮**。

修法不是改回轮询,而是把后端 one-shot schedule timer 的模型镜像到前端:

```
useEffect(deps=[scheduledBySession, dueTick]):
  扫描全部 entries 取最近的 earliest - DUE_SOON_MS 边界
  边界在未来 → setTimeout 到点 setDueTick(n+1);否则退出
```

- 任意时刻**最多一个 armed timeout**;每次 fire 重算下一个边界,全越过即自然停止,steady-state 零成本。
- 真正的到点 drain 由后端 timer 驱动并广播新快照删除 entry,前端不做二次兜底(尊重数据源)。
- 依赖里 `dueTick` 同时充当「fire 计数器」,避免「props 不变导致后续边界永不布防」的缺陷。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `frontend/src/components/Sidebar.tsx` | 模块级 `DUE_SOON_MS = 60_000`;组件内 due-soon one-shot 唤醒 effect;marker IIFE 改早退结构并按窗口拼 `is-due-soon` class |
| `frontend/src/index.css` | `.scheduled-indicator` 改 14px / 3px 圆角 / 实心反色;`.scheduled-indicator.is-due-soon` 复用 perm-pulse 脉冲 |
| `frontend/src/components/Sidebar.scheduled.mount.test.tsx` | 契约头加第 5 条;远future 断言**不含** is-due-soon;新增 ×2:窗口内立即带类、跨越边界经唤醒翻类(无 props 变更) |

## 验证

- **定向套件**:`bun test src/components/Sidebar.scheduled.mount.test.tsx` → 6 pass / 0 fail(含唤醒翻类行为测试,mount 时在窗外 +60.5s,~0.5s 后类自动出现)。
- **回归**:`bun test src/components/Sidebar src/components/QueuePanel` → 55 pass / 0 fail(worklog #138 基线为 53,+2 为本次新增)。
- **类型与构建**:补生成 `wails3 generate bindings`(worktree 缺 gitignore 的 bindings 目录,非签名变更)后 `tsc --noEmit` 干净;`bun run build` 通过(chunk >500kB 警告为既有)。无 lint script(package.json 无,任务说明的条件下跳过)。
- **三端影响分析**(§4.7):纯呈现层改动,无新事件/binding/远程守卫分支;class 名与 DOM 结构同一路径作用于桌面 GUI / 远程浏览器 / PWA 抽屉,无 ≤768px 分支差异;脉冲动画复用 perm-dot 已在三端跑过的 keyframes(color/transform/opacity,无引擎特有属性,无 backdrop-filter,§4.6 合规)。**webview 内的肉眼观感(chip 在真实行高的占比、脉冲节奏)属用户侧冒烟项**,与前两轮 #138 worklog 同口径如实标注。

## 下一步

- 用户侧三端肉眼确认:GUI 桌面 / 远程浏览器 / PWA 抽屉里 14px 方形芯片观感与脉冲节奏;若 60s 窗口体感太短/太长,只需调 `DUE_SOON_MS` 一个常量。
