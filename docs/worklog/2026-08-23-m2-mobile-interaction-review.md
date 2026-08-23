# 2026-08-23 M2 移动端交互 review:抽屉导航模型 + 触屏/键盘可用性修复

## 起因

用户 review 反馈:「点开侧栏抽屉,在项目上点开(浏览),抽屉也收起来,这肯定不合理;类似的不合理肯定还特别多」。对 M2 全部触屏交互做系统性 review。

## Review 清单与结论

### 已修(两笔提交)

1. **抽屉导航模型(用户报告)**:五个 Sidebar wrapper(selectProject/onCreateSession/onAddProject/openSettings/onSelectSession)全部 `closeDrawer` → 抽屉内一切导航都被打断。**收敛为单一不变量:openSession 才关抽屉**(openSession 开头一行 `setDrawerOpen(false)`,覆盖 tab 点击/模态确认等全部入口;桌面 no-op)。浏览动作(选项目/加项目/开设置/新建弹窗)保持打开;新建会话最终经 confirmNewSession→openSession 在"真正进入对话"那一刻关。
2. **软键盘盖住 composer**:iOS 布局视口不随键盘收缩,100dvh 不够 → `visualViewport` 高度写入 `--md-vvh` CSS var,驱动 `.app`/`.modal-overlay`/settings/new-session sheet 高度 + 键盘弹起时复位 iOS 布局滚动;viewport meta 加 `interactive-widget=resizes-content`(Android 走布局视口收缩)。
3. **iOS 聚焦自动放大**:输入控件 <16px 触发 viewport zoom(composer 14.5px)→ ≤768px 统一 `input/textarea/select { font-size: 16px !important }`。
4. **hover 门控控件触屏不可达**(opacity:0 hover 才现):`.msg-actions`(消息复制/引用)→ 0.55 常显、`.tree-acts`(文件树操作)→ 0.6、`.tabbar-tab-close`/`.file-tab-close`/`.terminal-tab-close` → 0.8。
5. **双击缩放误触**:交互元素 `touch-action: manipulation`(消除 300ms 延迟,保留捏合缩放)。
6. **长按选字/callout 干扰**:导航 chrome(sidebar/header/tabbar/compose-bar/ctx-menu)禁 `-webkit-user-select/-webkit-touch-callout`;**聊天正文保留可选中**(Copy/Quote 选择工具栏依赖)。顺带让长按 contextmenu(session 改名/置顶等)在触屏干净触发。
7. **standalone PWA 刘海/指示条**:`.app` 补 safe-area padding(此前只有抽屉/sheet 有)。
8. **抽屉左滑关闭**:touchstart/end 阈值判定(Δx<-60 且 |Δx|>2|Δy|,防列表竖滑误触);Panel 上挂 React touch props。

### 显式不修(记录理由)

- **sticky :hover 高亮**(点按后残留 hover 背景):修需把全仓 ~50 条 hover 规则包进 `@media (hover:hover)`,diff 巨大 vs 收益(纯视觉残留,点击别处即消)。真机反馈强烈再批量做。
- **小 tap target(<44px)**:msg-action 22px、tab close 15px 等;放大改变行高/布局,牵一发动全身。真机实测后按最痛的逐个加 padding。
- **权限/elicitation 卡片在抽屉开着时被挡在后面**:session 行有 perm-dot 提示,用户收抽屉即见;为它做全局 toast 属过度设计。
- **手机→宿主文件上传**:后端 embeddedContext 通道(Attachment kind:"resource")已就绪,前端入口留 M2.5+。
- **iOS 无 contextmenu 的旧设备**:iOS 13+ 长按即触发 contextmenu,现代设备覆盖。

## 验证

- 抽屉模型 E2E:点非选中项目抽屉保持开 ✓ 开设置(挡住抽屉)关设置后抽屉仍在 ✓ 点 session 抽屉关 ✓ 左滑关 ✓。
- 键盘/触屏静态验证:`--md-vvh=844px` 驱动 `.app` 高 ✓ `input fontSize=16px` ✓ `.msg-actions opacity=0.55` ✓ `touchAction=manipulation` ✓ header `userSelect=none` ✓。
- **桌面零修改第三轮像素比对**:同一 session 对齐后 diff = 848/1,296,000 像素、max delta 1——全部落在 AI 头像**渐变填充**区(文字/边缘/布局零差),定性为两次页面加载的渐变亚像素栅格化差异(不可感知,非布局回归;两轮截图 bbox 完全一致佐证)。前两轮(无 session / 有 session)diff 均为 0。
- `bunx tsc` 过;`bun test` 224 pass + 5 个既有 NewSessionModal 基线失败,零新增。
- ⚠ 键盘行为(visualViewport 缩放、iOS 聚焦不放大)是标准修法但**无法在桌面浏览器仿真软键盘**——真机验证项,与 M2 真机实测一并做。

## 踩坑

- **`go build -tags server` 嵌的是 `frontend/dist` 快照**:改前端后忘了 `bun run build` 直接重起 server,E2E 全部跑在旧 bundle 上(afterProject 假失败一轮)。顺序永远是:改前端 → `bun run build` → `go build` → 重启。
- **E2E 开 session 会写库(lastUsedAt)→ session 列表排序漂移**:跨轮像素基线必须重新生成 HEAD 侧截图(同 db 同导航),不能复用旧基线;行数中途读数(7→8)可能是虚拟列表过渡态,以稳定后 DOM 对齐(title/首行文本)为准。

## 改动文件

- `frontend/src/App.tsx`(openSession 关抽屉、wrapper 还原、抽屉左滑、visualViewport effect、Panel touch props)
- `frontend/src/index.css`(≤768px 媒询:vvh 高度链、16px 输入、hover 门控揭示、touch-action、user-select、safe-area、sheet 高度 var 化)
- `frontend/index.html`(interactive-widget=resizes-content)

## 下一步

- 真机实测(M2 收口条件):iOS Safari + Android Chrome,重点键盘(发送框不被盖、聚焦不放大)、左滑手感、长按菜单、PWA 安装(经 /auth?token=)。
- 若 sticky hover 真机反馈强:批量 `@media (hover:hover)` 包裹(独立 commit)。

## 分支与提交

main,2 个原子提交:fix(抽屉导航模型)/ feat(触屏键盘可用性)+ 本 docs。
