# 2026-07-18 修复切会话滚动位置错乱:锚点定位 + 内容层收敛 + 钉住

## 起因
用户报告:切换对话时滚动位置不对。期望行为:全新对话拉到最新(底部);看过/滚动过的对话记住上次位置。实测每次打开(含全新)都不在底部,且不同对话错得各不相同。

## 根因(两层,逐层实测挖出)
1. **像素坐标在 content-visibility 下不稳定**。`.row` 等开了 `content-visibility:auto;
   contain-intrinsic-size:auto 120px`(2026-07-02 渲染优化),屏外条目按估算高度参与
   scrollHeight(未渲染过 = 一律 120px);`.chat-body` 又按 `key={sessionId}` 每次切换重建
   DOM,`auto` 的记忆值不跨挂载 → 每次打开都是全新估算。定位(贴底 `scrollTop=scrollHeight`、
   恢复 saved.top 像素)打在估算高度上,真实渲染替换估算后 scrollHeight 变,位置就漂——
   真实均高与 120 差多少漂多少,所以「每个对话错得不一样」。旧代码没有任何收敛机制
   (重定位只在 items 变化/容器 resize 时触发,静态历史加载完就再没人纠正)。
2. **settle 回落把恢复位夹到底部**(第一版修复后实测 trace 抓出的残余):真实均高(如 62px)
   < 估算(120px)时,内容在 settle 期缩水,maxScroll 随之缩,浏览器把 scrollTop 夹到收缩后的
   max = 底部;onScroll 据此把位置记忆改写成 `stick=true` → 下次干脆直接落底。锚点恢复本身
   是对的,缺的是「settle 期间持续跟随锚点」的机制。

**平台放大器**:Chromium 有 scroll anchoring,会部分掩盖症状(e2e 里 HEAD 残余 gap 只有
~30px,高内容会话甚至被救成 0);目标平台 macOS WebKit **没有** scroll anchoring,全量暴露
——正是用户看到的「明显不在底部」。修复方案不依赖任何引擎锚定行为,对所有引擎确定性成立。

## 改法(不变量:位置用「条目 id + 条内偏移」的内容坐标,不用像素;贴底/钉住随内容高度变化持续收敛)
- 每条(工具组)包一层 `.cv-item` + `data-iid`:content-visibility 估算单位从 `.row` 等四个
  选择器收敛到它(每条目一个估算单位),同时作为锚点定位单元。新增 `.chat-content` 内容层,
  与 `.chat-body` 同设 `position:relative`,使 `offsetTop` 与 `scrollTop` 同坐标系。
- **存**:onScroll 里二分找视口顶部命中条目(纯函数 `lib/scrollAnchor.ts:findTopAnchor`),
  记 `{iid, off, stick}`;约定 `off = scrollTop - 条目top`,恢复 `scrollTop = 条目top + off`
  (初版写成 `- off` 偏 2×off,e2e 抓出;单测锁往返约定)。
- **取**:统一定位函数 `applyInitialPosition`(切换分支 + pendingScroll 分支共用):
  有锚点且非贴底 → 恢复锚点;否则贴底。
- **收敛**:内容层 ResizeObserver 观察 `.chat-content`(内容高度变化),与既有的容器观察
  (clientHeight)互补——内容一变:贴底模式重对齐到底(初次贴底的估算误差逐次收敛为 0);
  钉住模式重对齐到锚点(追踪 settle 回落)。
- **钉住(pin)**:锚点恢复后生效,直到用户接管。解除 = 用户输入事件
  (wheel/touchmove/pointerdown/keydown)为主路径 +「与锚点目标值/上次重对齐写入值都偏离」
  双比较兜底(滚动条拖动可能不发 pointer 事件)。钉住期 onScroll 只重存锚点语义
  (stick=false),不被夹取几何改写记忆;FAB/imperative scrollToBottom/切 session 均解除。
- 顺手修掉同区域 bug:切换瞬间挂起的 onScroll rAF 用闭包旧 `props.session` 存位置
  (触控板惯性滚动会把新会话几何记到旧会话名下)→ `sessionIdLiveRef` 实时镜像。

## 改了哪些文件
- `frontend/src/components/ChatView.tsx`:锚点存取 / `applyInitialPosition` / 内容层 RO /
  钉住机制 / `sessionIdLiveRef`;JSX 加 `.chat-content` 与 `.cv-item` 包装(替代 Fragment)。
- `frontend/src/lib/scrollAnchor.ts`(新):`findTopAnchor` 纯函数。
- `frontend/src/lib/scrollAnchor.test.ts`(新):8 用例,含存取往返约定。
- `frontend/src/index.css`:CV 选择器改为 `.cv-item`;新增 `.chat-content`;`.chat-body`
  加 `position:relative`;注释同步更新。

## 验证
- `cd frontend && npx tsc --noEmit` ✓;`bun test` 48 pass(原 40 + 新 8)/ 0 fail。
- **e2e A/B(Wails3 server 模式 + Chromium CDP 驱动,真实 SQLite 数据;
  修复版 vs `git archive HEAD` 构建的未修复版,同一流程)**:
  | 场景 | HEAD(未修复) | 修复版 |
  |---|---|---|
  | 首开 B(1071 条) | gap=0 | **gap=0** |
  | 首开 A(1145 条) | **gap=30(不在底部)** | **gap=0** |
  | A 滚 40% → 切 B → 回 B | gap=0 | **gap=0** |
  | 回 A(恢复 40% 位置) | 像素恢复,碰巧接近(估算≈真实的会话才成立) | **st=571、锚点文本、relTop=-78 与滚前完全一致** |
  | 高内容会话首开(末页均 37KB/条) | gap=0(Chromium anchoring 救的) | **gap=0 且 settle 全程稳定** |
- 调试期用临时 console.log + CDP 抓取确认「恢复执行 → settle 回落夹底 → stick 被改写」全链路,
  定位后移除日志。
- 已知边界(可接受):锚点条目不在当前已加载页时(如翻了很多页旧历史再切走,切回只重载
  首页)退化为贴底——与旧像素恢复同属「数据不在手边」,不更差。

## 下一步
- **桌面 app(WebKit)实测确认**:Chromium 会掩盖症状,WebKit 是全量现场;由用户日常使用验证。
- 观察钉住在「边读历史边收流式事件」会话中的表现(设计目标:锚点稳定不动,新内容不拽走)。

## 关联
- 估算高度来源:`docs/worklog/2026-07-02-content-visibility-render-opt.md`
- 推迟定位骨架(pendingScroll,本次复用):`docs/worklog/2026-07-18-drop-session-items-on-switch.md`
- e2e 基建:`docs/worklog/2026-07-18-server-mode-browser-testing.md`
