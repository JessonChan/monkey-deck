# 2026-09-04 新建对话弹窗 harness 宫格选择(#188)

## 背景 / 起因

#188:新建对话弹窗的 harness 选择(`ns-harness-list`)原是纵向列表(每行
radio 圆点 + 16px 图标 + 名字 + command 芯片)。#187 把 KnownCatalog 纳入
PATH 自动发现后,harness 列表可达数十项,纵向长列表把弹窗撑得过长,且
command 芯片挤占横向空间。本轮把选择器改成语义宫格:品牌图标 + 名字的
紧凑卡片,选中态/check 角标,未装灰显,命令收进 tooltip。

## 设计(实现者裁量点与理由)

- **高度控制选「容器 max-height 内滚」**,不选「首屏只显已装 + 全部
  toggle」:滚动零组件状态、所有条目(含灰显未装项)始终可达;toggle 会把
  未装项藏进折叠态,与「未装灰显 + 角标要可见」的诉求自相矛盾,还多一个
  UI 状态与 a11y 负担。`max-height: 256px`(约 3 行)+ `overflow-y: auto`,
  与弹窗内 `ns-baseref-list` 的内滚惯例一致。
- **图标 36px**(任务给定 32–40 区间中值):宫格卡片 ~110–130px 宽,36px
  居中在卡片里视觉权重合适,且仍是 HarnessIcon 的常规调用(组件本体零改动)。
- **角标全部收在卡片边界内**:check(选中)在右上、未装角标在左上。曾考虑
  压线悬出样式,但容器 `overflow-y: auto` 会按规范把另一轴也裁剪,悬出
  角标在首/末列与首行必被切边;收进卡内则与滚动容器无交互,两角标也不会
  相撞(选中未装项时二者共存)。
- **排序 = 稳定排序 + 二元 rank**:`rank = (installed ? 0 : 2) + (id === "omp" ? 0 : 1)`。
  `Array.prototype.sort` 自 ES2019 起稳定,组内天然维持后端既有顺序
  (Supported 的 DefaultID 首位 + #187 目录项尾部追加)。前端字面量
  `DEFAULT_HARNESS_ID = "omp"` 镜像后端 `harness.DefaultID`(该常量不在
  bindings 里)。
- **tooltip 合并走 `data-tooltip-content` + `\n`**,不用 `data-tooltip-html`:
  react-tooltip 已升 v6(6.0.8),v6 的 DataAttribute 集合里**没有 html 属性**
  (v5 的 `data-tooltip-html` 已移除);而本项目 `.react-tooltip` 早有
  `white-space: pre-line`(index.css),`\n` 直接成换行,零新依赖。
- **PWA ≤768 零特判**:`repeat(auto-fill, minmax(110px, 1fr))` 在 390px 视口
  (卡片可用宽 ~338px)自然落 2 列,桌面 560px 卡落 4+ 列;max-height 内滚在
  移动端反而必要——50 项目录若不封顶,workdir/mode 字段会被挤出首屏。

## 改动

- `frontend/src/components/NewSessionModal.tsx`:
  - harness 段 JSX 重写为宫格卡片(`data-testid="ns-harness-grid"` 容器,
    卡片 `ns-harness-${id}`);删 radio 圆点与 command 芯片;选中态加
    check 角标(`ns-harness-check`,lucide `Check`),未装卡加
    `ns-harness-badge-uninstalled` 角标 + `uninstalled` 灰显类;
    tooltip 合并 name + command + 安装态(仅未装行追加
    `newSession.notInstalled`)。
  - 新增 `sortedHarnesses`(useMemo 稳定排序)与 `DEFAULT_HARNESS_ID` 常量。
- `frontend/src/index.css`:`.ns-harness-list` flex 纵列 → grid auto-fill;
  `.ns-harness` 行卡 → 纵向居中卡(ellipsis 单行名字);新增 check/未装
  角标样式;删 `.ns-harness-cmd` 与 `.ns-harness.active .ns-radio`
  (`.ns-radio` 本体保留——worktree 二选一仍在用)。
- `frontend/src/i18n/locales/{zh,en}.json`:`newSession.notInstalled`
  (「未安装」/「Not installed」)。
- `frontend/src/components/NewSessionModal.mount.test.tsx`:fixture 带
  `installed` 位(`h()` 助手);新增 "harness grid" describe 三测:
  宫格渲染数 + 排序(omp 首位、未装在后、组内稳定)、选择交互
  (active 类 + check 角标 + onConfirm 带 id)、未装灰显 + 角标 +
  command 仅在 tooltip;既有测试零回归(fixture 补 `installed: true`)。

## 红线核对

- 弹窗其余字段(mode/workdir/baseref/MCP)零改动;#187 发现链路与后端
  零波及(改动面仅前端 5 文件);HarnessIcon 组件本体未动(仅调用参数
  `size={36}`)。

## 验证

- `bun test --isolate`:564 pass / 0 fail(78 文件,含新增 3 测)。
- `bunx tsc --noEmit`:0 错。
- `bun run build`(tsc && vite build):过(chunk >500kB 警告为存量)。
- **390px 窄屏与桌面目测留人**(任务显式留给人):auto-fill 在 390px 应落
  2 列、桌面 4+ 列,灰显/角标/check 样式待目测确认。
- 三端:后端/binding 零改动,无需 server 模式统一验证;GUI/浏览器/PWA 三端
  共用同一组件与样式,目测时三端各扫一眼即可(无 remote 守卫/WS 分支涉入)。

## 下一步

- 人在桌面 GUI 与 PWA(≤768)目测宫格观感;若嫌 2 列太挤可把 minmax 降到
  96px(390px 仍 2 列,只是卡片更宽),纯 CSS 一行。
