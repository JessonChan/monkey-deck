# 2026-08-26 stop 槽位常驻 + send 琥珀态切换 + mount 用例(#104 方案 C,Task #24339)

## 起因

issue #104(方案 C,父 issue #24338,用户已批准):prompting 切换时 stop 按钮挂载/卸载导致
compose 行宽度跳变(一个 34px 按钮一进一出);且 prompting 时 send 实际语义是「排队发送」,
但外观仍是绿色发送键,与 enqueue 的琥珀队列语义不呼应。

## 改法(三点,严格按方案 C)

1. **stop 槽位常驻**(Composer.tsx):
   - stop 按钮从 `{prompting && …}` 条件挂载改为**始终渲染**,idle 时加 `.is-hidden` 类。
   - CSS `.send-btn.stop.is-hidden { visibility: hidden; pointer-events: none; }`——
     visibility 保宽度零跳变(不是 display:none),pointer-events 兜底不可点。
   - hidden 态可达性硬移除:`aria-hidden={!prompting || undefined}` + `tabIndex={prompting ? 0 : -1}`
     (不进 a11y 树 / tab 序)。`data-testid=stop-btn` 保留在任何状态。
2. **prompting 时 send ↑ 切琥珀**(Composer.tsx + index.css):
   - send 按钮 prompting 时加 `.queuing` 类;CSS 用**组合选择器**
     `.send-btn.enqueue, .send-btn.queuing { background: var(--amber); color: #1a1a1a; }`——
     与 enqueue 同款琥珀 + 深色文字,单一选择器保证两处永远同款(构造性同步)。
   - **关键坑位规避**:不能直接给 send 复用 `enqueue` 类——≤768px 移动端规则
     `.compose-right .send-btn.enqueue { display: none; }`(index.css:3103)会把 prompting 中的
     send 按钮整个隐藏掉。用独立的 `.queuing` 类,该移动端规则一行未动( enqueue 隐藏策略不动)。
   - tooltip 沿用现有 `queueSendTip` / `sendTip` 切换,i18n 文案无需微调(「排队发送(本轮结束后
     自动发)」在琥珀态下语义仍准确,不提颜色)。zh/en 均未改。
3. **明确不动**(按任务边界):App sendMessage busy 契约、移动端 enqueue 隐藏策略、
   stop/enqueue/send 三个回调行为均零改动。

### 附带移动端推论(未写代码,是设计取舍)

stop 槽位常驻在 ≤768px 同样生效:移动端 idle 时 action 列也预留 34px 隐藏槽,换取
idle↔prompting 切换时输入列宽度不再跳变(移动端此前同样有此跳变,#104 的 bug 在三端都在);
这正是「槽位常驻」的本意,非回归。

## 改了哪些文件

- `frontend/src/components/Composer.tsx`:stop 按钮常驻 + hidden 态 a11y 属性;send 按钮
  `queuing` 类;`prompting` prop 注释语义更新(中文转英文,§3.7 触及即转)。
- `frontend/src/index.css`:`.send-btn.stop.is-hidden` 新增;`.send-btn.enqueue` 的琥珀样式
  扩为 `.enqueue`/`.queuing` 组合选择器。
- `frontend/src/components/Composer.mount.test.tsx`:新增 describe 块 2 个用例。

## 验证(本次亲跑;三端矩阵 §4.7/§5.6)

- **mount 用例**:idle → stop 在 DOM + `is-hidden` 类 + `aria-hidden="true"` + `tabIndex=-1`,
  send 无 `queuing` 类;prompting → stop 可见可聚焦(无 aria-hidden、tabIndex=0),send 带
  `queuing` 类,enqueue 按钮类不动。`bun test --isolate src/components/Composer.mount.test.tsx`
  → 37/37(新增 2 + 原有 35,原 stop/send/enqueue 测试语义零回归)。
- **前端全量**:`bun run test` → 362/362 全绿;`bunx tsc --noEmit` 干净。
- **Go gate**:`go build ./...` + `go vet ./...` clean;`go test ./...` 全过(仅 ld 版本警告,
  环境噪音)。本任务无 Go 逻辑改动。
- **wails3 task build**:过,零 TS 错误,darwin 二进制产出(`bin/monkey-deck`)。
  (`frontend/dist` stub 本地补齐 embed 用,不入库;`build/windows/icon.ico` 被 task 顺手
  重生成,已 checkout 还原不夹带。)
- **三端结论**:改动是纯 CSS 类 + DOM 属性,同一代码路径三端共用。桌面 GUI(>768px)与
  远程浏览器同渲染(琥珀 send + 槽位零跳变);PWA ≤768px 断点规则一行未动,`.queuing` 不匹配
  移动端隐藏选择器(prompting 时 send 不消失,实证靠选择器推导 + 全量测试),stop 隐藏槽在
  移动端同样消除宽度跳变。无单端定向分支,后端无改动,无需三端分别冒烟。

## 下一步

- 无;#104 方案 C 三点全部落地。琥珀态在真机(PWA)的视觉确认可随 M2 真机实测一并带过。
