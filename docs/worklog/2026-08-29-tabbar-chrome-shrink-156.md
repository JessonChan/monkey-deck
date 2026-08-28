# #156 TabBar Chrome 式收缩落地核验 + 假时钟挂死测试修复（卡 #27998，重派自 #27996/MON-512）

## 起因

卡 #27998（同规格重派自 #27996/MON-512，前次 harness 429 限流幻影完成）。任务规格：TabBar 改 Chrome 式收缩——**滚动三件套全删 + min-width 34 + 50 上限**。

动手核验发现：**该规格的实现已经全部在 main 上**（commit `60e6717` "daemon fallback commit"，经 `14d8ca5` 合入；由另一 agent 分支 `agent/coder/b00ae9d6` 的产出被 daemon 兜底提交）。本卡实际缺口有两处：

1. **实现从未经过任何测试验证**——伴随实现的两个 mount 测试文件一运行就**永久挂死**（bun test 零输出直到超时），等价于验证门形同虚设；
2. **无 worklog 条目**（§0.3 硬纪律）。

本卡完成：规格逐条核验 + 测试挂死根因修复 + 全量验证门跑绿 + 本条 worklog。

## 规格逐条核验（全部满足，无需新增实现代码）

| 规格项 | 落点 | 结论 |
|---|---|---|
| 滚动三件套全删 | `index.css` `.tabbar-scroll`：`overflow-x: auto` + 底部滚动条专用 padding lane + `scrollbar-width`/`scrollbar-color` + `::-webkit-scrollbar` 三条规则全部删除，收敛为 `overflow: hidden` | ✅ 组件侧也无 `scrollLeft`/`onWheel`/scroll-shadow 残留（`grep` 实证；`file-tabbar-scroll` 是 FileTabBar 的，不在本卡范围） |
| min-width 34 | `.tabbar-tab { min-width: 34px }` + `.tabbar-tab.narrow { padding: 0 2px }`（dot 7 + gap 6 + close 16 + padding 4 = 34）；TabBar.tsx 以 ResizeObserver 实测条宽，`tabs.length × WIDE_MIN(47) > stripWidth` 时切 narrow 形态（title/unread 卸载，tab 根节点挂原始标题 tooltip） | ✅ |
| 50 上限 | `TabBar.tsx` 导出 `TAB_LIMIT = 50`；`App.tsx` `registerTab` 在每个开 tab 入口（openSession 咽喉点 + popout 关窗还原）执行上限检查，updater 内重查 `prev` 保证同 tick 双开也不破上限；超限开 tab 驱动 `tabLimitHintSeq` bump → TabBar 闪现 1.5s 内联提示 | ✅ |

i18n（`tabbar.limitTip` 等 5 键 en/zh 双语）齐备；测试文件 `TabBar.mount.test.tsx`（wide→narrow→wide、narrow 卸载 title/unread、原始标题 tooltip）、`App.tab-limit.mount.test.tsx`（经真实 `chat:popout-changed` 还原路径灌 51 个 tab 验上限 + 提示语义）已在。

## 挂死根因（bun:test 假时钟引擎行为，最小复现实证）

两个测试文件用 `vi.useFakeTimers()` 后在**假时钟仍生效期间** `await` 一个**真** `setTimeout`（`drainDuringFakeTimers` / `await delay(5)`，其 delay 捕获的是模块加载时的真 setTimeout）。

**bun 1.3.14 引擎行为：假时钟激活期间，真 setTimeout 回调永不触发（真宏任务队列被假时钟闸住）→ 测试永久挂死。** 最小复现：`useFakeTimers(); await new Promise(r => rst(r, 5))` 即挂（探针 D 实证）。

**且修掉挂死断言也不可能过**：组件的 1500ms 提示定时器在 `useFakeTimers()` **之前**已排上真时钟队列，`vi.advanceTimersByTime(1500)` 只推进假时钟、动不了真队列定时器 → `expect(hint()).toBeNull()` 必败。即这套假时钟写法是双重死路，从未被真正跑通过（daemon 兜底提交未经运行）。

## 改法

主干部仍是主键/真定时器路径，测试改为**对真实墙上时间断言**（boring、确定性：真 setTimeout 只会晚到不会早到）：

- `TabBar.tsx`：`LIMIT_HINT_MS` 由模块私有改为 `export`（单一事实来源，测试不再硬编码 1500；`WIDE_MIN` 维持私有）。
- `TabBar.mount.test.tsx`：删 `drainDuringFakeTimers` 与 `vi` 引用；自消隐断言改为 `await delay(LIMIT_HINT_MS + 100)` 后 `expect(hint()).toBeNull()`。
- `App.tab-limit.mount.test.tsx`：同法替换假时钟块（`delay` 本就用真 setTimeout，直接可用）；动态 import 解构补 `LIMIT_HINT_MS`。
- 相应注释/用例名同步（"fake timers" → "real wall time"），不留过时表述。

## 改动文件

- `frontend/src/components/TabBar.tsx`（导出 `LIMIT_HINT_MS` + 注释说明缘由）
- `frontend/src/components/TabBar.mount.test.tsx`
- `frontend/src/App.tab-limit.mount.test.tsx`

## 验证

- **单测**：两文件 `bun test --isolate` → 4 pass / 0 fail（4.41s，含 2×1.6s 真实等待；修复前永久挂死零输出）。
- **全量**：`bun test --isolate` → **415 pass / 0 fail**（63.31s；修复前全量跑也被这两文件拖挂）。
- **构建**：`npm run build`（tsc + vite）通过（chunk >500kB 警告系既有，非本次引入）。
- **三端**（§4.7）：本次 diff 仅测试文件 + 一个常量 export，**运行时零行为变化**，桌面 GUI / 远程浏览器 / PWA 三端渲染与交互不受影响；且 PWA ≤768px 下 `.tabbar { display: none }`（M2 既有），TabBar 本就不渲染。#156 收缩形态本身的视觉验证归属已合入的 `60e6717`（本卡未重复做 GUI 视觉走查，此为验证边界，明确留档）。
- Go 侧无改动（`60e6717` 只触 frontend），Go 门不受影响。

## 下一步 / OPEN

- 卡 #27996 的幻影完成（分支零提交、结尾即 429 限流原文）与本卡无关，未基于其做任何增删；实现来源是 `60e6717` daemon 兜底提交。
- **不 push**，停在 completed-ready 等人复核（硬纪律）。
- bun:test 假时钟的「真宏任务被闸」行为已实证，后续任何测试**禁止在 fake timers 生效期间 await 真 setTimeout**（要等真时间就先 `useRealTimers` 或根本不用假时钟）；可考虑沉淀进 AGENTS.md §5.4，本卡先留档于此。
