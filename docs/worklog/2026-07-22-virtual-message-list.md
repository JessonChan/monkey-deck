# 2026-07-22 feat:消息列表真虚拟化(issue #33)—— DOM 节点数从 O(n) 收敛到平台期

## 起因
issue #33:长会话的每条消息都常驻 DOM,DOM 节点数与渲染层内存随消息数**线性增长**。
2026-07-02 的 `content-visibility: auto`(`docs/worklog/2026-07-02-content-visibility-render-opt.md`)
解决了屏外条目的**渲染/绘制**开销(滚动掉帧),但**不卸载 DOM 节点**——内存与节点数仍是 O(n)。
本次要做的是真虚拟化:只让视口附近的行进入 DOM,其余卸载。

## 根因:为什么之前两次虚拟化都失败(不重复踩坑)
- **react-virtuoso 失败**(2026-07-02 记录):动态高度测量下 `atBottomStateChange` 恒 false,
  贴底跟随失效。根因是**库拥有测量与滚动状态**,与我们的贴底/锚点/恢复策略形成多个真相源。
- **自实现 + content-visibility 混用失败**:估算高度 ≠ 真实高度,`scrollHeight` 随渲染漂移,
  像素级滚动定位不稳定,滚动条跳动。
- **共同教训**:虚拟化的核心难点不是"算窗口",而是**高度模型与滚动坐标系的一致性**。
  一旦高度有多个来源(估算 / 实测 / 缓存)、坐标有多套系(CSS padding / offsetTop / scrollTop),
  就会在各种时序下互相打架。

## 设计:单一高度模型 + 五个不变量(§5.3 找不变量,不堆 if)
自研**纯函数核心** `frontend/src/lib/virtualList.ts`(无 React 依赖,可单测),
ChatView 只做薄适配。所有几何量都从**唯一**的 `HeightModel` + `Layout` 算术推导,
不做任何"上一个事件是什么类型"的启发式。

- **W(窗口)**:只有 `[win.start, win.end)` 的行进 DOM。窗口 = 与
  `[scrollTop-overscan, scrollTop+viewport+overscan]` 相交的行区间(前缀和二分)。
  `win` 是唯一 React 状态;`setWinIfChanged` 在区间不变时 bail out → 滚动同窗口内逐帧不重渲染。
- **S(贴底)**:`isAtBottom(total, scrollTop, clientHeight) <= STICK_THRESHOLD(80px)`,纯算术。
  贴底时流式增长 → `scrollTop = total - clientHeight` 钉住底部。
- **A(锚点)**:滚动位置记「视口顶部命中行 id + 条内偏移」(`anchorAt`),不记像素
  (像素随高度收敛漂移,id 稳定)。高度变化时对锚点**上方**行累计 `delta` 补偿 `scrollTop`,
  保持视觉位置不动。
- **P(prepend)**:load more 插入行后,补偿 `scrollTop += 旧首行新top - headH`,用户视觉位置不动。
- **M(测量)**:ResizeObserver 是唯一测量入口,`target.offsetHeight` 写回 `HeightModel`
  (`set` 返回是否变化,避免无谓 version bump)。实测覆盖先验。

### 关键决策:绝对定位 + 头/尾实测区(解决坐标系一致性)
- **坐标系对齐**:布局坐标必须与 `el.scrollTop` 同系。原 `.chat-body { padding: 22px 0 }` 会让
  行 `offsetTop` 与 `scrollTop` 错位 22px → 锚点/窗口全错、贴底裁剪。
  解法:把上下留白从容器 padding 移进**两个实测区** `.cv-head`(padding-top:22px)/
  `.cv-tail`(padding-bottom:22px),容器 padding 归零。`computeLayout(rows, model, tailH, headPad)`
  把 `headPad` 加进所有 `tops`,布局与 scrollTop 严格同系。
- **绝对定位**:`.chat-content` 显式高度 = `layout.total`(撑开滚动条),每行
  `position:absolute; top: tops[i]`。避免流式布局 + spacer 的反馈环;绝对定位创建 BFC,
  子元素 margin 被包含(与原 content-visibility containment 行为一致,子 margin 零改动即像素对齐)。
- **头/尾区高度进布局**:权限卡 / 实时 plan / 打字指示放 `.cv-tail`,加载更多 / 占位放 `.cv-head`,
  两者实测高度(`headHRef`/`tailHRef`)喂给 `computeLayout` → 贴底时底部内容不被裁剪。

### 先验高度从真实数据校准(§5.3 外部事实先验证)
不拍脑袋。从真实 DB(`~/Library/Application Support/monkey-deck/monkey-deck.db`)统计各类型
消息高度 P50,定 `PRIOR_HEIGHT`:`user:45 / agent:90 / thought:48 / tool:56 / plan:120`。
未实测的行用先验估算,随滚动 RO 收敛到真实值。

## 改了哪些文件
- `frontend/src/lib/virtualList.ts`(新增,已先行提交 `60c060a`):纯核心 ——
  `buildRows`(连续 tool 折叠成组)/ `HeightModel`(实测 Map,`set`/`prune`)/
  `computeLayout`(前缀和 + headPad)/ `computeWindow`(二分)/ `isAtBottom` /
  `anchorAt` / `restoreScroll`。本次补 `headPad` 参数 + `TAIL_PRIOR`/`HEAD_PRIOR` 常量。
- `frontend/src/lib/virtualList.test.ts`:27→28 个纯函数单测(含 headPad 坐标系用例)。
- `frontend/src/components/ChatView.tsx`:重写滚动/布局逻辑为虚拟化适配 ——
  `win` 状态 + `modelRef`/`layoutRef`/`rowsRef` 镜像;`computeWinFor`/`setWinIfChanged`/`syncObserved`;
  重写 `useImperativeHandle`(scrollToBottom)/ `onScroll`(rAF 合批 + 锚点 + 窗口)/
  `applyInitialPosition`(锚点恢复 or 贴底)/ 主 `useLayoutEffect`(切 session 剪枝 + 定位 /
  prepend 补偿 / 流式贴底)/ ResizeObserver effect(M + A + S);JSX 改窗口化绝对行 + 头/尾区;
  FAB `onClick` 改清锚点 + 贴底。**删除** `scrollHeightRef` 缓存自愈、`pinRef`/`lastPinAppliedRef`、
  DOM 探针锚点测量等旧补偿机制(被 A/S 不变量连续取代)。
- `frontend/src/index.css`:`.chat-body` padding 归零;`.cv-item` 改绝对定位(删 content-visibility);
  新增 `.cv-head`/`.cv-tail` 绝对区。
- `frontend/src/lib/scrollAnchor.ts` + `.test.ts`(**删除**):锚点逻辑已收敛进纯核心
  `anchorAt`/`restoreScroll`,旧 DOM 探针版不再需要。
- `frontend/src/components/ChatView.virtual.mount.test.tsx`(新增):happy-dom + React 挂载测试,
  断言 W 不变量(DOM 平台期)+ 滚动后窗口外行真卸载(content-visibility 做不到)。

## 验证
- `tsc --noEmit` ✅(0 错)。
- `bun test` ✅ 83 pass / 0 fail(纯核心 28 + 挂载 2 + 既有 53)。
- `bun run build` ✅(仅既有 chunk 体积提示,非本次引入)。
- 挂载测试证明:300→600 条,DOM 中 `.cv-item` 恒 ~12-19 个(平台期,不随 n 增长);
  滚到中部后最末行 `a599` 从 DOM **真卸载**;内容层显式高度 = 布局 total。

## 下一步(需用户实机验收,§4.6 跨平台强制验证)
- **macOS WebKit 实机**(`wails3 dev`):长会话滚动流畅度、流式贴底跟随、切 session 位置恢复、
  load more 补偿、权限卡/实时 plan 在尾区不被裁剪、FAB 显隐。
- Win WebView2 抽检滚动手感;若跨平台差异不可接受则回退(§4.6 硬约束)。
- 已知取舍:浏览器页内查找 / 跨窗口文本选择仅限已渲染 DOM(虚拟化固有);数据层 `ChatItem[]`
  仍是全量(内存收益在渲染层)。
