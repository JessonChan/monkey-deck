# 复审 #28431:重命名标识状态分型 前端面(#154 二期)

日期:2026-08-30 · 基线:main=ca5ce8b · 审查对象:4111350(feat)+ ca5ce8b(docs)
结论:**APPROVE** —— 四点规格反向实证全通,gate 与声称逐字一致,夹带检查干净。

## 审法(防类型补丁,从定义点反向追消费端)

不顺实现叙述走,从 `renamedMark` 定义点(Sidebar.tsx:912)出发逐点确认「真的被渲染/被断言到输出」,再用负向实验咬住规格里的否定性条款。

### ① idle 尾位(meta 簇前)+ 不随选中翻转

- 判定源:Sidebar.tsx:856-857 `const st = props.statusBySession[s.id]; const active = st === "prompting"` —— 槽位判定**纯派生自 statusBySession**,undefined/error/reconnecting 全归 idle(`!active`),与拍板 idle 定义恒等。
- 落点:idle 槽 `{:956}` 在 `session-label` 之后、meta 簇(popout :957 / harness :962 / pin :963 / terminal :968 / scheduled :973 / status :992)之前 —— 与规格「标题尾部、meta 簇前」逐节点吻合。
- **不随选中翻转(负向实验)**:`selectedSessionId` 全文件仅触及行 className(:926)与 kbd ref,结构上不可能影响槽位;reviewer 追加 scratch mount 实验(已跑即删,不入库):idle+选中本行 → `label.nextElementSibling === mark` 保持;prompting+选中同项目另一行 → `label.previousElementSibling === mark` 保持,6/6 绿。注:仓内测试套件未钉 selection-flip 用例,靠「判定源排除 + 实验双证」,非阻塞(槽位表达式里不存在选中态输入)。

### ② prompting 前位常驻

- 前槽 `{:952}` `{active && renamedMark}` 在 label 前(dot → pencil → title,一期现状零位移);test 2 `expect(label.previousElementSibling).toBe(mark)` 锚定。
- 两槽互斥:`active &&` / `!active &&` 恰好一真,同一 React element 描述符只进一棵树,无重复渲染。

### ③ 10px / --text-3 / renamedTip / 行高全不变

- 单一 `renamedMark` 元素(:912-921):`Pencil size={10}`、className、`data-tooltip-id="md-tip"`、`data-tooltip-content={t("sidebar.renamedTip")}`、`renamed-<id>` testid 两态字面同一 —— 「同一节点两槽位」成立,不是第二套表示。
- index.css diff 仅注释块;`.session-renamed`/`.session-renamed svg` 声明行(317-318)逐字节未动。
- 测试钉死:test 4 CSS 契约三声明(`flex-shrink: 0` / `display: inline-flex` / `color: var(--text-3)`)+ 两态各一组 renamed+pinned vs 素行 `offsetHeight` 相等;test 1/2 两槽位均断言 tooltip id + key;真实文案钉死(zh「用户重命名」/ en "Renamed by user",zh.json:92 / en.json:92 双语 key 齐平)。

### ④ 无 custom_title 两态均不显 + 移动端同规则

- `renamedMark = s.customTitle ? … : null` → 两槽位同 null;test 3 两态各 mount,断言零 `renamed-<id>` 节点 + 零 `.session-renamed`(双查询)。
- 移动端:grep 全 css,`.session-renamed` 仅 :317-318 两条、不在任何 @media 块内;槽位是纯 DOM 序条件渲染,无断点分支、无 `isRemoteClient()` 守卫 —— 「≤768px 同规则零特殊化」由构造成立。

## Gate 复核(与声称核对)

- 环境前置:新 worktree 缺 gitignored `node_modules` 与 `frontend/bindings/`(首次跑 459/7 fail,7 个失败全是 `Cannot find module '../bindings/...'`,测差 481-466=15 与 import 失败文件吻合)。`bun install` + 仓库根 `make bindings`(= `wails3 generate bindings -clean=true -ts -i`,注意须在仓库根跑)后复跑。
- `bun test --isolate`:**481 pass / 0 fail** —— 与声称逐字一致(stderr 的 React `maxSize` DOM warning 为 resizable 系既有噪音,非失败)。
- `bunx tsc --noEmit`:rc=0(声称 build:dev 的 tsc 段等价复核)。
- 夹带检查:4111350 恰好 3 个前端文件(Sidebar.tsx / index.css / renamed mount test),无无关 hunk、无后端文件;worktree 复审后 `git status` 干净(scratch 实验文件已删)。

## 验证小结(§4.7 三端)

- 后端/binding 面:零改动,无需统一验。前端行为面:mount 四断言 + scratch 负向实验(bun test 实跑)。
- 桌面 GUI / 远程浏览器 / PWA 实机目验:本沙箱无法起 Wails GUI,同实现 worklog 所记留人工复核(槽位是纯 DOM 序,无端差异构造点,风险低)。

## 结论

**APPROVE。** 四点规格全部反向实证;唯一注记:selection-flip 条款仓内无测试钉死(结构排除 + reviewer 实验双证),不阻塞。按硬纪律停 **completed-ready**,不关 issue、不 push。
