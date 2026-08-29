# Review #28407 闹钟脉冲降档前端面复审(alarm-pulse keyframes + mount 断言)(#28408)

日期:2026-08-29
被审:69734bf(feat 闹钟脉冲降至 1/10,2 文件 +46/−2)+ 3525c8a(worklog)
结论:**APPROVE**——父 issue #28406 五点规格逐条反向追代码实证全过;本机独立重跑定向 8/0 + 全量 436/0 + `build:dev`(tsc 全量,零缓存)与被审声称一致;并自行补做负向敏感性实证(回绑旧值 → 恰好且仅新测试 fail),与被审 worklog 第 37 行声称的敏感性实验互相印证。零 findings,无需返工。

## 复审方法

按「类型补丁反模式」反向追踪:从规格五点出发逐条对代码消费端(不经 commit message);keyframes/类名/动画绑定从定义点追到真实渲染点(Sidebar.tsx 类列表 → CSS 规则 → keyframes);测试逐条核对断言锚定值(非字段存在性);本机重跑全部 gate + 负向回绑实验。

## 逐件验证(规格五点)

### ① @keyframes alarm-pulse 端点与周期 ✅

`index.css:399`:`@keyframes alarm-pulse { from { opacity: 1; transform: scale(1); } to { opacity: 0.94; transform: scale(0.98); } }`;`index.css:398`:`.scheduled-indicator.is-due-soon { animation: alarm-pulse 1.6s ease-in-out alternate infinite; }`——端点 opacity 1→0.94 / scale(1)→scale(0.98)、1.6s ease-in-out alternate infinite,呼吸语义(from/to + alternate = 连续往复插值)逐字与规格一致。测试按 happy-dom 规范化形制(from/to→0%/100%)断言端点值,锚定值非存在性。

### ② 仅改 animation 绑定 + is-due-soon 链路 perm-pulse 零残留 ✅

原始 diff 全量核对(index.css 恰 3 行变更:块头注释改写 + 398 重绑 + 399 新增 keyframes;测试文件纯新增 1 test):基线旧绑定 `perm-pulse 1.1s ease-in-out infinite` 被整体替换,规则内无其它属性变更。全 `frontend/src` grep `perm-pulse` 仅 2 处:`.perm-dot`(index.css:360,合法消费)与 keyframes 本体(:373)——符合规格注记「本体保留不算残留」;is-due-soon 链路(Sidebar.tsx:974 类拼接 → :398 规则)零 perm-pulse 引用,clean cutover 成立。

### ③ 颜色/形状/尺寸不动 ✅

diff 上下文行实证 `:396`(`background: rgba(255,214,10,0.12)` / `color: var(--amber)` / 14px / `border-radius: 50%`)与 `:397`(svg 10px)未触及;既有「colorway + geometry pinned to the #162 spec values」测试(从真样式表读计算值)继续钉住,本次重跑通过。

### ④ 硬测试 + gate ✅

新测试「due-soon pulse binds the dedicated alarm-pulse keyframes, not perm-pulse (#28407)」:mount 真 due-soon chip(先断言 `.is-due-soon` 真挂上)→ `readFileSync` 注入真 index.css(零 fixture 复制)→ 遍历 CSSOM 规则,按 selectorText 精确命中 `.scheduled-indicator.is-due-soon` 规则,断言 `animation: alarm-pulse` / 不含 perm-pulse / 1.6s / alternate + keyframes 端点值。机制选型(worklog:happy-dom 不分解 animation 简写 longhand,计算样式拿不到值)经其探针记录合理;测试内注释如实说明。
Gate 本机独立重跑(本 worktree 补齐 gitignore 依赖:`bun install` 375 包 + `make bindings` 按 go.mod 钉版 alpha2.106 离线重生成,297 包/126 方法/26 模型):

- `bun test --isolate Sidebar.scheduled` → **8 pass / 0 fail**(原 7 + 新 1,40 expects);
- `bun test --isolate` 全量 → **436 pass / 0 fail**(59 文件,7516 expects,64.9s),与被审声称 436/0 一致(maxSize React 告警为既有噪音,多个无关测试同现,与 #28405 复审同判);
- `bun run build:dev` → tsc 0 错误 + vite development build 通过;tsconfig 无 incremental/composite 配置、无 tsbuildinfo 产物,tsc 门即全量无缓存,「无缓存 tsc 门」声称成立。

**负向敏感性实证(复审自做)**:临时把 :398 回绑 `perm-pulse 1.1s ease-in-out infinite` → 定向套件 **7 pass / 1 fail,且唯一 fail 恰为新测试** → `git checkout` 还原(还原后 alarm-pulse 3 行齐)。钉的是行为契约而非文本巧合,与被审 worklog 声称的敏感性实验结论一致。

### ⑤ worklog 幅度对比记录 ✅

3525c8a「方案与决策·幅度对比」表格:scale 0.22→0.02(1/11)、opacity 0.60→0.06(1/10)、周期 1.1s→1.6s(×1.45)、形制 ping-pong→alternate——四个数值全部与代码实测一致;「不动项」清单与 :396/:397 现值一致;gate 记录(8/0、build:dev、436/0)与本机重跑一致;三端口径如实标注纯 CSS 呈现层、无 JS/binding 分化、实机动效观感留人工复核(与 #162 同口径)。

## Findings 汇总

无。零 P1-P3。

## 下一步

本卡 APPROVE 收口,停 completed-ready,不关 issue、不 push(硬纪律)。桌面 GUI 实机呼吸动效观感按实现侧 OPEN 项留人工复核回写。
