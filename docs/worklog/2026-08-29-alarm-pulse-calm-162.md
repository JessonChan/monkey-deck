# 2026-08-29 · 闹钟脉冲动效降至 1/10:专用 alarm-pulse keyframes(#162 动效回调 / Task #28407)

日期:2026-08-29 · 基线:rak main=f366d16(#28405 复审留档已在库)

## 起因

#162 把 `.scheduled-indicator` 配色反转回 amber 字形 + 软 tint 底之后,`.is-due-soon` 的脉冲仍在**复用 perm-dot 的 `perm-pulse` keyframes**——那是为「有新版」红点设计的注意力型动效:1.1s 内 scale 1→0.78(22%)+ opacity 1→0.4(60%),对一枚 14px 的闹钟 chip 来说响度过高。父 issue #28406 定版(XXS):给 is-due-soon 一副**专用 keyframes,幅度降到 ~1/10**,颜色/形状/尺寸全不动。

## 方案与决策

### 新 keyframes + 重绑(唯一 CSS 改动面)

- 新增 `@keyframes alarm-pulse { from { opacity: 1; transform: scale(1); } to { opacity: 0.94; transform: scale(0.98); } }`,紧跟其唯一消费者放置(与 `perm-pulse` 紧跟 `perm-dot` 同款布局惯例)。
- `.scheduled-indicator.is-due-soon` animation 从 `perm-pulse 1.1s ease-in-out infinite` 改绑 **`alarm-pulse 1.6s ease-in-out alternate infinite`**。
- **旧引用消除(clean cutover)**:is-due-soon 不再引用 perm-pulse;`perm-pulse` 本体保留——`perm-dot`(设置入口/harness 菜单红点)仍是它的合法消费者,不产生死代码。
- 注释同步:规则块头注释的「reuses perm-pulse keyframes」改为描述专用 keyframes 与 1/10 幅度动机。
- **不动项(与规格逐一对齐)**:`background: rgba(255, 214, 10, 0.12)`、`color: var(--amber)`、14px 圆形轮廓、10px 字形——既有测试「colorway + geometry pinned to the #162 spec values」继续钉住这些值,本卡零冲突。

### 幅度对比(为什么是「1/10」)

|维度|perm-pulse(旧)|alarm-pulse(新)|倍率|
|---|---|---|---|
|scale 幅度|1 → 0.78 = **0.22**|1 → 0.98 = **0.02**|1/11|
|opacity 幅度|1 → 0.40 = **0.60**|1 → 0.94 = **0.06**|1/10|
|周期|1.1s|1.6s(更慢更静)|×1.45|
|循环形制|0%/50%/100% ping-pong infinite|from/to + `alternate` infinite|视觉同为往复,形制更简|

两个维度的幅度都落在 ~1/10 量级(scale 1/11、opacity 1/10),叠加 1.45× 慢周期,视觉响度显著低于 perm-dot 红点——定时项的「即将到期」提示回到信息性信号,不再与权限红点抢注意力。

### 硬测试机制选型:样式表规则检索(CSSOM),非计算样式

任务允许「样式表规则检索或计算样式」二选一。**先探针后动手**(§5.3):happy-dom 对 `animation` 简写**不做 longhand 分解**——`getComputedStyle(chip)` 的 `animationName/animationDuration/animationDirection` 全部返回空串(实测),计算样式路线拿不到绑定值。故选**样式表规则检索**:

- 新测试 mount 一枚真 `.is-due-soon` chip(class 断言先证明类真的挂上),注入**真 index.css**(`readFileSync`,与既有 colorway 测试同款,零 fixture 复制),遍历 `document.styleSheets` 的 `cssRules`:
  - 找 `selectorText === ".scheduled-indicator.is-due-soon"` 的 `CSSStyleRule`——即这枚 chip 的类列表实际命中的规则——断言其 cssText 绑定 `animation: alarm-pulse`、**不含 `perm-pulse`**、含 `1.6s` 与 `alternate`。
  - 找 `@keyframes alarm-pulse` 规则,断言端点值 `opacity 1/scale(1)` 与 `opacity 0.94/scale(0.98)`(happy-dom 把 from/to 规范化为 0%/100%,断言按规范化形制写)。
- **敏感性实证**:把规则临时改回 `perm-pulse 1.1s` 跑一次,恰好且仅新测试 fail(`expect(...).toMatch` 命中),随后还原——钉的不是文本巧合,是行为契约。

## 改了哪些文件

|文件|改动|
|---|---|
|`frontend/src/index.css`|新增 `@keyframes alarm-pulse`(1/10 幅度端点);`.scheduled-indicator.is-due-soon` 重绑 `alarm-pulse 1.6s ease-in-out alternate infinite`;注释改写(#28407 动机)|
|`frontend/src/components/Sidebar.scheduled.mount.test.tsx`|新增测试:due-soon chip 的样式表规则检索钉 alarm-pulse 绑定 + keyframes 端点值 + perm-pulse 旧引用消除|

## 验证

- **定向套件**:`bun test --isolate Sidebar.scheduled` → **8 pass / 0 fail**(原 7 + 新 1)。
- **前端构建**:`bun run build:dev`(tsc + vite development)零错误。
- **Go 门**:本次零 Go 改动,`go build ./...` / `go vet ./...` 干净(守门确认无 Go 面回归)。
- **新 worktree 环境补齐**(gitignore 的依赖与 bindings 不随 checkout):`bun install` 补前端依赖;bindings 用钉版 CLI 从本地 module cache 离线补齐——`go run …@v3.0.0-alpha2.106` 的 proxy 拉取被沙箱网络挡住(git ls-remote 对 github「Empty reply from server」),改走 `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha2.106`(cache 命中,零网络)后跑 Makefile 同款 `generate bindings -clean=true -ts -i`(产出 gitignore 的 `frontend/bindings/` .ts 三件套;`frontend/src/bindings` 是库里已提交的 `../bindings` 符号链接,导入解析到同一棵树)。装完已把机器全局 `~/go/bin/wails3` 还原为 as-found 的 beta.3。
- **全量仓库门**:`bun test --isolate` → **436 pass / 0 fail**(59 文件;装 bindings 前 418 pass + 6 fail 全是缺 bindings 的环境态,复绿后 436 全绿)。

### 三端说明(§4.7)

纯 CSS 呈现层改动:同一份 index.css 三端共享,`animation` 简写 + `alternate` 关键字为 CSS 动画基础能力(macOS WebKit / WebView2 / WebKitGTK / 移动浏览器全支持),无 JS 分支、无 binding/事件、无 `isRemoteClient()` 分化。行为面由 mount 测试钉死;**三端肉眼动效观感未在本沙箱执行**(无法起 Wails GUI),与 #162 同口径留待人工复核。

## OPEN / 下一步

- fe-review 通过后停 completed-ready,不关单(硬纪律);不 push。
- 若 review 认为幅度仍偏大/偏小,只动 `@keyframes alarm-pulse` 的 to 端点两个值(0.94/0.98),周期 1.6s 独立可调。
