# 2026-08-27 · Review 9c7a2fe #138 定时发送 tooltip 补条数 N —— PASS(Task #24917)

## 审查对象

`9c7a2fe` feat(frontend): 定时发送 tooltip 显示条数 N——scheduledBySession 改 `{count,earliest}`(#138 设计对齐),共 5 文件(App.tsx / Sidebar.tsx / en+zh locale / mount 测试)。配套落地记录:`2026-08-27-scheduled-tooltip-count-138.md`。

## 结论:PASS

### 1. 类型补丁反模式核查(全链路逐点消费确认)

按「从定义点沿每个调用点确认被读取/渲染/写出」反向追踪,`count` 全链路通电:

| 环节 | 位置 | 实证 |
|---|---|---|
| 派生 | `App.tsx:383-398` | 单次遍历同轮累计 `n` 与 `min`,`n>0` 才产出 entry(`{count:n, earliest:min}`);无 `{count:0}` 空壳路径,不变量「entry 存在 ⇔ ≥1 条未来项」保持 |
| Props | `Sidebar.tsx:47` | `Record<string, { count: number; earliest: number }>`,与 App 输出形一致 |
| 门控 | `Sidebar.tsx:783` | `sch && sch.earliest > Date.now()`——多定时项下语义正确(最早一条未到期才显示,门在 earliest 上而非 count 上) |
| 渲染消费 | `Sidebar.tsx:784` | `t("sidebar.scheduledTip", { count: sch.count, time: formatDateTime(sch.earliest) })`,两个值都真流入 `data-tooltip-content`;testid/chip 类名/tooltip id 均未动 |
| 模板 | `en.json:69` / `zh.json:69` | 两端同位含 `{{count}}` 与 `{{time}}`,zh/en key 同步完整 |
| 全仓残留 | grep 全 `frontend/src` | 无任何旧 `Record<string, number>` 形的遗留消费者,cutover 干净 |

**i18next `count` 特殊处理风险已排除**:react-i18next 传 `count` 会触发复数键查找,但仓内已有十余处生产先例走完全相同路径且键为单模板(`sidebar.batchCount`、`queue.title`、`chat.resultsCount` 等),运行时回退到基础 key 成熟可证;仅 `errorDiag.ts` 显式用 `_one/_other`(且带 `l10n.exists` 守卫)。本改动沿用既有惯例,不引入新行为。

### 2. 测试断言质量(锚定值,非字段存在)

新 mock 的 `t` 回显 `key + JSON.stringify(opts)`(测试文件 44-54 行),首例断言 `tip.toContain('"count":2')`——把「prop 里塞了 count=2 → 经组件门控与插值 → 流到 tooltip 属性」整段钉死,正是「值流到具体输出」式锚定,非字段存在性断言。过去时间戳 case 以 `{count:3, earliest:past}` 验证门控仍生效、芯片不渲染。

### 3. 验证(本次 reviewer 实跑,bare worktree 补装依赖后)

- **定向**:`bun test src/components/Sidebar` → **13 pass / 0 fail**(含 scheduled.mount 4 例)。
- **零回归对照**:临时 worktree 检出父提交 `d20a209` 同环境跑全量套件,归一化失败集 diff——**两侧失败集完全一致(各 31 条,均为 stt/clipboard/Mermaid/HarnessPane/FilePanel 等 happy-dom 环境性既有失败)**,即 82→31 的差异纯系「本侧先生成了 bindings」造成的环境差,与本 commit 无关。
- **类型+构建**:生成 bindings 后 `bun run build`(tsc && vite build production)通过。
- **三端**:本改动是 App→Sidebar 单一渲染路径上的纯呈现增量,无新事件/binding/远程守卫分支,GUI/远程浏览器/PWA 抽屉同一代码路径自然继承(与落地记录的三端分析一致);tooltip 真实观感属用户侧冒烟项,维持落地记录标注。

## 下一步

无需返工。用户侧肉眼确认三端 tooltip 观感(GUI / 远程浏览器 / PWA)即可关 #138 收口流程。
