# 2026-08-10 全局字号设置(--font-scale + 设置面板 slider + localStorage 回填)(#102, Task #24252)

**起因**:issue #102 要求全局字号设置 —— 用户能在设置面板拖 slider 调整界面字号,
即时生效、重开保留。此前字号写死在 CSS,无法调。本 task 是**重试**(#24251 的实现思路
正确,但提交前未跑通 acceptance gate —— 该 worktree 未生成 bindings / 未构建 dist,
TS 编译缺 `bindings/...` 模块、Go embed 缺 `frontend/dist`,gate 不净)。本次复刻同一设计,
**提交前补齐 `wails3 generate bindings` + `bun install` + `bun run build`**,确保 gate 全净。

## 设计(关键决策,沿用 #24251)

- **单一 CSS 变量驱动**:`:root` 加 `--font-scale`(默认 1),关键字号声明改成
  `calc(<px> * var(--font-scale))`。slider 只改 `document.documentElement.style`
  上的 `--font-scale`,全站即刻重算 —— 一个旋钮收敛整套字号(§5.3 找不变量,不堆 if)。
- **作用域 = 「关键字号」而非全部**:只把**主要阅读面**接上 scale —— `body`(13px)、
  `.sidebar-title`(13px)、`.chat-project` / `.chat-session-title`(13px)、
  `.bubble-user-markdown` / `.bubble-agent`(13.5px)、`.composer-input`(14.5px)。
  **辅助元素**(徽章 / 时间戳 / mono 代码块 / 工具卡状态等 10.5–12.5px)保持固定 ——
  避免放大后信息密度坍塌、徽章撑破布局。在 `:root` 注释里写明此边界。
- **持久化 = localStorage**(`md:font-scale`),与 `notifySound` / `memorySaver` 同模式
  (前端轻量开关走 localStorage,§设置中心)。**未建 SQLite 表**(那是阶段 2 的事,§3.1
  不提前实现)。数值串持久化(如 `"1.15"`),读回 `clampFontScale` 兜底(边界 0.8–1.6,
  NaN/越界回落默认 1)。
- **回填 = 启动即生效,无默认字号闪烁**:`FrontendSettingsProvider` mount 时
  `useEffect(applyFontScale(fontScale), [])` 把持久化值写进 `:root`,首帧即用 saved 值。
  slider 变化经 `setFontScale`(writeFontScale + applyFontScale)同步推 CSS 变量 + 持久化。
- **设置面板**:原 `appearance` 分类是 `EmptyPane`(占位),换成真 `AppearancePane` ——
  一个 `<input type="range">`(min 0.8 / max 1.6 / step 0.05)+ 一个「重置」按钮 +
  右侧实时百分比标签。`data-testid` 齐全(`font-scale-slider` / `font-scale-value` /
  `font-scale-reset`),供自动化测试(§4.2)。
- **顺手删死代码**:`EmptyPane` 组件原本只 appearance 用,appearance 改真 pane 后变死代码,
  TS `noUnusedLocals` 会报错 —— 删掉(§5.3 删掉后功能不变的代码就该删)。i18n 的
  `settings.center.empty.appearance` / `.conversation` key 保持不动(§6.2 不夹带无关改动)。

## 改了哪些文件

- `frontend/src/lib/fontScale.ts`(新):localStorage 读写(`md:font-scale`)+ `clampFontScale`
  (0.8–1.6 边界)+ `applyFontScale`(写 `:root` 的 `--font-scale`)+ 导出 `FONT_SCALE_MIN/MAX/DEFAULT`
  常量供 slider / 重置按钮用。
- `frontend/src/lib/settingsStore.tsx`:`FrontendSettings` 加 `fontScale` + `setFontScale`;
  provider 加 `fontScale` state(init 读 `readFontScale()`)+ mount effect(applyFontScale)+
  setter(write + apply + setState)。
- `frontend/src/components/SettingsPanel.tsx`:appearance 分类渲染 `<AppearancePane />`(取代
  `EmptyPane`);新增 `AppearancePane`(slider + 重置 + 百分比);删掉死代码 `EmptyPane`。
- `frontend/src/index.css`:
  - `:root` 加 `--font-scale: 1`(+ 注释说明作用域边界)。
  - 关键字号改 `calc(<px> * var(--font-scale))`:body / sidebar-title / chat-project /
    chat-session-title / bubble-user-markdown / bubble-agent / composer-input。
  - 新增 `.settings-slider-row` / `.settings-slider`(含 webkit / moz thumb 主题化,accent 色)/
    `.settings-reset-btn` 样式。
- `frontend/src/i18n/locales/{zh,en}.json`:加 `settings.center.appearance.{desc,fontScaleTitle,
  fontScaleDesc,fontScaleReset}` 四条(zh/en 同步,locale sync 测试过)。

## 验证(acceptance gate —— 本次重点,#24251 即栽在此)

按 task title「提交前必跑 acceptance gate」,本次先补齐环境再验证:

1. `wails3 generate bindings`:生成 `frontend/bindings`(worktree 默认缺,gitignore 不入库)。
2. `cd frontend && bun install`:补 `node_modules`(worktree 默认缺)。
3. **`cd frontend && npm run build`**(= `tsc && vite build`):**通过**。tsc 0 错误(含
   `noUnusedLocals` —— 证明 `EmptyPane` 删除到位、`AppearancePane` 接线正确),vite 出 dist,
   仅预存在 chunk>500kB 警告。
4. `cd frontend && bun test src/i18n/locales.test.ts`:**2 pass**(zh/en leaf key 集合一致)。
5. `cd frontend && bun test src/components/HarnessUpdateAwareness.mount.test.tsx`:**9 pass / 0 fail**
   (含 SettingsPanel 红点测试 —— 证明 SettingsPanel 改动未破坏既有 mount 测试)。
6. `cd frontend && bun test`(全量):**168 pass / 31 fail**。31 fail 全是预存在的跨测试污染 /
   bindings 缺失环境性失败(ChatView 虚拟化 / HarnessPane 后端接线 / NewSessionModal / QueuePanel /
   agent msg-meta 等),**与本次改动无关**(stash 回原代码跑全量,数字完全一致 168/31)。
7. **`go build ./...`**:**exit 0**(仅 macOS SDK 链接器 warning,预存在)。dist 因 step 3 已生成,
   embed 正常。
8. **`go vet ./...`**:**exit 0**。

## 下一步

- 桌面 app 实测:macOS WebKit 下拖 slider 看对话/输入框/标题即时缩放,重开 app 字号保留;
  Win WebView2 抽检 native range slider 渲染(§4.6 跨平台一致性)。
- 若实测发现某些「关键字号」漏接(如权限弹窗 / elicitation 表单也想跟缩放),再按需扩
  `calc()` 引用面 —— 但保持辅助元素固定以守住信息密度。
- (可选)若用户反馈边界 0.8–1.6 太窄/太宽,调 `FONT_SCALE_MIN/MAX`;slider step 0.05
  对应 5% 增量,与「%」标签显示对齐。
