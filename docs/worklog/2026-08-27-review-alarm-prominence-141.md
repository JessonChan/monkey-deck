# 2026-08-27 · Review 8825fa9 #141 闹钟标识醒目化——实心反色方形芯片 + is-due-soon 脉冲 —— PASS(Task #25105)

## 审查对象

`8825fa9` feat(frontend): 闹钟标识醒目化——实心反色 14px 方形芯片 + is-due-soon 脉冲(#141),共 3 文件(Sidebar.tsx / index.css / Sidebar.scheduled.mount.test.tsx)。配套落地记录:`2026-08-27-alarm-marker-prominence-141.md`(Task #25104)。

## 结论:PASS

### 1. 类型补丁反模式核查(全链路逐点消费确认)

按「从定义点沿每个调用点确认被读取/渲染/写出」反向追踪,三个新增符号全部通电:

| 符号 | 定义点 | 消费端 | 实证 |
|---|---|---|---|
| `DUE_SOON_MS` | `Sidebar.tsx` 模块级(129 行附近) | 唤醒 effect(`at = earliest - DUE_SOON_MS`)+ 渲染期判定(`sch.earliest - Date.now() <= DUE_SOON_MS`) | 两端都真读取,无常量空壳 |
| `dueTick` state | 组件内 `useState(0)` | effect deps 第二项 + fire 计数器;每次 fire `setDueTick(n+1)` 重进 effect 布防下一边界 | 非「有 setter 无人读」死字段;恰是「props 不变也要翻类」的关键反馈环 |
| `.is-due-soon` class | 渲染 IIFE 拼接(`Sidebar.tsx:813`) | `index.css:368` `.scheduled-indicator.is-due-soon { animation: perm-pulse 1.1s … }` | CSS 规则真实存在并命中;`perm-pulse` keyframes 在 `index.css:347`(复用,零新增) |

### 2. 唤醒 effect 边界推演(one-shot 模型)

- **无紧循环**:布防条件严格 `at > Date.now()`,setTimeout 保证不早于 delay 触发;fire 后重扫时该边界已 ≤ now,只会继续找**下一个**未来边界,全越过自然停。`Math.max(0,…)` 为纯防御。
- **同时最多一个 timer**:effect cleanup 每次 re-run 都 `clearTimeout`,StrictMode 双挂载/卸载路径安全。
- **窗口已开始**(mount 或快照变更时就差 ≤60s):不布防,但渲染期直接派生 dueSoon → 脉冲立即点亮(测试已覆盖「立即带类」支路)。
- **无饿死路径**:全部 entry 过期的停滞态靠后端 drain 快照换 props 触发 effect 重扫(#138 的数据源尊重原则未破);stale entry 由渲染门控(`earliest <= now → null`)隐藏,与 #24917 复核的门一致。
- **时钟跳变**:布防 delay 按 Date.now 差值换算成单调 setTimeout,墙钟回拨只导致翻类偏晚、不会错亮/错灭,下个快照自愈。可接受。

### 3. CSS 与测试质量

- **几何/主题**:14px 方形 + 3px 圆角 + 实心 `var(--amber)`(line 25 已定义);字形 `#4a3b00` 硬编码走 `.perm-dot` 硬编码 amber 的既有先例(单深色主题仓)。实测对比度 ≈7.7:1(worklog 自估 6.5,方向保守)。12→14px 未越 label 文字行盒(12.5px 字号 ≥17px 行高),#24228/#24229 验证过的行高不变量仍有余量。
- **动画合规(§4.6)**:`perm-pulse` 只动 opacity+transform,无 layout/backdrop-filter,引擎中立,三端(GUI WebKit / 远程浏览器 / PWA 抽屉同一 JSX+CSS 路径)自然继承;≤768px 无分支差异。
- **断言锚定值**:窗外不含 `is-due-soon`、窗内立即含、跨边界经唤醒翻类且**无 props/快照变更**——第三例正面钉死 one-shot 存在意义(防退化回「等快照才翻」)。真定时器轮询等待 ~0.5s,3s deadline 有 6× 余量,失败信息明确。

### 4. 验证(reviewer 实跑,bare worktree 补装依赖后)

- **定向**:`bun test src/components/Sidebar.scheduled.mount.test.tsx` → **6 pass / 0 fail**(约 1s,唤醒翻类实测通过)。
- **回归**:`bun test src/components/Sidebar src/components/QueuePanel` → **55 pass / 0 fail**,与落地记录口径一致(53 基线 + 本次 +2)。
- **类型**:`wails3 generate bindings`(worktree 缺 gitignored bindings,从 repo 根跑)后 `tsc --noEmit` 干净;未产生任何 tracked 文件漂移。
- **i18n**:无新键;复用的 `sidebar.scheduledTip` zh/en 同位同步(line 69),插值参数与 #24916 锁定的契约逐字未动,testid/chip 结构未动。

### 非阻塞备注(P3,均不要求返工)

1. 唤醒行为测试真睡 ~0.5s,CI 时长小幅增加——deadline 守卫清晰,可接受;若未来 flake 可把 armed 点前移以缩短等待。
2. 芯片对读屏用户缺 `aria-label`(tooltip 仅 hover/tap 可达)——与 perm-dot/draft-indicator 先例一致的仓级缺口,单点补齐留待统一处理。

## 下一步

无需返工。用户侧三端肉眼确认观感(芯片占比/脉冲节奏/60s 窗口体感)即可关 #141 收口流程;窗口体感调整只需动 `DUE_SOON_MS` 一个常量。
