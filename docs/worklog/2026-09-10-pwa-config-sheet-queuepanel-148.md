# 2026-09-10 feat(frontend): #148 二期 —— PWA 配置 sheet(A)+ QueuePanel 移动视觉(B)

## 起因

#148 二期两件一起:

- **A(主诉求)**:PWA(≤768px)上 Composer 的模型/参数选择完全缺失——桌面 cfg-trigger
  行在移动端被 `display:none` 一刀切(M2 时的方案),手机用户无法切 model/mode/thought_level。
- **B**:QueuePanel 移动端视觉糙——桌面单行布局直改 CSS 后,琥珀满屏、三态不分、正文被挤没。

约束:全部改动限 ≤768px 断点(桌面零修改)、数据通道零改动(`onSetConfig →
SessionSetConfigOption` 本就通用,纯呈现层)。基线 83323f0。

## A:PWA 配置 sheet

### 现状锚点

- `cfg-trigger` 渲染:`Composer.tsx` 的 `ConfigSelect`(`title` + chevron + 当前值);
  桌面三组(model/mode/thought)各一个 Radix Popover + cmdk。
- 移动隐藏:`index.css` ≤768px 块 `.compose-right .cfg-trigger { display: none; }`(保留,见下)。

### 改法

**新组件 `MobileConfigSelect`(`Composer.tsx`,与 `ModelSelect` 同文件导出)**:

- **chip**:当前 model 短名(`"zai/glm-5.1"` → `glm-5.1`,value 去 provider 前缀)+ ▾,
  40px 触控高度,渲染在 `.compose-right`(`ModelSelect` 之后、usage 之前)。
  挂载由 `mdMobile` 门控——**桌面 DOM 逐字节不变**(chip 在 >768px 根本不存在)。
- **`useMobileViewport()` hook**:matchMedia `(max-width: 768px)` 读一次 + change 监听,
  与 App.tsx `mdViewport` 同惯例(MOBILE_BP=768)。
- **bottom sheet**(`createPortal` → body,z-index 65 = modal-overlay 层):
  - model 组保留 **cmdk 搜索**(多模型列表的必要件),provider 分组与桌面 popover 同构
    (value 按 `/` 前缀聚合),当前值 `.active` 高亮;
  - mode / thought_level **降级原生 `<select>`**:触屏原生滚轮即最成熟的 picker,顺手绕开
    Radix Popover 在 sheet 场景的定位/focus-trap 实测风险(KISS,不造轮子);
  - 打开 sheet 触发 `onRefreshConfig()`(与桌面 popover 同一条防抖重拉契约);
  - Esc(§4.2)+ scrim 点按 + ✕ 三路关闭。
- **数据通道零改动**:所有选择走 `onSetConfig(<ConfigOption.id>, value)`——真实 id,
  非硬编码类别名(与 ModelSelect.mount.test 钉的契约同款)。

### 决策点(为什么这么选)

1. **mode/thought 选完不关 sheet**:这两项常一起改(plan + high),原生滚轮收起时把 sheet
   一起关掉体感像 glitch;model 选完照桌面惯例关。测试断言了这个差异。
2. **最近使用(recent models)不进 sheet**:cmdk 搜索在触屏上已是最快路径,少一份
   localStorage 读写;桌面 popover 原样保留 recent。
3. **成本提示(ctx hint / 单轮预估成本)不进 sheet**:桌面 popover 的密度件,移动 sheet
   以「快切」为定位;§4.4 人话原则下少一份半截数据。后续要加走既有 `estimateSwitchCost`。
4. **桌面 cfg-trigger 的移动端 display:none 保留**:chip 是「配置入口的补充实现」,不是让
   桌面 trigger 在手机上现身——否则 chip + 三 trigger 双份 UI。

## B:QueuePanel 移动视觉(截图先行)

### 实施前截图(375×812 仿真,真实组件 + 真实全局 CSS)

用一次性 vite 入口(`queue-shot.html + src/queue-shot.tsx + vite.queue-shot.config.ts`,
已删)挂真实 `QueuePanel`/`Composer`,Playwright headless-shell 实拍。**问题清单**:

|#|现状|问题|改法|
|---|---|---|---|
|1|每张卡都带桌面继承的 3px 琥珀左轨,badge/标题也全是琥珀|四卡满屏琥珀,面积/饱和度失控|移动端轨道默认中性灰,琥珀只剩面板标题 + header 时钟|
|2|待发/定时/循环三态无任何视觉区分(全琥珀)|层次不可辨|**三态轨道 + badge 同色系**:灰=待发、蓝(`--accent-2`,定时动作家族)=定时、紫(#bf5af2 系,空态 logo 同族)=循环;双态并存时紫轨(循环更「活动」),badge 各自保色|
|3|正文 nowrap 单行省略,badge `shrink:0` 260px|排队消息这个主内容反而最不可见(实测压到 ~90px)|3 行 `-webkit-line-clamp` 换行 + `min-width:140px` 底线(被挤就换行,短文本+窄 badge 保持同行)|
|4|卡片 padding 7×10、行距 5px、行高节奏乱|与 40px 触控按钮族不协调|padding 10×12、卡间距 8px、gap 10px,读态 badge 10→11px|

### 落地

- `QueuePanel.tsx`:`.queue-item` 行加 `data-scheduled` / `data-repeat` 两个独立布尔属性
  (读态着色钩子;桌面 CSS 不读,desktop DOM 语义不变)。**不动任何回调/数据流。**
- `index.css` ≤768px 块新增上述三态配色 + clamp + 节奏规则(桌面规则零触碰)。

## 改了哪些文件

- `frontend/src/components/Composer.tsx`:`useMobileViewport` + `MobileConfigSelect`
  (chip + bottom sheet),Composer 挂载点接线。
- `frontend/src/components/QueuePanel.tsx`:行级 `data-scheduled` / `data-repeat` 属性。
- `frontend/src/index.css`:≤768px 块内 chip/sheet 样式 + QueuePanel 三态/节奏样式。
- `frontend/src/i18n/locales/{zh,en}.json`:`composer.cfgSheetTitle`、`composer.cfgChipTip`。
- `frontend/src/components/Composer.cfgsheet.mount.test.tsx`(新增):8 条。

## 验证

- **单测**:`Composer.cfgsheet.mount.test.tsx` 8/8 pass——hook 两侧断点、chip 短名、
  点开 sheet、三组选择回写 `onSetConfig(<真实 id>, value)`、mode 选后不关门、
  Esc/scrim 关闭、onRefreshConfig 契约。既有 `ModelSelect.mount` 3/3、
  `Composer.mount`/`cfgdot` 全绿。
- **QueuePanel 全家零回归**:11 套件 56/56 pass(schedule/repeat/countdown/mobile-reorder
  等),新增 data 属性为纯增量,无断言改写。
- **全量 602**:598 pass / 4 fail——失败为 `App.worktree-guard` 4 条,**干净树上 stash
  本次全部改动后复跑同样 0 pass/4 fail**(2026-09-08 worklog 已记录的 chatservice-mock
  静态 import 环境问题),非本次引入。
- **tsc + build**:`bunx tsc --noEmit` 0 错;`bun run build` 通过。
- **桌面零 diff 断言**:同一 harness,1280×800 桌面视口,HEAD 版 index.css(stash)与
  改后版各拍一张 QueuePanel——两张 PNG **byte 级相等**(cmp 通过),桌面路径零变化实证。
- **375px 实拍前后对照**:
  - 前:四卡琥珀满屏、card2 正文压到 "review #148 二…"(badge 占 260px)、card3 三行
    高低不齐、三态全琥珀不可辨;
  - 后:灰/蓝/紫三轨分明、正文 3 行全读("review #148 二期的 sheet 实现,重点看桌面零
    diff 与 safe-area 处理"完整可读)、card3 蓝/紫 badge 各占一行、琥珀只剩标题行;
  - A:chip「glm-5.1 ▾」在底栏,点开 sheet:搜索框 + provider 分组 + 当前值高亮 +
    模式/思考双原生 select,中文文案正常,scrim/关闭键齐备。
  - 几何探针:375px 下 `scrollWidth == 375` 无横向溢出,sheet 全宽 375。
  - 截图为 /tmp 仿真件(易失),对照要点已固化在上表与本节文字。

### 三端覆盖(§4.7)

- **桌面 GUI(>768px)**:挂载门控 + 全部样式限 ≤768px 块;1280px 前后 PNG byte 级相等
  实证零 diff;ModelSelect 桌面路径行为由既有 mount 测试钉住(3/3 pass)。
- **远程浏览器**:纯呈现层改动,无 `isRemoteClient()` 分支、无 binding/event 通道变化;
  浏览器(Chromium)即本次 375px 仿真载体,布局/交互(点开 sheet、select 回写)同构验证。
- **PWA(≤768px)**:即本卡主场景,375×812 仿真截图前后对照如上;safe-area 沿 M2 惯例
  (`env(safe-area-inset-bottom)` 进 sheet padding)。**真机(iOS Safari 软键盘下 sheet
  定位、滚轮 select 手感)待用户实测**——软键盘压缩 `100dvh` 时 sheet 的 `max-height:
  70dvh` 表现是已知待验项(沿用 M2「仿真过、真机留人」惯例)。

## 环境备注

前端 mount 测试依赖生成的 bindings(`frontend/bindings/`,gitignore 中间产物):本机缺
失时 `bun test` 报 "Cannot find module .../chatservice"。`make bindings`(wails3 alpha2.106,
go.mod 钉版)一条补齐——与 2026-09-08 worklog 记录的 worktree-guard 环境问题同根。

## 下一步

- coder→fe-reviewer 流程;真机 iOS/Android 实测 sheet 手感后回写本条。
- 若 sheet 内要补 model 成本提示/最近使用,入口已在 `MobileConfigSelect` 预留
  (props 已有 `contextTokens` 通道之外的全部条件),按需加。
