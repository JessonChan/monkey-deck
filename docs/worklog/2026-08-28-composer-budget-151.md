# #151 Composer 预算感知输入上限 + footer 内滚兜底

- **日期**: 2026-08-28
- **Issue**: #151(Task #27975;父规格 #27974)
- **基线**: main = `5b27465`

## 起因

小窗高(600px / popout / 极端窗口)下,输入框固定长到 220px + QueuePanel 多条目时,footer 总高超出视口,发送/停止按钮被推出屏幕外不可达。输入区增长上限是写死的(`Math.min(el.scrollHeight, 220)`),对可用空间毫无感知。

## 根因

1. `Composer.tsx` 的 `autoGrow` 只有静态 220px 上限,不知道视口还剩多少空间。
2. `.chat-footer` 无 max-height/overflow 兜底:footer 内容一旦超出视口就直接溢出(无内滚),按钮不可达。
3. footer 内加 overflow 后,`.slash-popover`/`.mention-popover`(`bottom:100%` 锚 `.composer`)会被裁——这是 #27974 已预告的风险,必须一并处理。

## 改法

### ① 预算感知 clamp(Composer.tsx)

```
height = min(scrollHeight, max(52, min(220, avail − other)))
avail  = window.innerHeight − .chat-body 顶边距离   ← 不是 footer 自己的 rect!
other  = footer.scrollHeight − textarea 当前高度
```

两个测量关键(都是被真实引擎打脸后修正的,见「踩坑」):

- **avail 不能量 footer 自己的 rect.top**:flex 列里 `.chat-body` flex:1 吸走全部剩余空间,footer 永远贴视口底,`innerHeight − footerRect.top` 恒等于 footer 当前高——textarea 永远长不大(实测 600px 窗被压到 58.9px)。正确量度是 `.chat-body` 顶边:footer 最多可以长到 body 顶边(body flex-basis 0 可缩到 0)。
- **other 用 `scrollHeight` 不用 `offsetHeight`**:60vh 兜底生效后 offsetHeight 被钉在 cap 上,会低估真实 base(队列 8 条被算成 140px 而非 ~487px),scrollHeight 报全量内容,capped/未 capped 两种 regime 下公式都精确。

52px 地板对齐 `.composer-input` 的 min-height;预算为负(极端)时落到地板,交给 ② 兜底。预算充足时 `min(220, ≥220)` = 220,与旧行为完全一致。

**重算触发**:

- `resize` 事件(视口变化);
- ResizeObserver 观察 **`.queue-panel`**(队列增减不经过 Composer props)。**不能观察 footer 本身**:60vh cap 一旦生效,footer 的 border-box 钉死不再变化,内容继续长 RO 也不发事件——恰恰在最需要 re-clamp 的时机失明。queue-panel 自己的盒子永远忠实变化,且与 textarea 高度无关,**零反馈环**(旧方案观察 footer 依赖「重算幂等、一次额外触发后收敛」的论证,现方案连这一次都不需要)。
- effect 依赖 `[collapsed]`:折叠时 textarea 卸载 ref 为 null,展开重挂载后重新 attach。

纯函数 `clampComposerHeight(scrollHeight, budget)` 导出供单测。

### ② footer 兜底 + popover 逃逸(index.css)

```css
.chat-footer { max-height: 60vh; overflow-y: auto; }
.chat-footer:has(.slash-popover) { overflow: visible; }
```

- 60vh cap + 内滚是极端兜底(队列条目 max-height 归 #144,本 issue 不做);正常态由 ① 保证 footer 内容 ≤ 可用空间,不触发内滚。
- popover 逃逸用 `:has()`(仓库已有先例 `.md-table-wrap` 规则):菜单开着时释放 overflow,浮动菜单画出 footer 盒外;**取舍**:菜单打开期间 footer 自身暂不能内滚(菜单可见性优先),菜单关掉自动恢复 `auto`(已实测恢复)。

## 改动文件

- `frontend/src/components/Composer.tsx`:`clampComposerHeight`(导出纯函数)+ `composerInputBudget`(DOM 测量)+ 预算版 `autoGrow` + resize/RO 重算 effect
- `frontend/src/index.css`:`.chat-footer` max-height/overflow + `:has()` 逃逸
- `frontend/src/components/Composer.autogrow.mount.test.tsx`:新增 12 测(纯 clamp 三档 + 挂载接线 + resize + RO 目标选择/投递/幂等 + 无 footer 回退)

## 验证

### 单测 / 构建

- `bun test --isolate`:**389 pass / 0 fail**(48 文件,含本任务新增 12 测)
- `npm run build`(tsc + vite production):过(chunk 体积 warning 为存量)
- `go build ./...` + `go vet ./...`:干净(本任务无 Go 改动,例行门禁)

### 浏览器 E2E(vite dev + 真实 Chromium,fixture 挂真 Composer/QueuePanel/index.css,骨架复刻 chat-view;fixture 为一次性文件,已删)

| 档位 | 场景 | 结果 |
|---|---|---|
| 600px | 长输入 | textarea 220px(充足→220),发送钮 bottom 573 ≤ 600 可见,footer 不滚 |
| 600px | 长输入+队列 8 条 | 预算把 textarea 压到 61px(=548−487,精确定点);60vh cap 生效(内容 548 > cap 360)→ footer 内滚,滚到底发送钮 bottom 573 可见 + elementFromPoint 命中按钮本身 |
| 900px | 长输入+队列 4 条 | 220px,发送钮 873 可见,不滚 |
| popout 760px | 长输入+队列 8 条 | 220px,内容 708 > cap 456 → 内滚可达(滚后 733 可见) |
| 极端 400px | 长输入+队列 8 条 | textarea 落 52px 地板,cap 239,内滚后发送 373 可见且命中 |
| 600px | 长输入+开 `/` 菜单 | 菜单开着 footer `overflow-y` 实测变 `visible`(逃逸生效),popover 363..458 全在视口内,首项 hit-test 命中可点 |
| 600px | 关菜单 | overflow-y 恢复 `auto`(兜底还原) |
| 600px | 注入 `slash-popover mention-popover` 类节点 | `:has()` 同样命中(@ 菜单同类选择器) |
| 450px | 动态缩窗+队列 | resize 路径重算(60vh cap + 内滚兜底,发送可达) |

- **RO 在无头浏览器里投递被饿死**(实测:纯 div 探针 0 次回调)——隐藏/无渲染帧的文档不派发 RO。RO 接线的确定性证明在单测(目标选择 = queue-panel、投递 → re-clamp 到 52px 地板、重复投递幂等);真引擎投递本身曾在 600px+队列 场景观察到端到端生效(220→61px)。
- resize 事件路径在真实浏览器实测生效(手动 dispatch → 220 立即重clamp 到 61)。

### 三端矩阵(§4.7)

- **远程浏览器(Chromium 直连形态)**:上表即该引擎的验证,全绿。
- **桌面 GUI(WKWebView)**:**待桌面实测**(本环境无法驱动 wails3 窗口)。风险评估:`:has()` WKWebView 15.4+ 支持,仓库已有 `:has()` 规则在跑;其余是标准 flex/overflow 几何,WebKit 与 Chromium 无已知分叉。⚠ 待办:桌面 600/900/popout 三档手测后关闭。
- **PWA(≤768px)**:同一组件/CSS 生效;移动端 `.composer-input` 的 CSS `max-height:140px` 仍然生效(inline height 被 max-height 钳制,预算只会更小不会突破),footer 兜底同样有益;无桌面专属类被触碰。⚠ 待真机抽查内滚手感。

## 踩坑(对齐 §5.3)

1. **量 footer rect.top 做可用空间是错的**——flex 列中 footer 贴底,该值恒等于 footer 当前高,textarea 永远长不大(首版实测 600px 窗 textarea 只有 58.9px)。「可用空间」的正确不变量是 **chat-body 顶边到视口底的距离**。
2. **capped regime 下 offsetHeight 撒谎**——max-height 生效后 offsetHeight 停在 cap,base 被低估(8 条队列算成 140px),预算失真;scrollHeight 报全量内容,两 regime 统一精确。
3. **RO 观察 footer 在 capped regime 失明**——border-box 钉在 cap 后内容再长也不发事件;改观察 `.queue-panel`(盒子忠实、与自身高度无关,零反馈环)。
4. 无头环境 RO 投递饿死:隐藏文档不派发 RO,任何依赖 RO 回调的浏览器端验证必须先确认帧在流动,否则结论是假的「没触发」。

## 下一步

- [ ] 桌面 GUI(WKWebView)600/900/popout 三档手测,回写本条
- [ ] PWA 真机抽查 footer 内滚手感
- [ ] #144 做 QueuePanel 列表自身 max-height 时,注意与本文 RO 观察 `.queue-panel` 的联动(列表内部滚动不再改变面板高度,预算仍按全量内容算,行为正确但值得回归一遍)
