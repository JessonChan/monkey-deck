# 2026-08-04 chat-selection-virtualization-flow.md

## 起因

用户报告:聊天区「选中文本」(b00fa0f 加 `user-select: text` 后)依然无法复制。**精确症状**:
> 每次选中一个词,它就横向地把这个词上面的所有内容选中,不是鼠标划中的范围。

b00fa0f 只是把 `user-select: none`→`text`,让选中「能发生」,但选中**范围错乱**——选词变成选上方全部。

## 根因

**虚拟化行 `.cv-item { position: absolute }` 破坏 WebKit 文本选区几何。**

WebKit 计算跨多个 `position: absolute` 兄弟元素的选区时,无法把视觉位置正确映射回 DOM 顺序 → 选区锚点错误地落在容器顶部,向下延伸到点击点 →「选一词选中上方全部」(横向满宽)。Chromium(Blink)表现不同(选不中/范围异常),但同根:`position: absolute` 行与原生文本选区不兼容。

这是一类已知问题:虚拟列表用绝对定位行做窗口化,代价是丢失正常流的选区语义。b00fa0f 的 `user-select: text` 是必要不充分条件——能选,但选区几何被绝对定位搞坏。

> 勘误:b00fa0f worklog 把根因归为「`.chat-body` 缺 `user-select: text` 覆盖」,只对了一半。气泡元素早就有 `user-select: text`,真正的阻断是绝对定位行,不是 user-select 继承。

## 改法

**窗口化行从「绝对定位」改成「正常流 + 上下 spacer」**——保留窗口化(只渲染可视行,内存不随消息数增长),同时恢复正常流选区。

```
旧:.chat-content(height=total) > .cv-head(abs) + .cv-item(abs, top=tops[i])* + .cv-tail(abs)
新:.chat-content(正常流)     > .cv-head(流) + [topSpacer] + .cv-item(流)* + [bottomSpacer] + .cv-tail(流)
```

- `topSpacer = tops[win.start] - headPad`(行 [0,start) 的滚动空间)
- `bottomSpacer = tailTop - (tops[win.end-1]+heights[win.end-1])`(行 [end,n) 的滚动空间)
- 自然流总高 = head + spacers + 窗口行 + tail = `layout.total`(代数可证,见验证)→ 滚动总高不变,窗口化/贴底/锚点不变量(W/S/A)不受影响。

CSS:`.cv-item` 由 `position:absolute` 改 `display:flow-root`(建立 BFC 包含子 margin,替代原绝对定位的 BFC 作用,且不裁剪溢出——`contain:content` 的 paint 会裁掉宽代码块/mermaid);`.cv-head/.cv-tail` 同理去绝对定位改 flow-root;新增 `.cv-spacer`(仅 inline height)。

`.cv-item` 暴露 `data-cv-top={layout.tops[index]}`:模型坐标(组件 anchorAt/restoreScroll 的同一坐标系),供测试/调试观测(替代旧实现的 `style.top`)。

## 改了哪些文件

- `frontend/src/components/ChatView.tsx`:
  - 渲染结构:去 `.chat-content` 显式 height、`.cv-item/.cv-head/.cv-tail` 的 `style.top`,改正常流 + 上下 `.cv-spacer`(spacer 高度由 layout 模型算出)。
  - `.cv-item` 加 `data-cv-top`(模型坐标,测试用)。
  - 新增 topSpacer/bottomSpacer 计算(`headPad`/`renderedBottom`,正常英文注释 §3.7)。
- `frontend/src/index.css`:`.cv-item/.cv-head/.cv-tail` 绝对定位→flow-root;新增 `.cv-spacer`;注释转英文(§3.7)。
- `frontend/src/components/ChatView.virtual.mount.test.tsx`(测试适配新模型):
  - `scrollHeight` mock:旧读 `.chat-content.style.height`(已不存在)→ 改为累加流子元素高度(head+spacer+items+tail),镜像真实布局引擎。
  - 新增 `contentHeight`/`itemOffsetTop`/`childH` 流几何 helper(替代旧 `style.height`/`style.top` 读取)。
  - 锚点稳定测试:锚点查找改用 `data-cv-top`(模型坐标,与组件 anchorAt 一致;旧用 `style.top` 即模型坐标)。
  - 补 `ChatService.GetSessionMcpServers` mock(预存缺失:McpChip 挂载抛错致所有渲染 ChatView 的测试全红)。
- `frontend/src/components/msgmeta.duration.mount.test.tsx`:补同上 mock(解除该文件 5 个测试的 McpChip 级联阻塞)。

追加(`9af7485`):`.chat-body` 加 `overflow-anchor: none`——见下方调研。

## 调研对比与决策(是否采用成熟库)

用户提问:这是不是通用问题?有没有更成熟的方案值得采用?结论:**是通用问题;本方案与最成熟的库 react-virtuoso 渲染技术一致,无需换库。**

虚拟列表 + 文本选中是两类独立问题:
- **A 几何**:`position:absolute` / `transform:translateY` 行破坏 WebKit 选区几何(选词选中上方全部)——即本次 bug。
- **B 卸载**:窗口化卸载 DOM 节点 → 跨窗口选段在滚动时断。所有库都中招。

各库做法(读源码/issue 实证,非网传):
|库|行定位|选中几何(A)|跨窗口选中(B)|
|---|---|---|---|
|react-window|`position:absolute` + 滚动时 `pointer-events:none`|坏(issue #732)|坏|
|@tanstack/react-virtual|`transform:translateY`(默认)|坏|坏|
|**react-virtuoso**|**正常流行 + `paddingTop/paddingBottom` spacer + `overflowAnchor:none`**|**好**|坏(同 B,行业未解)|
|本项目(本次)|正常流行 + `.cv-spacer`(因有 head/tail 区,用 spacer div 而非 padding)+ `overflow-anchor:none`|好|坏(同 B)|

> 勘误:网搜有文章称 react-virtuoso 用 `transform:translateY` 移容器——**错误**。读其 dist(`react-virtuoso@4.18.11`):列表 `style:{paddingTop:offsetTop, paddingBottom:offsetBottom}` + 子项正常流 map(L3316-3320);`overflowAnchor:"none"`(L2459/2779)。即 spacer + 正常流,与本次方案同源。

决策:保留自研。理由:(1) 本方案 == react-virtuoso 的渲染技术(正常流+spacer),对几何问题已是业界最稳解,优于 react-window/tanstack(它们选中坏);(2) 本项目曾试 react-virtuoso 失败(virtualList.ts 顶部:atBottomStateChange 黑盒 + 动态高度无持久模型),自研的 W/S/A/P/M 算术不变量正是为了根治那两点,换库等于丢掉;(3) 从 react-virtuoso 借鉴的关键点 `overflow-anchor:none` 已补上(流式行下浏览器滚动锚定会与组件 `el.scrollTop+=Δh` 补偿双重叠加致抖动)。

B(跨窗口选段)行业无库原生解决,标准稳健解是「自定义选区状态」(选区存数据下标 + 自定义 Copy,解耦 DOM 生命周期)——对聊天场景过重(用户多复制单消息/单代码块,可视范围内已正常)。可选轻量解:`setWinIfChanged` 检测活跃选区时取窗口并集(只增不减)。

## 验证

- **选区修复**(独立 HTML 复现,非本项目软件):绝对定位行拖选错乱 / 选不中;正常流行拖选精确(15 字符,无「选中上方」)。WebKit 下用户实测症状与绝对定位选区 bug 完全吻合。
- **spacer 几何**(独立复现,模拟 RO 收敛后用实测高度):窗口化总高 == 全量渲染总高(985==985);窗口化行像素位置 == 全量渲染位置(item5 269==269,item6 308==308…)。证明滚动几何/不变量保持。
- `bunx tsc --noEmit`:通过(0 error)。
- `bun test`:`174 pass / 5 fail`(改动前 159 pass / 20 fail)。ChatView 虚拟化 10/10、msgmeta duration 5/5 全过。剩 5 个 fail 均为 **NewSessionModal**(`toHaveBeenCalledWith` 断言),与本次改动无关(未触及 NewSessionModal),系预存。
- 桌面 app 实测待用户确认(Wails3 dev 下选聊天文本→粘贴验证)。

## 下一步

- 用户在桌面 app 实测:聊天区选词/选段→⌘C→粘贴,确认选区精确。
- 已知次要点(本次未做):拖选跨多屏时,滚动触发窗口重算会卸载选中行外的节点 → 跨屏选段仍可能断。常见复制(单消息/单代码块/可视范围内)已正常。如需彻底,可在 `setWinIfChanged` 检测活跃选区时取窗口并集(只增不减),代价是选中期间 DOM 增长。
- 代码查看器(FilePreview/DiffView 的 `.cv-body/.cv-code/.cv-line`)若同样用绝对定位行,可能有相同选区问题——未排查,用户未报。
