# 2026-08-27 · Review 2accfd6 #140 表格列宽拖拽(ResizableTable)—— PASS(Task #26215)

## 审查对象

`2accfd6` feat(frontend): 表格表头拖拽调列宽——ResizableTable 组件 + 会话内宽度记忆 + 移动三层禁用(#140),共 6 文件(新增 ResizableTable.tsx 261 行 / ResizableTable.mount.test.tsx 275 行,改 ChatView.tsx / index.css / en+zh.json)。配套落地记录:`2026-08-27-resizable-table-140.md`(Task #26214)。

## 结论:PASS

### 1. 类型补丁反模式核查(全链路逐点消费确认)

按「从定义点沿每个调用点确认被读取/渲染/写出」反向追踪,#140 全部新增符号通电:

| 符号 | 定义点 | 消费端 | 实证 |
|---|---|---|---|
| `sessionId` prop(ChatRow→UserBubble/AgentMarkdown) | `ChatView.tsx:881/897/1009` 三处调用全传 | `TableSessionContext.Provider`(AgentMarkdown 返回处)→ `useContext` in ResizableTable + HeadCell | ChatRow 上游 `sessionId={props.sessionId}`(:751)既有接通;三个渲染分支(markdown 长/agent/用户 markdown)零遗漏 |
| `widthsByTable` Map | 模块级(:44) | 写:`persistWidths`(拖拽 end / reset);读:ResizableTable layout effect `applyWidths`、beginResize 基线 `get(key)` | 读写两端都在;all-zero 卫生删除与 LRU 重插序(delete→set)逻辑正确 |
| `.md-col-grip` class | HeadCell 渲染(:250) | CSS hover/dragging accent 条(index.css:647-670)+ M2 块 display:none(:3350+) | 规则真实存在且作用域正确 |
| `chat.colResizeTip` i18n 键 | grip `data-tooltip-content`/`aria-label`(:256-257) | react-tooltip `md-tip` 实例(App.tsx:2516 全局存在);**真实渲染验证解析为文案而非裸键**(见 §4) | 冒烟页 tooltip 文本 = "Drag to resize column · double-click to reset" ✓ |

### 2. React 正确性要点

- **Hook 纪律**:HeadCell 的 `useTranslation`/`useContext` 在 `coarsePointer` 早退之前无条件执行,无条件早退分支。
- **streaming remount 不变量(#21289)**:`table: ResizableTable, th: HeadCell` 都是模块级常量进 useMemo components map,map 身份节奏只随 `[onOpenFilePreview, streaming]`,未把 sessionId 塞进 map——context 下发的方案对 identity 零扰动。✓
- **无依赖 layout effect**:每个 commit 后重盖章是刻意设计; recreated cells 从 store 回贴。拖拽进行中若遇流式 commit,stampColumn 每次现读 `table.rows`(新 cell 也能盖到),store 盖章与在飞 px 之间最多一帧由下一个 pointermove 自纠,无死锁/无悬挂闭包窗口监听(end/cancel 均 removeEventListener)。
- **touch 拒绝与 dblclick 并存**:pointerdown preventDefault 只压 text selection;click/dblclick 属 pointer events 规范中不受取消影响的兼容事件,双击复位路径成立(real-browser 冒烟已实证)。
- **键安全**:tableKeyOf 以 `table.rows[0]`(GFM thead 恒为首行)+ 列数 + 截断 400 字符签名,表头变 ⇒ 键变 ⇒ 陈旧宽度天然失效,契合 §5.3 主键归并不变量;cellIndex/col 边界与 safe-slice 均有守卫。

### 3. 移动三层禁用核验

三层(coarsePointer 不挂载 → touch pointerType return → ≤768px CSS display:none)互相独立、任一成立即死;layer 1 的模块级一次性判定与 Composer 先例同款,layer 2 有专项测试(MouseEvent 带不动 pointerType、PointerEvent 构造器实测,踩坑记录属实),layer 3 位于既有 M2 媒体块内,断点外规则零增量。

### 4. 验证(reviewer 实跑,bare worktree 补装依赖后)

- **定向 + 回归**:补 `bun install` + `wails3 generate bindings`(worktree 缺 gitignored bindings;CLI 用法见下备注)后 `bun test --isolate` → **411 pass / 0 fail**(48 文件,含本任务 5 条,与落地记录口径一致;初次运行的全部失败均为环境缺件,非代码回归)。
- **构建**:`bun run build`(tsc + vite production)通过(chunk>500kB 警告为既有状态)。
- **i18n**:脚本化全量比对 zh/en 键集合,**双向 0 missing**;两文件同位新增 colResizeTip。
- **真实布局冒烟(临时 vite 页 + 生产级 ReactMarkdown+remarkGfm+ResizableTable 管线,headless Chromium,纯静态样张、未触用户数据/后端,审后即删)**:
  - grip 贴 th 右缘(`overlapsEdge=true`)、命中带 9px、`cursor: col-resize`、GFM 对齐 style 经 props spread 保留;
  - **真实 rect 基线拖拽**:基线 169.2px(happy-dom 走不到的 measureCell rect 路径)+ 拖 140px → 整列(th+td)inline width=309px 与期望值精确一致,邻列零污染;
  - 双击复位:列内全部 width 内联消失回到 auto,GFM 对齐保留 —— 覆盖了 mount 测试只能用 MIN 兜底伪造几何的盲区。
- **三端分析复核**:桌面 GUI 为主战场(grip 几何/光标已实证于 Chromium;真 webview WebKit 同为标准 CSS 路径);远程浏览器同一 bundle 直接受益、不触 WS/binding/resync;PWA 三层禁用 + #139 block-display 行为零交集。落地记录的三端口径与代码事实一致。

### 非阻塞备注(P3,均不要求返工)

1. **grip 无键盘可达性**:span + `role="presentation"`,`aria-label` 对 presentation 角色不生效,无法经键盘聚焦调整列宽——与队列拖拽排序等仓内既有自定义拖拽交互一致的仓级缺口,建议将来统一处理(如 role="separator" + tabindex + 方向键)。
2. **node="[object Object]" DOM 属性泄漏**:react-markdown 向自定义组件传 `node` prop,spread 到 `<table>`/`<th>` 出现在 DOM——#136 TableWrapper 同款既有行为,非本次回归,顺手清理可统一去 `node` 再 spread。
3. **AGENTS.md §0.5 命令漂移**:文档写 `wails3 gen bindings`,实际安装的 wails3 CLI(v3.0.0-beta.3)该命令是 `wails3 generate bindings`(`gen` 子命令不存在,打印帮助退出)——工作树首次跑会静默落空,建议改文档或 Taskfile 口径(Taskfile.yml 里已是正确写法)。
4. 拖到容器边缘无 wrap 自动横滚——落地记录已自挂 P3 OPEN,维持观察。

## 下一步

无需返工。桌面 webview 目视确认 grip 手感/hover 条观感(沿用落地记录 OPEN)即可关 #140;上述 P3 备注均不阻塞收口。
