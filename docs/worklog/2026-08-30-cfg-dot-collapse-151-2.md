# #151 二期:ModelSelect 窄态收缩圆点(RO 触发 + 动态阈值 + M/E/T 圆点)

- **日期**: 2026-08-30
- **Issue**: #151 二期(Task #28428;父规格 #28427 四点拍板)
- **基线**: main = `829d020`(实际工作 HEAD 为 `a3241f6`,在其上叠加两条纯 docs 复审日志)

## 起因

一期(#27975,高度预算)之后,#151 二期处理**宽度轴**:窄窗(popout / 侧栏挤压 / 窄屏前桌面档)下 model/mode/effort 三个 cfg chip 挤压右侧操作区(实测 send 按钮被推出视口)。一期用 silent shrink/ellipsis 消化挤压——模型名被 ellipsis 吞掉;二期改为**收缩成固定 14px 圆点**(字母微标 M/E/T),宽度不再随名字变化。

## 四点规格落地

### ① 触发 = compose-bar ResizeObserver 切 `data-cfg-collapsed`

- 一个**独立 RO 实例**(`Composer.tsx` cfg dot collapse effect),与一期 queue-panel 预算 RO **解耦**(各管各的轴,互不触发)。
- 观察 4 个目标:`.compose-bar`(自身盒,窗口/侧栏驱动)、`.compose-tools`(左侧 chip 增减驱动)、`.compose-right`(名称长度/用量变化驱动)、`.cfg-group`(懒 observe——ModelSelect 在 configOptions 到达前 render null)。
- **不用 container query**(规格明确);attr 直接 set/removeAttribute,**不走 React state** → 收缩/展开零 re-render,popover 开合状态天然不受扰。
- **防反馈环论证(§5.3 不变量)**:attr 翻转会让 cfg-group/right 变宽窄并再次触发本 RO,但再评估是**幂等**的——entry 比 `tools+gap+right vs avail`,exit 用**同一组规范宽度**加上记忆的 cfg 自然宽,翻转只会被多余的那次投递**确认**而不是反转,观察一次额外投递后沉降(与一期「recompute 幂等、一次额外触发后收敛」同款论证)。cfg-group **绝不**作为决策比较项直接进出阈值——它两种形态的宽度差恰恰是要记忆的 `cfgFullW`。

### ② 阈值 = 动态测量(cfg-group 实宽 vs bar 可用宽)

纯函数(导出,单测直接断言边界):

```
entry(展开态):  cfgShouldCollapse(toolsW, rightW, avail, gap) = toolsW + gap + rightW > avail
exit(圆点态):   cfgShouldExpand(toolsW, restW, cfgFullW, avail, gap) = toolsW + gap + restW + cfgFullW <= avail
                restW = rightW − cfgDotW(当前投递的圆点行宽),cfgFullW = 最近一次展开态实测自然宽
gap:compose-bar columnGap 运行时读取(computed style),无样式环境回退 CSS 常量 8
```

- **测的是自然宽**:`.cfg-group { flex-shrink: 0 }`——挤压下 chip 不再被 silent shrink/ellipsis 吞掉,溢出直接反映进测量(mask 掉的挤压是测不出来的,这是首版设计最大的坑)。
- **滞回 = 圆点行宽固定**的结果:exit 比的是**记忆的展开宽**而不是当前圆点行宽。天真的当前宽比较在收缩后立刻读出「dots fit」→ 翻回展开 → 溢出且无 RO 再触发(子元素变化不改 bar 盒)→ 卡死在溢出展开态。记忆宽把 exit 抬回与 entry 同一规范阈值(数值上 `tools+gap+right == tools+gap+rest+cfgFull`,right 本就含 cfg),状态成为「avail vs 单一规范阈值」的纯函数,只随真实宽度变化翻转。**无死区无抖动**:浏览器 sweep 769→1200 逐档采样 attr 单值稳定,单阈值落在 1015↔1020(= 规范阈值 659 + sidebar/边距 360),恢复展开即回到 305px 文本态。
- **自愈**:cfgFullW 在圆点态期间可能过期(用户经圆点 popover 换了更长的模型名)。过期会让 exit 误放行 → 展开后首次投递实测新自然宽 → 不 fit 就立即收回去——全部发生在 RO 回调链内,不依赖额外窗口事件。
- 守卫:`avail <= 0`(隐藏 tab)不决策;`cfgW <= 0`(首次投递尚未 observe 到 cfg / ≤768 display:none)不决策——否则会把 0 记成自然宽、下一拍立刻翻回(实测抓到的真 bug)。

### ③ 圆点形态

- `.compose-bar[data-cfg-collapsed] .cfg-trigger`:14px 圆(border-box 含边)、padding/gap 归零、`border-radius: 50%`;`cfg-trigger-text` 与 `cfg-chevron` display:none;`.cfg-dot-letter`(M/E/T,常驻 DOM、默认 none)转 block。cfg-group gap 5px 不变 → 圆点行固定 3×14+2×5 = **52px**。
- **字母 M/E/T 按渲染序定位**:Model / Mode / Thought。"Mode" 的 M 与 Model 冲突,按规格取 E;T 即 i18n label「Thought」首字母。字母是纯类目标识,真实信息走 tooltip。
- **点击行为/popover 链路不变**:同一 button、同一 testid、同一 Radix Popover + cmdk 链;圆点态点开 popover 实测:provider 分组(anthropic/zai)、选项齐全、可视区内、选中即关、attr 不受扰。**tooltip 保留原生 title**(规格拍板保留 `label: value`,沿既有实现,本次未新增也未移除)。

### ④ 三类统一收缩;≤768 不动不叠加

- model/mode/effort 三个 ConfigSelect 都挂 `dotLetter`,attr 是整组开关,无逐个判断。
- **≤768 既有规则零改动**(`.compose-right .cfg-trigger { display:none }` 等 3350 段原样):手机档 triggers 本就 display:none,attr 即使置位也无视觉(圆点样式全部是 display:none 的子元素),700px 实测 triggers none / 列布局不变 / send 可见。「不叠加」= 没有在 ≤768 断点内新增任何规则,圆点规则是无媒体查询的属性选择器,天然止步于手机档。

## 改动文件

- `frontend/src/components/Composer.tsx`:`cfgShouldCollapse`/`cfgShouldExpand` 纯函数 + `composeBarGap` + composeBarRef/cfgFullWRef + RO effect(attr 切换)+ ModelSelect 传 `dotLetter` M/E/T + ConfigSelect 渲染 `cfg-dot-letter`
- `frontend/src/index.css`:`.cfg-group` flex-shrink:0 + `.cfg-dot-letter` + `[data-cfg-collapsed]` 圆点形态三条规则(全部落在桌面区,未触 ≤768 段)
- `frontend/src/components/Composer.cfgdot.mount.test.tsx`:新增 8 测(纯阈值 2 + RO 行为 6)
- `frontend/src/components/Composer.autogrow.mount.test.tsx`:RO 断言从「实例数=1/instances[0]」改为「按观察目标查找 budget RO」(二期起每 Composer 挂两个 RO,原断言钉的是实现计数;budget 行为断言原样保留)
- `frontend/src/components/QueuePanel.list-budget.mount.test.tsx`:同因,`instances.length===2 && every(queue-panel)` 改为 filter 计数 queue-panel 观察者 ===2

## 验证

### 单测 / 构建(bun + vite + go)

- `bun test --isolate`:**480 pass / 0 fail**(65 文件,含本任务新增 8 测;一期/QueuePanel 既有用例零回归,仅按上述更新 RO 计数类断言)
- `npm run build:dev`(tsc + vite):过
- `go build ./...` + `go vet ./...`:干净(本任务无 Go 改动,例行门禁)
- ⚠ `frontend/bindings` 为 codegen 产物不入库:worktree 重置后缺失会让 7 个直接 import bindings 的测试文件报 Cannot find module,`wails3 generate bindings -clean=true -ts -i` 后全绿(非本任务引入,环境项留档)

### 硬测试 mount(全部覆盖)

窄→attr 置位 + M/E/T 字母 + title 保留;收缩后同宽再投递(子元素新尺寸)**确认**收缩不翻转(反当前宽比较的翻面 bug);恢复宽→退出 + 反复同宽投递零翻转(两种形态各 3 连发);过期记忆宽自愈(换长名 → 误展开 → 新测量收回);隐藏 bar(avail 0)不决策;纯阈值边界(308 恰好放下不收、307 收;exit 用记忆宽,240 档拒绝「dots fit」式退出);圆点点击开 ConfigSelect 真链路(`thinking_budget`/`low` 真 id 回调)。

### 浏览器 smoke(vite dev + Chrome `--headless=new`,fixture 挂真 Composer/QueuePanel/index.css + sidebar-sim 复刻双栏,fixture 一次性已删)

| 场景 | 结果 |
|---|---|
| 900px+侧栏(bar 540) | attr 置位,3×14px 圆点,cfg 52px,字母显示/文本隐藏,原生 title 完好,send 可见 |
| 1200px | attr 退出,cfg 305px 文本态 |
| 769→1200 逐档 sweep | 单阈值 1015↔1020;每档 3 次采样 attr 单值稳定,无抖动 |
| 组合态:820px+队列 6 条+901 字符草稿 | **一期/二期独立生效**:圆点 52px(attr 置位)同时 textarea clamp 220px、footer 60vh 内滚、send 滚后可达 |
| 圆点点击 | 真 Radix popover 打开(provider 分组/选项全/视口内),选中关闭,attr 与圆点态不受扰 |
| ≤768(700px) | triggers display:none(既有规则生效),attr 视觉惰性,手机列布局不变,send 可见 |
| 截图 | 收缩态 M/E/T 圆点一行与展开态文本 chip 各一张,入本条存档 |

⚠ **无头帧饥饿坑**:沙箱默认 headless 实例 rAF 500ms 计数为 0(无渲染帧)→ RO 投递被饿死,一切「RO 没触发」的结论在帧流动确认前都是假的(一期 worklog 已记,本卡复踩);换 Chrome `--headless=new`(有合成器帧,rAF 25 次/400ms)后端到端生效。**桌面 GUI(WKWebView)待手测**:600/popout/侧栏挤压三档 + 圆点视觉走查,本环境无法驱动 wails3 窗口,遗留为桌面实测项。

### 三端矩阵(§4.7)

- **远程浏览器(Chromium)**:上表即该引擎验证,全绿。
- **桌面 GUI(WKWebView)**:⚠ 待实测(同上)。风险低:属性选择器 + 标准 flex 几何,`:has()` 级别的兼容风险不存在;RO/offsetWidth 全是 WebKit 常规面。
- **PWA(≤768px)**:CSS diff 不触 ≤768 段;700px 实测 triggers 既有 display:none、attr 惰性、列布局与 send 不变。真机抽查随 M2 遗留项一并走。

## 踩坑

1. **flex 默认 shrink 会 mask 溢出**:首版想靠「实测宽求和 > avail」判挤压,但 shrinkable 子元素被压缩后测量恰好等于 avail,entry 永不触发。修法是给 `.cfg-group`(以及右区各子项的既有 min-content 地板)建立「自然宽可测」前提:`flex-shrink: 0` + 溢出可见,溢出才进得了测量。找不变量:先保证「量的就是自然宽」,再谈阈值。
2. **`cfgW <= 0` 假记忆**:首个 RO 投递(lazy observe 生效前)缺 cfg 条目,happy-dom fallback offsetWidth=0 → 记 0 自然宽 → exit 阈值崩塌立即翻回。守卫:宽度未知的投递不做决策。
3. **共享测试 fake 的裸 trigger()**:一期/QueuePanel 测试的 `FakeResizeObserver.trigger()` 不带 entries 调 cb,二期回调若假设 entries 非空直接 TypeError;回调入口加 `if (!entries) return`。
4. **帧饥饿**:见 smoke 节——无帧环境里 RO/geometry 类验证必须先证帧在流(rAF 计数),否则白测。
5. **环境**:本卡执行中途 worktree 被重置到 HEAD,全部改动凭会话上下文原样重放后重跑全部门禁(480/0 + build:dev + go)复绿;浏览器 smoke 全矩阵重走一遍。

## 下一步

- [ ] 桌面 GUI(WKWebView)三档手测(侧栏挤压/popout/600)+ 圆点视觉走查,回写本条
- [ ] PWA 真机抽查(圆点在手机档不出现,回归即可)
- [ ] fe-review 后停 completed-ready,不自行关闭(硬纪律)
