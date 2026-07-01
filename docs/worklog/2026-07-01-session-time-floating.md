# session 标题尾部相对时间浮层

**日期**:2026-07-01
**类型**:feat(UI)

## 起因

用户想在侧栏 session 行标题尾部显示最后更新时间(相对格式:刚刚 / N小时前 / N天前 / N个月前 / N年前),且明确要**悬浮**(非拼接)——时间不是标题的一部分,而是 **z 值更高的浮层**,像伪元素叠在标题尾部之上。位置:浮在状态点(尾部小圆点)的左边。

## 设计决策

1. **数据源用 `updatedAt`,非 `promptedAt`**:用户明确指定。`promptedAt` 是发消息时刻(专用于排序),`updatedAt` 是最后更新(含工具/状态变更),更贴「最后更新」语义。
2. **B 方案(absolute 浮层,非拼接)**:`.session-time { position:absolute; right:24px; z-index:1 }`,定位在状态点左侧,叠在标题尾部之上。「z 值更高」的本质 = 上层盖下层。
3. **实色底挡标题**:浮层 `background: var(--sidebar-solid)` 不透明——否则标题文字会从底下透出糊成一团。这是 absolute 浮层盖文字的必要条件。
4. **hover/active 跟随**:行 hover/active 时背景变(叠加色),浮层用 `box-shadow: inset 0 0 0 9999px var(--hover/--sel)` 叠加同色(同 `.project-item` 吸顶手法),避免浮层在亮行里突兀。
5. **阶梯边界**:刚刚(<1h)/小时(1-23h)/天(1-31d)/月(32-364d)/年(≥365d)。关键修正:**用 `day < 365` 判断转年,而非 `month < 12`**——365 天 ≈ 11.98 月会被 `month < 12` 截断成「11 个月前」,实际应「1 年前」。eval 验证全边界通过。

## 改法

- 新建 `frontend/src/utils.ts`:`timeAgo(ts)` 纯函数。
- `Sidebar.tsx`:`import { timeAgo }` + `session-label` 后渲染 `<span className="session-time">{timeAgo(s.updatedAt)}</span>`。
- `index.css`:`.session-item-main` 加 `position: relative`(浮层定位基准);`.session-time` 浮层样式 + hover/active inset 叠加。

## 改了哪些文件

- `frontend/src/utils.ts`(新,`timeAgo`)
- `frontend/src/components/Sidebar.tsx`(+ import + 时间 span)
- `frontend/src/index.css`(+ `position:relative` + `.session-time` + hover/active)

## 验证

- `timeAgo` 边界 eval 验证:`0 / 30min / 59min / 1h / 23h59m / 1d / 31d / 32d / 100d / 364d / 365d / 730d / future` 全对(365d=1年前,32d=1个月前,future=刚刚)。
- `bun run build:dev`(含 `tsc`):389 模块构建通过。
- GUI 浮层视觉(遮挡效果 / hover 跟随 / 位置间距)待实机。

## 下一步

- `right:24px` 像素微调:状态点宽度不一(spinner 11 / unread 7 / perm 8),实测看间距是否均匀。
- 时间是否要实时刷新(每分钟 tick):当前静态渲染,切/进 session 时更新。如需「刚刚」→「5 分钟前」渐进显示,加定时器。
