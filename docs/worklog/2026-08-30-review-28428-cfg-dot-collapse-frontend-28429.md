# #28429 复审 #28428:ModelSelect 窄态收缩圆点(前端面)——APPROVE

- **日期**: 2026-08-30
- **对象**: 8d291c5(feat)+ c8ce9f6(docs),均已合 main;基线 main = c8ce9f6
- **结论**: **APPROVE(completed-ready,待人复核;不关 issue,不 push)**

## 四点规格反向实证(防类型补丁,从定义点追到消费端)

### ① 触发 = 独立 compose-bar RO,attr 直切

- `Composer.tsx` cfg effect(:425-465):独立 `ResizeObserver` 实例,observe bar/tools/right + **懒 observe** cfg-group(cfg 在 ModelSelect 非 null 后经 `.compose-right` 内容驱动变宽的投递里被发现并补观察,:440-441)。与一期 queue-panel 预算 RO(:395-409)**无共享实例、无共享状态**,互不触发,无反馈环。✅
- attr `setAttribute/removeAttribute` 直切,**不走 React state**(:454/:456)→ 零 re-render,popover 状态天然不受扰。全仓无 container query。✅
- 防反馈环论证成立:翻转后的再投递按**同一组规范宽度**再评估,结果幂等(确认而非反转)。

### ② 阈值纯函数 + 记忆自然宽滞回

- `cfgShouldCollapse`(:195)/`cfgShouldExpand`(:203)导出纯函数;`.cfg-group { flex-shrink: 0 }`(index.css :1436)保自然宽可测——silent shrink 不再 mask 溢出。✅
- exit 用 `cfgFullWRef` 记忆展开宽(:453 写 / :455 读),天真的当前圆点行宽比较会在收缩后立刻读「fits」翻回且无再触发救场——测试 #2(post-collapse re-delivery 确认不翻面)正杀此病灶。数值上 exit 恢复与 entry 同一规范不等式,状态是「avail vs 单一阈值」的纯函数。✅
- 守卫齐:`avail<=0`(:444,隐藏 tab 不决策)、`cfgW<=0`(:449,首拍未 observe 到 cfg / ≤768 display:none 不决策,防 0 假记忆);过期记忆经展开首拍实测自愈(:453 每次展开态投递刷新),测试 #4 覆盖(误展开 → 新测量收回)。✅

### ③ 圆点形态与链路

- CSS(:1466-1472):14px 圆(全局 `* { box-sizing: border-box }` :61 在,border 含在内)、text+chevron display:none、`.cfg-dot-letter` 转 block;展开态 dot-letter 默认 none(:1456)。✅
- `dotLetter` 消费链全程通电:ModelSelect 三处传参 M/E/T(:1396-1398,渲染序 Model/Mode/Thought,Mode 让 M 取 E)→ ConfigSelect 渲染(:1481,`aria-hidden`)→ CSS 门控。无「字段存在无人读」。✅
- 原生 `title={label: currentName}` 为**既有实现**(`git show 8d291c5^` :1387 逐字相同,本次未增未删);testid/点击链不变,mount 测试 #8 圆点点击走真 onSetConfig(锚定值 `["thinking_budget","low"]`,非 legacy id)。✅

### ④ 三类统一收缩;≤768 不动不叠加

- 三个 ConfigSelect 统一挂 dotLetter,attr 是整组开关。✅
- index.css diff 全部落桌面区(:1434-1472),≤768 媒询段(:3372-3378)零改动;圆点规则是**无媒体查询的属性选择器**,天然止步手机档;≤768 下 triggers display:none → cfg 宽 0 → `cfgW<=0` 早退,**attr 根本不置位**(比「置位但视觉惰性」更强)。✅

## 硬测试审查(锚定值,非字段存在)

新增 `Composer.cfgdot.mount.test.tsx` 8 测(纯阈值 2 + RO 行为 6),断言全部锚定具体值:attr 布尔态、字母数组 `["M","E","T"]`、title 串 `composer.cfgLabel.thought: Medium`、阈值边界 308 不收/307 收/240 拒「dots fit」退出、真回调 id。往返零抖动测试含两形态各 3 连发 + 再入。FakeResizeObserver 按 target 供宽,lazy observe 二段投递模拟真实引擎时序。✅

一期两测试改动(autogrow / QueuePanel.list-budget)仅把「RO 实例计数/下标」断言改为**按观察目标查找**(二期起每 Composer 两个 RO,原断言钉的是实现计数),行为断言原样——属必要适配非放松。✅

## Gate(本机实测,与声称核对)

| 门禁 | 声称 | 实测 | 一致 |
|---|---|---|---|
| `bun test --isolate` | 480 pass / 0 fail(65 文件) | **480/0,65 文件,7644 expect** | ✅ 逐字一致 |
| tsc(build:dev 前半) | 过 | exit 0 无输出 | ✅ |

⚠ 本 worktree 曾被重置:`frontend/bindings`(codegen,gitignore)缺失,须先 `wails3 generate bindings -clean=true -ts -i`(仓库根执行;从 frontend/ 目录执行会生成到 `frontend/frontend/bindings` 错位)再跑测试——与 #28428 worklog 踩坑 #5 同源,已留档。

## 夹带检查

feat commit 恰 5 个 frontend 文件(Composer.tsx / index.css / 新 cfgdot 测试 / 两处一期测试适配),docs commit 恰 1 条 worklog。无 Go、无 i18n 键变动(cfgLabel 三键 zh/en 本就齐备同步,本次零新增)、无 ≤768 段改动、无依赖变动。✅

## 遗留(不在本卡,与 worklog 一致)

- 桌面 GUI(WKWebView)三档手测 + 圆点视觉走查(队列展开 × 窄窗组合态)——本环境无法驱动 wails3 窗口,留人验收。
- PWA 真机抽查(圆点手机档不出现,回归即可)。
