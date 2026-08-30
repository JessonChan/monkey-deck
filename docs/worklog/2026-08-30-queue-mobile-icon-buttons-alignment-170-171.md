# 2026-08-30 队列面板移动端:按钮去文字 + 边距对齐聊天区(#170 + #171 / Task #28437)

## 起因

Task #28437 两件 XS 合一卡,均只作用于 **≤768px 断点**的队列面板:

- **#170 队列按钮去文字**:条目动作行四个带字按钮(`.queue-btn.schedule/.edit/.interrupt/.revoke`)在 390px 下文字挤占触区——改为图标按钮,文字留在 title/aria。
- **#171 边距对齐**:≤768 下 `.queue-panel` 侧边距 12px 与聊天区 28px 不齐,队列块凸出三区对齐线。

## 改法

**A(#170,QueuePanel.tsx + index.css)**:
- 四个按钮的文字各包 `<span className="queue-btn-label">`(`textContent` 逐字节不变,既有按
  `data-testid` 查询/文本断言兼容);四个按钮补 `aria-label={t("queue.<同名>Tip")}`——**复用既有
  title 键,零新 i18n 键**(zh/en locale 零 diff)。
- ≤768 块新增 `.queue-btn .queue-btn-label { display:none }`;40×40 触区由同块既有
  `.queue-btn { min-height/min-width:40px }` 规则继续保证(:3397)。
- **范围红线**:move 两钮(#126B)本就纯图标+aria,勿动;edit/schedule 表单内
  save/cancel/preset/reset/clear 不在范围,勿动;桌面 >768 零变化(span 是 flex 容器里的
  等价 inline 项,`gap:4px` 布局不变)。

**B(#171,index.css)**:
- ≤768 块 `.queue-panel` padding `0 12px` → `0 28px`。**基准=聊天区 28px(orchestrator 裁决,
  不取最小值——队列比聊天区更宽会破坏「消息区/队列/composer」三区对齐线)**;桌面
  `.queue-panel`(:1661)本就 28px,零改动。

## 改了哪些文件

- `frontend/src/components/QueuePanel.tsx` —— 四按钮 +aria-label +文字 span 包装(仅 :666-701)。
- `frontend/src/index.css` —— 仅 ≤768 块(:3389-3400):padding 注释+改值、label 隐藏规则。
  media 块边界实测 :3143-:3515,两处改动全在块内,**>768 样式零触碰**。
- `RawPayloadDisclosure`/复制契约/其他 queue 样式零波及(git status 仅上述 2 文件)。

## 验证

- **单测**:`bun test --isolate` 全量 **486 pass / 0 fail**(65 文件)。
- **类型/构建**:`bunx tsc` 干净;`bun run build` 通过(仅既有 chunk-size 警告)。
- **Go 门**:Go 零改动(未跑,无改动面)。
- **390px DOM 矩形实测(headless Chromium + 真实 dist 样式表)**:注入真实骨架
  (`.row` 消息行 + 真实 QueuePanel 动作行骨架 + `.composer`),量内容盒两缘:
  - `.row` / `.queue-panel` / `.composer` 内容左缘 **均 =28px**、右缘 **均 =36px+390-28=362px**
    ——三区两缘等值,#171 对齐达成。
  - `.queue-btn-label`:`display:none` 且 `offsetParent===null`(出盒出 a11y 树);
    `.queue-btn.schedule` 实测 **40×40**(#170 触区保持)。
- **桌面零变化实证(1280px 同页 A/B)**:裸文字节点版(HEAD 的 JSX 形态:`<svg/> + " 文字"`)
  vs span 包装版,四按钮 `getBoundingClientRect` 逐字节相等(left/top/width/height/字号全同)
  ——span 是 flex 容器内等价单项,桌面渲染无差。
- **三端矩阵(§4.7)**:后端/binding/事件通道零改动,三端共用同一份样式表与组件。
  - 桌面 GUI:>768 无新规则(media 块包含)+ 1280px 矩形恒等实证,零回归;
  - 远程浏览器/PWA:390px 实测即 Chromium 移动布局类(远程端同引擎族),队列面板无
    WS/binding 新依赖;`RawPayloadDisclosure`/`isRemoteClient` 守卫分支零触碰;
  - 桌面 webview(WebKit)端布局由构造保证(纯 CSS 值变更,无引擎相关特性);
    **390px 真机手感(iOS Safari / Android Chrome)留人实测**,不据此关闭。
- **worktree 环境坑**(与 #169 条目同款,复记):新 worktree 缺 `node_modules` 与
  `frontend/bindings`,`bun install` + `wails3 generate bindings` 后全绿。

## 下一步

- 无(任务即终:不派 review、不 push、不关 issue)。
- 真机(≤768 实机 iOS/Android)手感回写后由人确认 #170/#171 关闭。
