# 2026-09-06 #196 前端灰态 fe-review:NewSessionModal needs-adapter 锁卡(APPROVE)

## 背景 / 起因

卡 #29014,审 #29011 前端灰态实现(已合 main:前端=23b67ac,5 文件 +104/−37;
docs=44dab6b;基线前推 d6df322=后端 ACPCommand 解耦,其 review 已 APPROVE 记录
2544c15)。按硬性清单 ①–⑥ 反相追踪核实,不采信 commit 叙事——从字段定义点沿
每个调用点确认真实消费(「类型补丁」反模式检查)。本 worktree 为重置态
(bindings/node_modules 缺失),复跑前重新 `bun install` + `wails3 task bindings`,
恰好覆盖清单⑥的「可复跑」要求。

## 结论:**APPROVE**(①–⑥ 全过,零 needs changes)

### ① 灰卡:disabled + 置灰 + 角标 + tooltip,不可选、不静默排除 ✓

- `NewSessionModal.tsx:383` `locked = h.installed && !!h.needsAdapter`;
  `:388` `disabled={locked || undefined}`(原生 button disabled = 点击被浏览器
  吞掉);`:389` onClick 再挂 `if (!locked)` guard(双保险)。
- 置灰 `index.css:2935` `.ns-harness.needs-adapter { opacity: 0.55 }` 与未装
  (`:2925` `.ns-harness.uninstalled` 同 0.55)视觉同构;`:2936` 加
  `:disabled { cursor: not-allowed }`。
- 角标 chip 复用 `ns-harness-badge-uninstalled` 样式、独立 testid
  `ns-harness-needs-adapter-<id>`(`:403-407`),文案走新键
  `settings.harness.needsAcpAdapter`;tooltip 合并行
  `name\ncommand\n{needsAcpAdapter}`(`:398-399`)。
- 条目仍渲染在网格里(保留发现信息价值);与 #188 未装灰态不混淆:
  未装卡 `disabled=undefined` 仍可选(tooltip 走 `newSession.notInstalled`、
  testid `ns-harness-uninstalled-<id>`),mount 测试显式断言 claude 无
  `uninstalled` 类——「未装=可选,需适配器=不可选」两条态不串。

### ② isSelectable 单一定义,三处锁步 ✓

- `:20` 唯一定义 `installed && !needsAdapter`,喂:预选(lastHarness 恢复
  `:68`、单卡自动选 `:69`)+ 排序(`:245` rank:可选 0/1、锁卡 2/3 沉尾,
  omp 仍带头)。点击门控用 `locked`(≡ `installed && !isSelectable`)而非
  isSelectable 本身——**这是对的**:若直接用 isSelectable 会把 #187 未装卡
  也禁掉,违反「未装=可选」;对 needs-adapter 卡三处判定完全一致。
- mount 测试锚定:排序 `["opencode","claude"]`(可用先、锁卡沉尾)、点击后无
  `active`/无 check 徽标、单卡场景预选跳过(无 `.ns-harness.active`)。

### ③ 零波及 ✓

- 网格改动全为增量(locked 常量/disabled/class 拼接/tooltip 三元新分支/chip),
  未装分支、tooltip 首分支、check 徽标、auto-fill 布局零触碰;#195 详情卡
  `renderDetail` 逐行未动,锁卡不可选中 → 详情卡永不为其渲染
  (与 commit 叙事一致,且由 `selected` 查找路径证实)。
- 创建漏斗唯一:App.tsx:1306 是全仓唯一 `setNewSession`(所有入口都过模态);
  Composer 无 harness 切换面(session 创建时钉死,§3.6)——锁卡无法绕过。
- 全量 `bun test --isolate`:**569 pass / 0 fail**(79 文件)——优于实现
  worklog 记录的 552/17 基线(17 个失败已注明系全量 worker 批处理顺序、
  单文件全过;本次 isolate 全绿,无任何新增失败)。#188/#195 既有断言
  (omp tooltip `omp\nomp acp`、详情卡 8 测)全过。

### ④ 类型真实消费(反相追踪,零死字段)✓

- `needsAdapter`:backend `harness.go:39`(json `needsAdapter,omitempty`)→
  本机重跑 `wails3 task bindings` 生成 `Harness["needsAdapter"]?: boolean`,
  逐字对齐;消费点 `:20/:68/:69/:245/:383/:387-407` 全部真实读/render,
  测试锚定渲染输出(类名/disabled 属性/tooltip 逐字/chip testid),非「字段存在」。
- `acpCommand`:TS 模型 KnownHarness `"acpCommand"?: string` 对齐 backend;
  其消费在后端(Discover Stage4 钉 `Command=ACPCommand`、ensureCatalogHarness
  物化),前端经 `h.command` 消费结果(tooltip/详情卡命令行)——通道闭合,
  无前端死字段。
- `bun run build`(tsc + vite production)通过(chunk >500kB 警告为既有)。

### ⑤ i18n zh/en 同步 ✓

- 两 locale key 集合拍平比对(zh-only / en-only 均空);新键落在
  `settings.harness.needsAcpAdapter`,zh「需 ACP 适配器」/en
  "Needs an ACP adapter",与规格逐字一致。

### ⑥ 测试 + 构建可复跑 ✓

- 新增 2 条 mount 测试锚定值断言(灰态全 attribute + 预选跳过),隔离跑
  `NewSessionModal.mount.test.tsx` + `harness-detail.mount.test.tsx`
  13 pass;全量 569/569(见 ③);build 复跑过(重置 worktree 上从零装起)。

## 观察(不阻断,记录备查)

1. **disabled 元素上的 tooltip**:react-tooltip v6 走 document 级捕获委托,
   但部分引擎(WebKit/Firefox)对 disabled 表单控件的 mouse 事件有抑制,
   锁卡 tooltip 行可能不开。非本卡引入——仓内既有同型
   (HarnessSettings.tsx:446-467 硬 disabled + tooltip);且状态文案已由角标
   chip 在卡面上承载,信息不丢。若日后报「锁卡无 tooltip」按 wrap-span 或
   aria-disabled 方案处理。
2. `locked` 与 `isSelectable` 是同一对字段的两个表达式(逻辑上
   `locked ≡ installed && !isSelectable(h)`),系有意分化(点击门控不得用
   isSelectable,否则误伤未装卡),行为已被测试钉死,无漂移风险;纯风格项。
3. 既有边界(本卡未改、未恶化):模态存活期间 `harnesses` prop 若原地变化使
   已选卡变锁卡,无 effect 重校验选中态。后端仅在 Discover 时置
   needsAdapter,实际不可达;如未来出现运行中翻转再议。

## 下一步

- 无代码待办。灰态真机观感(WebKit 下 disabled 卡渲染/触屏)随 M2 真机实测
  一并覆盖即可。
- 17 个全量测试基线失败已在实现 worklog 标注「另卡排查」,本卡未触碰。
