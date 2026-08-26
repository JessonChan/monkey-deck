# 2026-08-26 Review #24340 审 #24339:stop 槽位常驻 + send 琥珀态 —— APPROVE

## 起因

Task #24340:审查 #24339(commit `f031046` + worklog `5fc961f`,issue #104 方案 C)。
范围:纯前端(Composer.tsx / index.css / Composer.mount.test.tsx),无 binding / Go 改动。
方法:反向追踪——从「新增的每个类/属性」的定义点出发,逐个确认 CSS 消费端与测试锚定,
不顺着 commit 叙事走;所有门亲自重跑(worktree 环境自建:`bun install` + `make bindings`
重新生成 gitignore 的 bindings 中间产物后测试才可跑)。

## 逐点核对(类型补丁反模式:字段加了全链路没人消费?)

### 1. `is-hidden` 类(定义 Composer.tsx:1214)—— 全链接通

- **CSS 消费端实证**:index.css:1395 `.send-btn.stop.is-hidden { visibility: hidden;
  pointer-events: none; }` 存在且命中(stop 常驻带 `send-btn stop is-hidden` 三类)。
- **槽位保留成立**:`.send-btn` 定宽 34×34 + `flex-shrink: 0`(index.css:1383-1388),
  `visibility: hidden`(非 display:none)保留盒子与 `.compose-right` 的 10px gap——
  「prompting 切换零宽度跳变」的 claim 构造性成立。
- **隐藏态不可达三件套齐**:TSX 侧 `aria-hidden={!prompting || undefined}` +
  `tabIndex={prompting ? 0 : -1}`,CSS 侧 `pointer-events: none`(顺带挡掉 `:hover`
  brightness)。**无「aria-hidden + 可聚焦」违规**(两态互斥,prompting 时属性整体省略)。
- **props 流真实**:ChatView.tsx:855 `prompting={props.status === "prompting"}` →
  Composer——后端 status 到渲染的单一直通链,非只改了类型签名。

### 2. `queuing` 类(定义 Composer.tsx:1237)—— 全链接通

- **CSS 消费端实证**:index.css:1400-1401 `.send-btn.enqueue, .send-btn.queuing`
  **单一选择器**承载琥珀 + 深色文字——enqueue 与 prompting 态 send 构造性同款,
  不存在两处漂移的可能。
- **关键坑位规避核实**:≤768px 规则 `.compose-right .send-btn.enqueue { display: none; }`
  (index.css:3112)按类名精确匹配,`.queuing` 不命中——prompting 时移动端 send 不会消失,
  claim 成立(亲读 CSS 确认,未轻信 worklog)。
- **特异性核对**:`.send-btn.stop`(红)与 `.queuing`(琥珀)永不共生于同一按钮,
  (0,2,0) 特异性无交叉;`:disabled { opacity: 0.35 }` 叠加琥珀照常生效,无异常。

### 3. 行为边界(「明确不动」三点)—— 核实

diff 仅触及渲染/属性层:`onStop`/`submit`/enqueue 回调签名与调用零改动;
App sendMessage busy 契约、移动端 3112 规则一行未动(git diff 佐证)。
stop 按钮无 `disabled` 属性(与改动前一致,`disabled`(无 session)时 prompting 必为
false → stop 隐藏,不可达,无泄漏)。

### 4. 测试锚定质量(反模式清单「断言锚定值,非字段存在」)

新增 2 例锚定的全是**具体值**:`classList.contains("is-hidden")` 布尔、
`aria-hidden` 双态(`"true"` / `null`——null 断言钉住「prompting 时属性整体省略」,
比断言不等于 "true" 更强)、`tabIndex`(-1/0)、send 的 `queuing` 双态、enqueue 兄弟
类不动(排除误伤)。没有「字段存在即过」的空断言。原有 35 例语义零回归。

### 5. i18n / a11y 杂项

- 零键改动;`composer.stopTip/sendTip/queueSendTip/enqueueTip` zh/en 双侧同在
  (两 locale 各 :345-348),同步。
- `data-testid="stop-btn"` 全态保留(与 §4.2 测试友好一致;全仓无依赖「idle 时
  stop-btn 不存在」的测试,全量绿佐证)。

## 验证(本次亲跑)

- `make bindings`(298 包/133 方法/26 模型)后 `bun test --isolate
  src/components/Composer.mount.test.tsx` → **37/37**(35 旧 + 2 新)。
- `bun run test` → **362/362** 全绿;`bunx tsc --noEmit` **干净**。
- worklog 三端结论与代码一致:纯 CSS 类 + DOM 属性同一代码路径,`.queuing` 不匹配
  移动隐藏选择器(亲核),stop 隐藏槽在移动端同样消跳变。无超 claim。

## 结论

**APPROVE**。非阻塞备查:

1. **P3(pre-existing 债,不属本 diff)**:stop/enqueue/send 三按钮仍用原生 `title`
   (Composer.tsx:1219/1228/1241,文件内共 17 处历史实例)。§4.5 硬约束要求
   react-tooltip;本次改动是**保留**既有 title 而非新引入,沿 #24335/#24337 裁定
   「历史欠账不追本 diff」,建议后续统一清扫时一并转 `md-tip`。
2. 焦点边角:prompting true→false 时若 stop 正被聚焦,旧实现靠卸载失焦,新实现
   `visibility: hidden` 依浏览器规范同样使其不可聚焦而失焦——行为等价,非回归,
   无需动作。

## 下一步

- 无阻塞项;#104 方案 C 至此 review 通过。P3 title 清扫可挂到 §7 之外的顺手任务。
