# 2026-08-27 — 移动端表格策略:≤768px display:block+min-content(#139)(Task #24908)

## 起因

issue #139(手机浏览器 / PWA):agent 回复里的多列 markdown 表格在窄视口下被恶性挤压——某列窄到一两个字宽、每行竖向断行、扫读困难。#136 落地的 `.md-table-wrap { overflow-x: auto }` 在手机上**不生效**:auto layout 把表格压到恰好塞进气泡宽度(scroll 容器无溢出可滚),挤压照旧。

## 根因(探针实证,非推测)

用真实 `index.css` + 真实聊天气泡 DOM 链(`.row` → `.bubble-agent-wrap{flex:1;min-width:0}` / `.bubble-user-wrap{max-width:76%}`)搭 headless Chromium 探针页,390px 视口实测:

- **BASE(#136 桌面规则)**:6 列 CJK 表 minCol **31–43px**、tableW=容器宽、`scrollOn:"-"`——挤压成立且无滚动出路,与 #139 报告一致。
- **C2(table 保持 display:table + table-layout:fixed + 单元格 min-width 下限)**:**fixed 布局算法只读首行单元格的 width,不理会 min-width**——6 列照样均分到 37–49px,CSS2.1 §17.5.2.1 的 MIN/CAPMIN 上抬只在 auto 算法里。方案毙掉。
- **C1(issue 初稿:`display:block + width:100% + fixed + min-width`)**:全部达标(minCol=66、可滚),但短表被拉满气泡宽、且依赖「fixed layout 穿越 display:block 匿名盒」这种 Blink 实测过、WebKit 灰区行为。
- **C3(`display:block + width:max-content + max-width:100% + overflow-x:auto` + 单元格下限)**:全形态达标,即 GitHub markdown 表格的量产组合,Safari/WebKit 天然战场验证。**采纳 C3**,与 Task #24908 规格原文"display:block+min-content"逐字对应。

取样矩阵覆盖:2 列短表 / 6 列 CJK / 长 URL 词元 / 8 列含 "OK""—" 极短单元格 / 行内长 code——min-width 对 max-content 贡献的下限抬升在极短单元格场景同样成立。

## 改法

`index.css` M2 媒体块(`@media (max-width: 768px)`,§3.1 M2 硬约束内)**纯追加**一段:

```css
.md-table-wrap table {
  display: block;
  width: max-content;
  max-width: 100%;
  overflow-x: auto;
}
.md-table-wrap th,
.md-table-wrap td {
  word-break: break-word;
  min-width: 5.5em;
}
```

机制:block 化的表格改为按内容定宽——单元格 66px(5.5em@12px)下限保证任何列不塌成竖条;内容要求更宽时表格越过气泡宽(max-content > max-width:100%),超出部分进 `overflow-x` 在表格自身横滑。对齐不变量:**一个 `<table>` 就是一张列网格**,行间天然对齐,与布局算法无关。锚点沿用 #136 的 `.md-table-wrap`(agent / user-markdown 双 surface 同源,单套规则)。issue 初稿的 `table-layout: fixed` 与 `-webkit-overflow-scrolling: touch` 有意省略(理由见上;后者 iOS≥13 起 momentum 为默认、本项目 PWA 已依赖 dvh 等 modern-CSS 能力)。

改的文件:

- `frontend/src/index.css`(M2 媒体块内 +23 行,>768px 物理隔离)

## 验证

真实样式表端到端(browser 工具,file:// 加载真实 index.css + 真实类名 DOM 链):

- **移动 390px**:minCol 全形态 = **66px**(cellMinW computed 66px)、misalignPx=0(a/u × 5 形态);宽表 scrollWidth 397 > clientWidth 297,程序化 scrollLeft=150 后截图确认网格平移、滚动中列宽/对齐保持;body 无横向泄漏。
- **桌面 1280px**:computed `display:table / layout:auto / minWidth:0px`,hug 宽度与改动前基线逐项一致(a-S2=83px 等)→ 媒体块零渗透。
- 三端矩阵(§4.7/§5.6):
  - **桌面 GUI**:@media 内追加,断点外不可达;1280 计算样式断言即等价像素基线。真 webview 目视未跑(worktree 未起 wails3 dev,与 #136/#24411 的 OPEN 同步留待桌面冒烟)。
  - **远程浏览器**:探针跑在同引擎(Blink);CSS 不触及 WS/binding/resync 通路,无回归面。
  - **PWA/移动**:≤768px 几何全绿即本端验收主体;iOS/Android 真机实测留待用户侧(M2 惯例),engine 侧无灰区(display:block 表格为 GitHub 量产路径)。
- `bun run build`(tsc + vite production):通过(chunk>500kB 警告为既有状态)。
- `bun test --isolate`:**399 pass / 0 fail**(46 文件,#136 表格 mount 测试原样通过)。

## 下一步 / OPEN

- 桌面 webview 目视冒烟(随 #24411 既存 OPEN 一并处理);
- iOS Safari 真机滑动手感(用户侧动作,结果回写本条);
- issue 备选方案里提到的「渐变遮罩提示可滑动」仍未做,P3 观察。
