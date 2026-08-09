# 2026-08-10 Review #102 全局字号设置 前端 (APPROVE + 2 处小修, Task #24253)

**起因**:Task #24253 对 #24252 / issue #102(commit `ab14a20`,feat(appearance):
global font-scale setting)的前端部分做 Frontend Reviewer 端到端验收。本审只评前端
(`frontend/src/`)——无后端 / binding 改动(纯 CSS 变量 + localStorage + slider UI)。

## 复审范围

- `lib/fontScale.ts`(新):`clampFontScale` / `readFontScale` / `writeFontScale` /
  `applyFontScale` + `FONT_SCALE_MIN/MAX/DEFAULT` 常量。
- `lib/settingsStore.tsx`:`FrontendSettings` 加 `fontScale` + `setFontScale`;provider
  state(init 读 `readFontScale`)+ setter(write + apply + setState)。
- `components/SettingsPanel.tsx`:`AppearancePane`(slider + 重置 + 实时 %)+ 删死代码
  `EmptyPane`。
- `index.css`:`:root` `--font-scale: 1` + 7 处关键字号 `calc(<px> * var(--font-scale))`
  + `.settings-slider-row` / `.settings-slider` / `.settings-reset-btn` 样式。
- `i18n/locales/{zh,en}.json`:`settings.center.appearance.*` 四 key。

## 正确性 ✅

### fontScale.ts:clamp 链完备
- `clampFontScale`:`Number.isFinite` 挡 NaN/Infinity → `Math.round(v*100)/100` 对齐
  slider step 0.05(避免 0.850000001 浮点漂移)→ min/max 双向夹紧。✅
- `readFontScale`:try/catch 包 `localStorage`(private mode / 受限环境回落默认)。
  `raw === null` 显式判(未存过)→ 默认;`parseFloat` 失败返 NaN → 经 clamp 回落默认。✅
- `writeFontScale`:`String(clampFontScale(scale))` —— **持久化前 clamp**,落盘永远是
  合法值(即使传入越界 / NaN)。✅
- `applyFontScale`:`typeof document === "undefined"` SSR 守卫 → 写 `:root` inline
  `--font-scale`(覆盖 stylesheet 默认 1)。**入参经 clamp**,CSS 变量永远是合法值。✅

### settingsStore.tsx:wiring 自洽
- `useState<number>(readFontScale)`:lazy init,仅 mount 时读一次 localStorage。✅
- `setFontScale = useCallback(...)`:`writeFontScale(v)` → `setFontScaleState(v)` →
  `applyFontScale(v)`,三步原子(同步、同序),无中间态可见。`useCallback([])` 稳定引用,
  进 `value` useMemo dep 不抖。✅
- `value` useMemo 含 `fontScale` + `setFontScale`,消费方 `useFrontendSettings()` 响应式更新。✅

### SettingsPanel.tsx:AppearancePane 接线正确
- `value={fontScale}` controlled input;`onChange` → `setFontScale(parseFloat(...))`。
  range input 的 `.value` 永远是 min/max/step 约束内的串,`parseFloat` 安全。✅
- `pctLabel = Math.round(fontScale*100) + "%"`:用 `Math.round` 消浮点漂移,显示稳定。✅
- 重置按钮走 `setFontScale(FONT_SCALE_DEFAULT)`(= 1),与 slider 同路径,不绕过
  write/apply。✅
- `EmptyPane` 删除到位(TS `noUnusedLocals` 编译通过 = 死代码清零)。✅

### index.css:作用域边界正确,符合 §5.3「找不变量」
逐处核对 7 个 `calc(... * var(--font-scale))` 引用:`:root` 注释明示「只关键字号接 scale,
辅助 chrome 固定」。一个旋钮(`--font-scale`)收敛整套关键字号,而非逐处加 if / 各自
state——这是 §5.3「找不变量,不堆 if」的干净落地。辅助元素(徽章 / 时间戳 / mono 代码块
10.5–12.5px)保持固定以守住信息密度,设计自洽。✅

slider 主题化:`-webkit-slider-thumb`(WebKit/WebView2)+ `::-moz-range-thumb`(Firefox,
无害冗余)双引擎覆盖,accent 色对齐主题,符合 §4.6「CSS 驱动、轻量、跨平台原语」。✅

### i18n:zh/en 同步 ✅
`settings.center.appearance.{desc,fontScaleTitle,fontScaleDesc,fontScaleReset}` 四 key
zh/en 一一对应(`locales.test.ts` 2 pass,leaf key 集合一致)。

## data-testid ✅
`appearance-pane` / `font-scale-slider` / `font-scale-value` / `font-scale-reset` 四个
testid 齐全,可自动化(§4.2)。

## 审中两处小修(review 内直接补)

### Fix #1:slider 缺 `aria-label`(a11y,§4.2)

range `<input>` 无 accessible name —— 屏幕阅读器只会念「slider」,念不出是调什么的(可见
标题在同级 `<div>`,未关联)。全仓一致用 `aria-label` 标注可交互元素(20+ 处:
`EditorPane` / `ChatView` / `Sidebar` / `SelectionToolbar` …),本 slider 是新 pane 的主要
交互件却漏标。**补 `aria-label={t("settings.center.appearance.fontScaleTitle")}`**(复用
现有 i18n key,不新增)。native range 的 `aria-valuemin/max/now` 由引擎隐式暴露,无需手写。

### Fix #2:「无闪烁」声明与实现不符 → 改在 main.tsx 启动即 apply

worklog 第 23–24 行声称「首帧即用 saved 值 / 无默认字号闪烁」,但原实现是
`FrontendSettingsProvider` 里的 `useEffect(applyFontScale, [])` —— **useEffect 在首帧
paint 之后才跑**,故持久化值(如 1.3)生效前会有一帧 `--font-scale:1`(CSS 默认)闪过。
对显著放大(1.3–1.6)用户,启动时有可见的「字号 pop」。

正解:在 `main.tsx` 的 `createRoot().render()` **之前**同步 `applyFontScale(readFontScale())`
—— React 挂载前 CSS 变量已是 saved 值,首帧即对。同时删掉 provider 里那条 now-redundant
mount effect(§5.3 删掉后功能不变的代码就该删;`setFontScale` 仍调 `applyFontScale` 推 live
更新,`readFontScale` 仍在 useState init 用,`writeFontScale` 仍在 setter 用,三 import 无死)。

两修均经 `npm run build`(tsc + vite)+ locale/mount test 验证通过。

## 观察项(非阻塞 nit,不改)

### #1 setFontScale 存的是 raw value,非 clamped
`setFontScaleState(v)` 存原始入参。当前唯一入口(slider onChange)经 range input 的
min/max/step 约束永远在 [0.8, 1.6];重置走 `FONT_SCALE_DEFAULT`。故 state 永远合法,
`pctLabel` 与 CSS 不分叉。若未来加程序化入口(如快捷键放大),应在 setter 内 clamp 再存
state。当前无 bug,**记为 robustness nit**。

### #2 slider 无 progress fill(视觉)
WebKit range input 默认不填 thumb 左侧轨道(需 JS 或 background gradient 才显进度)。
当前是单色细轨 + 圆 thumb,可读但无进度反馈。属 cosmetic polish,非功能缺陷。建议后续
(若用户反馈)用 `background: linear-gradient(...)` 按 value 计算百分比填左半。**不阻塞**。

### #3 无 fontScale 自动化测试
`lib/fontScale.ts` 的 clamp / read / write / apply 均可纯单测(localStorage mock +
document.style mock),当前无 `fontScale.test.ts`。功能简单 + 实测路径短(worklog「下一步」
已列桌面实测),**不阻塞合入**,建议后续补 clamp 边界 + apply 写 CSS var 的单测。

## 验证(acceptance gate)

1. `wails3 generate bindings` → 生成 `frontend/bindings`(worktree 默认缺)。
2. `cd frontend && bun install` → 364 packages。
3. **`cd frontend && npm run build`**(= `tsc && vite build`):**通过**。tsc 0 错(含
   `noUnusedLocals` —— 证 Fix #2 删 mount effect 后三 import 无死 + Fix #1 aria-label 接线
   正确),vite 出 dist,仅预存在 chunk>500kB 警告。
4. **`cd frontend && bun test src/i18n/locales.test.ts src/components/HarnessUpdateAwareness.mount.test.tsx`**:
   **11 pass / 0 fail**(2 locale sync + 9 SettingsPanel 红点 mount,证 AppearancePane 改动
   未破坏既有 mount 测试)。

## Verdict:APPROVE

fontScale.ts clamp 链完备、settingsStore wiring 自洽(FontScale state/setter/useMemo 全
消费)、AppearancePane controlled slider 接线正确、CSS 作用域边界符合 §5.3 不变量原则、
i18n zh/en 同步、data-testid 齐全——全部过关。审中补两处小修(#1 slider aria-label 对齐全仓
a11y 约定;#2 main.tsx 启动即 apply 让「无闪烁」名副其实 + 删冗余 mount effect)。三项观察
item(setter 存 raw / slider 无 progress fill / 无 fontScale 单测)均非阻塞,记为后续可选。
建议合入。

## 改了哪些文件

- `frontend/src/components/SettingsPanel.tsx`:slider 加 `aria-label`(Fix #1)。
- `frontend/src/main.tsx`:render 前 `applyFontScale(readFontScale())`(Fix #2 无闪烁)。
- `frontend/src/lib/settingsStore.tsx`:删 now-redundant mount effect(Fix #2 配套,§5.3)。
- `docs/worklog/2026-08-10-review-global-font-scale-frontend.md`(本条,新增)。
