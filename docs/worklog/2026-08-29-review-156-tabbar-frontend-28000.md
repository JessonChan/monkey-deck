# #28000 review #156 前端面终审——NEEDS CHANGES(P2 tabbar 右键菜单继承 drag 区)

## 起因

对 #156(TabBar Chrome 式收缩 + 50 上限)的前端面终审。实现主体是 `60e6717`(daemon 兜底提交,7 文件),验证门修复是 `03d8014`(假时钟挂死 → 真墙上时间,3 文件)。本审覆盖这 10 个文件 + App.tsx 装配点 + i18n + index.css 全量核对。

## 结论:**NEEDS CHANGES**(1×P2 一行修复;修完可过)

### P2:TabBar 右键菜单整个落在 drag 区内,菜单项点击被窗口拖拽吞掉

**证据链(全部源码实证,非推测):**

1. `.tabbar` 是 drag 区:`index.css` L2975 `--wails-draggable: drag`;`.ctx-menu` / `.ctx-item` 全仓 grep **无任何 `no-drag` 覆盖**(App.tsx L176 `<div className="ctx-menu tabbar-context-menu">` 是 `.tabbar` 的 DOM 子节点,style 只有 left/top)。
2. CSS 自定义属性按规范**继承**:菜单项的计算值 `--wails-draggable` == `"drag"`。
3. Wails runtime(v3.0.0-alpha.64,`internal/runtime/desktop/@wailsio/runtime/src/drag.ts`)在 **window 捕获阶段**挂 `mousedown/mousemove/mouseup`(L50-52),TabBar 里 `onMouseDown={e => e.stopPropagation()}`(L178)是冒泡阶段,**拦不住捕获监听**。
4. `primaryDown`(L168)按 `getComputedStyle(event.target)` 读计算值 → 菜单项上按下即 `canDrag = true`;`onMouseMove`(L206)**无位移阈值**,按下后移动 ≥1px 就 `invoke("wails:drag")` 启动原生窗口拖拽,且 `suppressEvent`(L70-78)在 dragging 期间吞掉 click。

**症状**:菜单项(`激活会话`/`移到独立窗口`/`关闭标签页`)在**纹丝不动的点击**下能触发;触控板微漂移(≥1px,日常高频)即变成拖窗口、点击丢失。间歇性、复现容易,三条菜单全中。

**修法(一行)**:全局 `.ctx-menu` 规则(index.css ~L412)加 `--wails-draggable: no-drag;`。全仓唯一挂在 drag 区里的 ctx 菜单就是 tabbar 这个;no-drag 在 drag 区外是惰性属性,对既有 sidebar 行/其它菜单零影响,顺带保护未来再挂进 drag 区的菜单。

**验证要求**:桌面 GUI 真 webview(拖拽行为只存在于 webview 注入 runtime;纯浏览器复现不了原生拖窗)→ 右键 tab → 菜单项按下轻微拖动后松开,应命中菜单项而不是拖走窗口。远程浏览器/PWA:≤768px `.tabbar { display: none }`(L3295)本就不渲染;>768px 浏览器端 no-drag 变量同样修掉「按下移动吞点击」的 suppress 路径,回归点击即可。

### P3 留档(不阻塞)

1. **活动 tab 可被完全裁剪无提示**:50 tab × 34px = 1700px,窄窗口下尾部 tab 被 `overflow: hidden` 静默裁掉,新建/激活的 tab 追加在尾部可能整枚不可见,无任何溢出指示。规格明示「窄窗口裁尾,同 Chrome」,属规格内取舍;但 Chrome 会把活动 tab 滚入视野,本实现无 affordance。建议后续 OPEN:窗口过窄时对 active tab 做 scroll-into-view 或溢出指示(依赖已删的滚动三件套,须与规格决策联动,勿擅自恢复滚动)。
2. **tab 本体无键盘可达性**:`.tabbar-tab` 是 div + onClick,无 `role="tab"`/`tabindex`/Enter·Space 激活;键盘用户只能靠 × 关闭按钮(真 button)。#156 范围内新增的 hint/tooltip 均有 testid 与语义,此项属 TabBar 整体(60e6717)既有的 a11y 欠账,记档待专门 a11y 卡。

### P4 顺手项

- `.tabbar-tab.narrow` 注释算术:dot 7 + gap 6 + close 16 + padding 4 = **33**,靠 `min-width: 34` 兜底到 34。行为正确,注释差 1px,修 P2 时顺手改文案即可。

## 规格逐条核验(全部满足)

| 规格项 | 结论 |
|---|---|
| 滚动三件套全删 | `.tabbar-scroll` 收敛 `overflow: hidden`,组件侧无 scrollLeft/onWheel 残留 ✅ |
| min-width 34 + Chrome 式收缩 | `.tabbar-tab { min-width: 34px }` + `.narrow`;TabBar 以 ResizeObserver 实测 contentRect(flex:1/min-width:0 容器,宽度由父级决定,无内容回灌振荡),`tabs.length × WIDE_MIN(47)` 阈值正确(7+6+0+6+16+padding 12=47),narrow 卸载 title/unread、根节点挂原始标题 tooltip ✅ |
| 50 上限 | `TAB_LIMIT=50`;`registerTab` 双保险(ref 判 hint、updater 重查 prev 判上限,同 tick 双开不破),两条入口(openSession 咽喉 L983 + popout 关窗还原 L866)都收口;delete/evict/popout 均释放名额 ✅ |
| 反模式扫(类型补丁) | `TAB_LIMIT`/`limitHintSeq`/`LIMIT_HINT_MS`/`narrow`/`tabbar.limitTip`/`tabbar-limit-hint` 逐个从定义点追到消费端,全部通电,无空壳字段 ✅ |
| 测试锚定值 | 计数 `toBe(TAB_LIMIT)`、tooltip `toBe("Session 1")`、hint 文本 `toBe("tabbar.limitTip")`,且走真实 `chat:popout-changed` 还原路径灌 51 个 tab;非「字段存在」式断言 ✅ |
| i18n | `tabbar.*` 6 键 en/zh 双语齐,插值 `{{limit}}/{{title}}/{{project}}` 与调用点一致 ✅ |

## 验证(本 worktree 实跑,非转录)

- 环境引导:`bun install` + `wails3 generate bindings`(bindings 是 gitignored 生成物,新 worktree 缺失,非代码缺陷)。
- 两份 #156 测试:`bun test --isolate` → 4 pass / 0 fail。
- 全量:`bun test --isolate` → **415 pass / 0 fail**(62s)。
- 构建:`npm run build`(tsc + vite)通过(chunk >500kB 警告系既有)。
- 三端(§4.7):本次被审 diff 中 `03d8014` 仅测试 + 常量 export,运行时零行为变化;收缩形态本体归属 `60e6717`,其 GUI 视觉验证未随卡留档(worklog 已自认边界)。P2 修复的验证面见上(P2 节),须在桌面 GUI 真 webview 做。

## 下一步

- P2 一行修复由后续 coder 卡落地(P2 节修法/验证要求可直接引用);P3 两项记 OPEN,不阻塞 #156 收口。
