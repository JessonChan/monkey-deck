# 2026-08-27 — 表格表头拖拽调列宽:ResizableTable + 会话内记忆 + 移动三层禁用(#140)(Task #26214)

## 起因

issue #140:聊天里的 markdown 表格(#136 有了网格与横向滚动,#139 解决了手机挤压)列宽仍由引擎 auto layout 一手包办——用户想强调某列(如命令列加宽、日期列收窄)没有任何手段。本任务给每个表头单元加拖拽手柄,列宽即拖即得,并在会话生命周期内记住用户的选择。

## 设计决策

- **独立组件 `ResizableTable.tsx`**,不动 react-markdown 管线:`table` 渲染器换成 `ResizableTable`(保留 #136 的 `.md-table-wrap` 滚动骨架),`th` 换成 `HeadCell`(原语义 + 追加拖拽 grip)。二者都是**模块级稳定组件**——streaming remount 不变量(Task #21289)靠 context 而非每实例闭包维持。
- **会话 id 用 React context 下发**(ChatView `AgentMarkdown`/`UserBubble` 新增 `sessionId` prop → `TableSessionContext.Provider`),不把 sessionId 塞进 components map 依赖:map 身份节奏不变,切换 session 时 chat-body 本就以 key 重挂载。
- **宽度记忆存模块级 Map**(键 = `sessionId \0 首行表头签名|列数`),值 = dense number[](0=自动)。只在内存、不落 localStorage/SQLite——issue 明确「会话内」。表头签名变(流式改写/重排)⇒ 键变 ⇒ 陈旧宽度天然失效,契合 §5.3 主键归并不变量。LRU 上限 256 张表防长驻泄漏。
- **应用方式是「整列盖章」**:受控列的 th+td 全部打 inline width;无宽度的列完全不碰。**没有切 table-layout:fixed**——#139 实测过 fixed 无视 min-width 的坑,auto layout + 单列约束保住其余列的 fill-width 行为。
- **再盖时机 = 每次 commit 后的 layout effect(无依赖数组)**:react-markdown 每个 streaming chunk 重建元素树,复用的 DOM 自带 inline style、新建的 commit 后补章,两种情况拖出来的宽度在整个 turn 内可见。

## 移动三层禁用(#140 规格原文)

1. **粗指针设备 grip 根本不挂载**:`coarsePointer`(`pointer: coarse`,模块级一次性判定,同 Composer 先例);
2. **touch 始终启动不了拖拽**:`beginResize` 里 `e.pointerType === "touch"` 直接 return——兜住 layer 1 漏数的混合设备(触控板 + 手指点屏);
3. **≤768px CSS 兜底隐藏**:M2 媒体块内 `.md-col-grip { display: none }`——即使前两层在某个混合设备上同时失效,CSS 也关死;≤768px 本就是 #139 的横滑天下,不给 Sculpture 留口子。

三层互相独立,任何一层成立即不可拖。

## 改的文件

- `frontend/src/components/ResizableTable.tsx`(新增):grip 组件、宽度 store、tableKeyOf/applyWidths/stampColumn/clearColumn/measureCell、pointerdown→window move/up 监听(setPointerCapture 尽力而为)、双击复位;
- `frontend/src/components/ChatView.tsx`:import;AgentMarkdown/UserBubble 增加 sessionId 透传(ChatRow 两处调用点);components map `table: ResizableTable, th: HeadCell`;输出树包 Provider;删除被取代的 TableWrapper(其注释职责并入新文件);
- `frontend/src/index.css`:`.md-table-wrap th { position: relative }` + `.md-col-grip` 系列(hover/拖拽态 accent 条)+ M2 块 display:none;
- `frontend/src/i18n/locales/{en,zh}.json`:`chat.colResizeTip`(§4.5 tooltip 纪律,grip 带 data-tooltip-id="md-tip" 与 aria-label);
- `frontend/src/components/ResizableTable.mount.test.tsx`(新增,5 条)。

## 验证

- **mount 测试(真实 React 树 + 真实 remark-gfm 管线,happy-dom)**:
  - agent 气泡表格每格 th 长一个 grip 且位于自身 th 内、wrap 骨架完好;
  - 拖拽(PointerEvent 序列 down/move×2/up)提交 clamp 后 px 到整列(th+tbody 全列含 inline width),邻列零污染(happy-dom 无布局 ⇒ rect=0 ⇒ measureCell 走 MIN 48 兜底,数值可断言);
  - **会话内记忆**:卸载后同 session 重挂载同签名表格 → 宽度自动回贴;
  - 双击复位:该列回到无 style 属性(auto),清空后 store 条目删除(all-zero 卫生);
  - touch pointerType 不产生任何宽度(touch 层实测——测试环境用真 PointerEvent 构造器; MouseEvent 带不动 pointerType,踩过验证过)。
- 开发中实证的两个坑(已修):happy-dom 缺 `HTMLTableSectionElement.rows` ⇒ tableKeyOf 改读 `table.rows[0]`(GFM 输出首行必为 thead 行);测试环境无裸全局 `HTMLTableElement` ⇒ instanceof 换成 closest 标签选择器保证的产品语义等价。
- `bun test --isolate`:**411 pass / 0 fail**(48 文件,含本任务 5 条与 #136 表格 mount 测试回归全绿)。
- `bun run build`(tsc + vite production):通过(chunk>500kB 警告为既有状态)。
- 三端矩阵(§4.7/§5.6)如实记录:
  - **桌面 GUI**:功能主战场;改动全部落在既有 `.md-table-wrap`/th 作用域内、纯标准 CSS(position:absolute/touch-action/user-select),>768px 断点外规则为零新增布局面。真 webview 目视未跑(worktree 未起 wails3 dev,沿用 #136/#24411 同款 OPEN),grip 光标/hover 条需桌面冒烟确认观感;
  - **远程浏览器**:同一 bundle 直接受益,grip/hover 为标准 pointer 交互;CSS 不触及 WS/binding/resync 通路,无回归面;
  - **PWA/移动**:三层禁用下 grip 不可见也不可触发(coarse 判定 + 媒体查询双保险),#139 block-display 行为零影响;指针层 (layer 2) 有专项测试。真机复核随 M2 既存 OPEN 一并走用户侧。

## 下一步 / OPEN

- 桌面 webview 目视冒烟:grip 命中区手感(collapsed border 上右缘 9px 条)、hover accent 条观感、拖拽流畅度;
- 可选打磨(P3,先观察):拖到容器边缘时的 wrap 自动横滚、i18n tooltip 文案微调。
