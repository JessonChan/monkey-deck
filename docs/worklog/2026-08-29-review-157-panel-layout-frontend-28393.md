# #28393 review #157 前端面复审——APPROVE(popout 隔离与折叠持久全链路通电)

## 起因

对 #157(popout 退出主布局持久化 + 折叠态持久化)的前端面复审。实现主体 `b54d703`(2 文件:`frontend/src/App.tsx` +61/-4、新测试 `frontend/src/App.panel-collapse.mount.test.tsx` 385 行),worklog `c870a1d`。按「类型补丁」反模式从字段定义点反溯每个消费端,并复核测试断言是否锚定值。

## 结论:**APPROVE**(0×P1/P2;2×P3 留档不阻塞)

## 反模式反溯(类型补丁检查,逐符号过)

| 新增符号 | 定义点 | 消费链 | 通电 |
|---|---|---|---|
| `NOOP_LAYOUT_STORAGE` | App.tsx L109 | L2078 传入真 hook `storage` | ✅ |
| `defaultLayout`/`onLayoutChanged` | L2075 hook 返回 | Group props L2272-2273 | ✅ |
| `PANEL_COLLAPSED_KEY` | L84 | 读 L92(`readPanelCollapsed`)+ 写 L2133(写 effect) | ✅ |
| `readPanelCollapsed()` | L90 | 主窗 mount 分支 L2120-2122 → 命令式 `collapse()` → 面板 resize → `onResize` → `syncCollapsed` → state → `data-sidebar-collapsed`/`data-side-collapsed`(L2274-2275)+ rail 图标/tooltip/testid(L2555/2570 等) | ✅ |

无空壳字段。状态单源:`leftCollapsed`/`rightCollapsed` 只经 `syncCollapsed`(面板自身 `onResize`)更新,拖拽收起与按钮收起同一条道,无第二份表示可发散(§5.3 不变量式写法)。

## 库契约实证(读真实源码,非推理)

react-resizable-panels 4.12.0 dist 源码核验:

- `storage: o = localStorage` —— `storage: undefined` 回退全局 localStorage,主窗行为不变。
- 落盘 key = `react-resizable-panels:${[id, ...panelIds].join(":")}` = `react-resizable-panels:monkey-deck-layout`(与 worklog 键位矩阵一致)。
- 读路径 `useSyncExternalStore(() => o.getItem(a))` + 兜底复杂解析都走 `n.getItem` → noop 恒 null → `defaultLayout === undefined`;写路径先 `isUserInteraction` 门再 `o.setItem` → noop 丢弃。**popout 隔离发生在 App 传入的 storage 对象这一真实缝隙上**,由真 hook 测试实证,非 mock 回放。
- hooks 规则:`useDefaultLayout` 无条件调用;`NOOP_LAYOUT_STORAGE` 模块级常量(标识稳定,无 re-subscribe);`isPopout` = `useState(() => parsePopoutHash())[0]` 终身不变,storage 身份不会中途翻转。
- 写 effect deps 完整 `[isPopout, leftCollapsed, rightCollapsed]`,popout 在任何 I/O 前早退;try/catch best-effort 对齐其它 `md:*` key 惯例。
- `readPanelCollapsed` 严格形状校验(两个布尔都在才采信),缺失/坏 JSON → 全展开,容错惯例对齐 Sidebar expanded-set。
- key 命名 `md:panel-collapsed` 与既有 `md:sidebar-expanded`/`md:font-scale`/`md:lang` 等约定一致。

## 测试断言锚定值(非字段存在)

- popout 不读:种子**有效** layout → `defaultLayout` **toBeUndefined**;对照组主窗同种子 → `toEqual({sidebar:18,"chat-area":82})`。
- popout 不写布局 key:驱动真 hook `onLayoutChanged(..., {isUserInteraction:true})` 后存档 **`toBe(seeded)` 字节不变**;主窗对照 → `toBe('{"sidebar":25,"chat-area":75}')`。
- popout 不写折叠 key:expand/collapse 点击后 `md:panel-collapsed` **始终不存在**;get/set spy 全扫无 `monkey-deck-layout` 家族、无折叠 key。
- 主窗逐值落盘:`toBe('{"left":true,"right":false}')` → `{"left":true,"right":true}` → 展开×2 回 `{"left":false,"right":false}`,**精确 JSON 串四级锚定**。
- 恢复走命令式路径:mock handle `calls` 记录 `collapse`、右 handle `toEqual([])`(左-only 变体反向亦然),attr 精确串;二次 mount 幂等;坏 JSON 不崩回全展开;600px 窄窗自动收起不变。
- 脚手架设计正确:组件 mock + **真 hook**(App 传的 noop storage 只有真 hook 才可见),storage fake 带访问记录(happy-dom Storage 实例无法 spy,实测结论)。

## 规格逐条核验

| 规格项 | 结论 |
|---|---|
| popout 不读不写主布局存档 | noop storage 双向隔离,真 hook 测试实证(种子还原对照 + spy 全扫)✅ |
| popout 不读写折叠 key | 写 effect `isPopout` 早退 + 读点仅在主窗分支;测试双通道断言 ✅ |
| 折叠态主窗持久化 | JSON `{left,right}` 写 effect + mount 命令式复载,坏值容错 ✅ |
| 不新增 popout 专属持久化 | diff 里无 popout 写点,popout 维持默认(右收起 mount / 左不渲染)✅ |
| 750px 窄窗 auto-collapse 不变 | 原 `onResize()` 原样保留,测试 5 覆盖 ✅ |
| i18n / a11y / CSS | 零新增 UI 面:无新文案、无新交互元素、零样式改动,复用既有 testid ✅ |

## P3 留档(不阻塞,均为已接受限制的边界后果)

1. **mount 写-先于-恢复的暂态,在 M2 手机 race 下会升级为偏好覆写**:主窗 mount 时恢复 effect(L2102,声明在前)先读种子并 `collapse()`,但状态同步要等重渲染,写 effect(L2130)首跑仍以初始 `false/false` 落盘一次,恢复后再覆盖回正确终值(测试 L333 断言终值=种子,暂态无害)。后果放大点:若 worklog 已声明的 M2 手机 race 触发(库的延迟初始布局静默覆盖 mount collapse),失败的恢复不只是「本次没恢复」——写 effect 会把未恢复态**持久化覆写用户存档**,下次 mount 无可恢复。边界有限:localStorage 按设备+源隔离,只有 race 发生的那台设备(手机 PWA,≤768px 本就抽屉接管、面板态半退休)丢自己的存档,桌面不受影响。worklog OPEN 已认领该限制;此处仅补记「写回会固化失败恢复」这半步。若日后要收敛:写点门控到首次 `syncCollapsed`/用户交互之后即可,暂不必做。
2. **窄窗 mount 重写 `right:false`**:<750px mount 自动收起无反向 expand 路径(恢复只收不放),窄窗下手动展开持久化的 `{"right":false}` 在下次窄窗 mount 被改写为 `true`。与改前行为一致(自动收起向来在 mount 必胜,只是当时无持久化可见),持久化忠实记录真实状态;测试 5 已钉住会话内行为。记档防误判为回归。

## P4 顺手项

- L2098-2100 效应头注释(窄窗自动折叠说明)仍为中文,而该效应体本次被修改(恢复分支并入)。§3.7「碰到就要顺手转」的边界情形——注释描述的是未变的窄窗部分,行为无误,后续触及该效应时顺手转英文即可。

## 三端说明(§4.7)

本改动零渲染分支/零样式/零组件结构变化,纯持久化读写行为:桌面 GUI 是行为主战场(popout 本身桌面专属),mount 测试与 GUI 同构、恢复与写点均已实证;远程浏览器/PWA 跑同一份 React 代码、同一 localStorage 语义——远程浏览器主窗与同源 PWA 共享 `md:panel-collapsed` 属**同结构主窗共享,正确**(与 popout 异结构隔离相反);无视觉回归面。后端零改动,无需 binding 验证。

## 验证(本 worktree 实跑,非转录)

- 环境引导:`bun install` + `wails3 generate bindings`(bindings/node_modules 均为 gitignored 生成物,新 worktree 缺失属环境引导,非代码缺陷)。
- 本修复测试:`bun test --isolate App.panel-collapse.mount.test.tsx` → **5 pass / 0 fail**(39 expect;React prop 告警来自 mock Group 把 props 展开进 div,脚手架噪音,无害)。
- 全量:`bun run test` → **420 pass / 0 fail**(56 文件,与实现 worklog 声称一致)。
- 构建:`bun run build:dev`(tsc + vite)通过。
- 树干净:修复已在 `b54d703` + worklog `c870a1d` 提交,无未提交改动。

## 下一步

- 无阻塞。两个 P3 与一个 P4 记档,随 M2 真机验证或后续触及该效应时顺带处理。
