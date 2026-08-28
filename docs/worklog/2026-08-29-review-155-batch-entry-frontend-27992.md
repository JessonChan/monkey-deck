# #155 前端面终审:批量选择入口迁移 + 项目级一键全选(任务 #27992)

日期:2026-08-29 · 审计对象:b9572cb(feats)+ 6d9ba69(worklog)· 结论:**APPROVE(completed-ready)**

## 审什么

#155 两点意图:①批量选择入口从 sidebar-header 迁到项目行按钮组;②新增项目级「全选当前可见 session 并进入选择模式」。约束:③空选择集不报错;④#94 既有语义(Shift 延伸/modifier 点击/批量操作条/anchor)零改动。

## 逐条复核结果

### ① 入口迁移正确性 + #94 零回归 —— 通过(消费链逐点反查)

- header 旧按钮 `batch-select-mode` 已删,`sidebar-header-acts` 只剩 settings/add-project;新入口 `select-all-sessions-<pid>` 落在项目行按钮组 search 与 new-session 之间(`icon-btn small` + `ListChecks size=13`,与组内 search=12/plus=13 同形制)。反查死键死类:`batchSelectOn/Off`、`batch-select-mode`、`batch-on` 全仓 grep 零残留,CSS 两条 `.icon-btn.batch-on` 规则同步删除,clean cutover。
- #94 各交互逐段读码未动:onSessionRowClick 的 ⌘/Ctrl toggle 与 Shift+anchor 范围数学(Sidebar.tsx:669-689,仍用 `projectList` 共享渲染数组)、checkbox 行内按钮(849-863)、Esc 退出 window 监听(516-528)、批量复制/删除与确认弹窗(247-275 / 954-992)全部原样。
- **anchor 不碰(④ 专项)**:`selectAllProject`(484-494)只 union 进 `sel` + `setSelMode(true)` + 折叠自动展开,不写 `selAnchorRef`——「最后单独点击行」语义保留,Shift 后续延伸仍锚在真实点击行。正确取舍:select-all 不是单行 toggle,不伪造 anchor。
- 旧 header 按钮原本兼作「退出选择模式」开关;迁移后退出路径 = Esc + batch-bar X(`batch-exit`),两者 #94 既有且测试覆盖(套件 178/221 行断言),无退路口缺失。

### ② 可见性口径 —— 通过(与渲染数组同一事实源)

- 「可见」= `projectList(pId)`:与渲染循环、键盘导航、Shift 范围数学共用同一数组——搜索/标签过滤生效态即过滤结果集(该态绕过分页),未过滤态即分页切片。隐藏 session(load-more 尾部)不误收,与 #155「当前可见」字面一致。
- 折叠项目:selectAllProject 自动展开(先例 = 紧邻搜索按钮 toggleSearch 同款),checkbox 真实落地;他项目不受影响(测试 365-379 断言 p1 不误选)。
- 边界(评审裁量,记 P3 观察):未过滤态全选取分页切片(SESSION_PAGE),>25 session 的项目需「加载更多」后再点一次(union 可续选)。这与「可见」口径自洽且 worklog 已留 OPEN,一行可改全集,不构成偏离。
- 空选择集 no-op(③):`list.length===0` 直接 return——规格允许「禁用或 no-op」二选一,no-op 保住 §4.5 tooltip(disabled 会吞 hover)。合规。

### ③ 行高/密度 —— 通过

- 按钮组从 2 枚 22px(`.icon-btn.small`)变 3 枚,`.project-item` 为 flex+gap:1px、`.project-main` flex:1+min-width:0、`.project-name` ellipsis——第 3 枚按钮由名称截断吸收,行高仍由 22px 按钮与 23px 主区共同决定,不变。≤768px 抽屉(min(80vw,320px))块内对 project 行零特殊规则,#126B 断点不涉本项目结构;320px 宽下名称区仍有 ~200px 截断余量,无换行/溢出。
- 「12px 纪律」:新按钮图标 13px 与同组 plus 一致,无越级尺寸。

### ④ i18n zh/en 同步 —— 通过

- en `"Select all sessions in this project"` / zh `"全选本项目会话"`,两 locale 同步原位替换;tooltip 走 react-tooltip(`md-tip`),无原生 title。消费点 Sidebar.tsx:744 唯一,键值齐备。

### ⑤ 测试 —— 通过

- `Sidebar.batch.mount.test.tsx` 10 项:2 项迁移(header 入口→项目行入口,语义不变)+ 6 项 #94 既有 + 4 项新增(过滤态可见集含「解除过滤后隐藏项未选中」反证 / 跨项目 union=4 / 折叠自动展开 / 空项目 no-op)。断言全部锚定值(`batch-count` 文本 = `sidebar.batchCount {"count":N}`、复制 payload = `"/tmp/p1\n/wt/s2\n/tmp/p2"`、removed 序列),无「字段存在」式断言。
- 本机复跑:`bun test --isolate` **408 pass / 0 fail**(与实现 worklog 一致;新 worktree 先 `bun install` + `wails3 generate bindings`,bindings 环境性不入库)。附注:不带 `--isolate` 全量跑会出现 10 个 clipboard 系失败——已在 b9572cb 与基线 7d50c58 双侧做同组对照(3 个失败文件单独成组跑均 14/0 过),证实为 runner 跨文件全局态污染(文件执行序敏感),与 #155 内容无关。
- `bun run build`(tsc + vite)零错误(仅既存 chunk-size advisory)。

## P 级发现

- **P3(观察,非阻塞)**:未过滤态全选=分页切片而非项目全集(见 ②);与「可见」口径一致,worklog 已留 OPEN,维持现状。
- **P3(环境)**:非 isolate 全量跑的 clipboard 系失败为 runner 全局态污染,双侧基线对照排除与 #155 的因果;建议后续把 clipboard 全局 mock 收敛为 per-file(不属本卡)。
- 无 P1/P2。

## 三端说明(§4.7)

纯前端 Sidebar 交互,零新增 CSS/后端面/远程守卫/断点结构,三端渲染面无分化点;行为面由 mount 测试覆盖。本沙箱无法起 Wails GUI,桌面 GUI(hover tooltip 形态)/远程浏览器/PWA(≤768px 按钮组)实机冒烟留人工复核(与实现 worklog 同一 OPEN)。

## 结论

APPROVE。停 completed-ready,不关 issue(硬纪律);push 与实机三端冒烟由人工决定。
