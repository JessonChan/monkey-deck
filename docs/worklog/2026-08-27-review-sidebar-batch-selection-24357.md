# 2026-08-27 Review #24356: 侧栏批量选择(⌘/Ctrl 点选 + Shift 连选 + checkbox + 批量删/复制目录)— APPROVE

Task #24357(review)。审查对象:commit `58b7a56`(feat(frontend): sidebar session
批量选择,#94),改动 `Sidebar.tsx`(+254/-21)+ 新增 `Sidebar.batch.mount.test.tsx`(304 行)
+ `index.css`(+40)+ i18n zh/en 各 +13 key。

## 结论

**APPROVE**。无 P1/P2;5×P3(非阻塞,建议 fix-forward)。

## 审查过程(反向追踪,不顺着 commit message 走)

按 reviewer 反模式清单(类型补丁 / 断言锚定值)逐条确认消费端:

1. **ConfirmTarget batch kind 全链路消费**:`{kind:"batch", items}`(Sidebar.tsx:97)→
   `openBatchConfirm` 捕获渲染序快照 → batch modal 渲染 `confirm.items`(标题预览 +
   batchMore)→ `onConfirmBatchDelete(confirm.items)` 逐项 `onRemoveSession`。闭环,
   非「字段加了没人读」。
2. **13 个 i18n key 逐个反查消费**:`rg sidebar.batchXxx Sidebar.tsx` 全部 ≥1 次引用
   (batchDelete 4 次/batchCopyDirs 2 次),zh/en 同步(locale 对齐测试 + diff 目检)。
   `{{count}}` 走 base-key 插值是仓内既有模式(`loadMore`/`groupToolsCount`),无 plural
   陷坑。
3. **选择/连选语义**:`onSessionRowClick`(L567)三分支——selMode/modifier → toggle;
   Shift+anchor 在 `projectList(projectId)` 上取段,anchor 跨项目/不可见(findIndex<0)
   降级单选 toggle(§5.3 按稳定 id 找不变量,不假设顺序);plain click 才 activate。
   `projectList` 收敛渲染循环/kbd 导航/连选三处共用,消除漂移(原 kbdList IIFE 与渲染
   循环两份重复计算确实同构,`hiddenCount` 的 Math.max 改写与原 slice 语义等价)。
4. **剪枝 effect**:`allSessionIds` memo([props.sessionsByProject])→ setSel 保留仍存在
   的 id,`changed ? next : prev` Object.is bailout 防无变化重渲染。正确;批量删除过程中
   每 await 触发的 props 更新会顺带剪掉已删 id,与最终 exitSelMode 无冲突。
5. **Esc 分层**:selMode Esc handler(L426)对 input/contentEditable 让路、`ctx||confirm`
   非空时 return。双层 window 监听同时挂时(closeCtx 的 Esc 先注册先执行)setState 异步
   → selMode handler 闭包里 confirm 仍为旧值非 null → 让路,不会一次 Esc 连关弹窗又退
   选择模式;弹窗关掉后的下一次 Esc 才退出。与注释声明一致。
6. **复制 payload 锚定值断言**:测试 5 断言 `lastCopied === "/tmp/p1\n/wt/s2\n/tmp/p2"`
   (点击序 p4→p1→s2 乱序,输出按渲染序 + worktreePath||path 解析)——精确值断言,
   非字段存在断言,通过反模式检查。删除流同样锚定 `removed === ["s1","s2"]` 且确认前
   `removed === []`(confirm 门控)。
7. **owner-with-guests 边界**(App.tsx:1799-1814):`removeSession` 对 owner-with-guests
   `setDeleteWt` 后立即 return(不 throw)→ 批量循环继续删其余项、结束 `exitSelMode()`
   在 3 选项弹窗之下执行——实现侧 worklog 已声明为已知边界(「语义正确但体验一般」),
   接受,不另立发现。
8. **CSS/布局**:`--sel-accent/--accent-soft/--r-md/--r-sm/--elev/--sep-strong` 等变量
   全部存在;`.sidebar` flex-column → batch-bar 位于 project-list(flex:1)之后即钉底,
   `flex-wrap` 防窄侧栏溢出;`.session-item-row` flex → checkbox 作首子元素不破行布局。
   无重绘型效果(transition 仅 background/color/border,§4.6 合规)。
9. **a11y/§4.2/§4.5**:checkbox `role="checkbox"`+`aria-checked`+`aria-label`(真
   `<button>` 天然 Space/Enter 可达);batch-bar `role="toolbar"`+`aria-label`;全部新
   交互元素带 data-testid(batch-select-mode/sel-*/batch-bar/batch-count/batch-copy-dirs/
   batch-delete/batch-exit/batch-delete-confirm)与 react-tooltip;弹窗复用既有 Esc/外点
   关闭。桌面布局仅头部 +1 icon 按钮 + 行首条件 checkbox,无既有布局改动。

## 验证

- 本 worktree 首跑 8 fail 全为 `Cannot find module '.../bindings/...'`——bindings 为
  gitignore 生成物,`wails3 generate bindings` + `bun install` 后重跑。
- 全量 `bun test --isolate`:**390 pass / 0 fail**,与实现侧 worklog 声明一致。
- `bun run build:dev`(tsc + vite):绿。
- 三端(§4.7):纯前端改动,不触 `isRemoteClient()`/WS/断点(≤768px 布局仅新增条件
  渲染节点 + wrap 的 batch-bar);复制走 lib/clipboard 三通道(#129 语义保持)。本环境
  无 GUI,桌面 webview 冒烟同实现侧标注待用户侧——风险面低(新增均为条件渲染分支,
  已被 mount 测试钉住)。

## 发现(非阻塞)

- **P3-1 测试注释承诺了不存在的覆盖**:测试 3(Sidebar.batch.mount.test.tsx:231-234)
  注释称「Shift works upwards too: anchor stays at s3, shift-click s2 keeps s2..s3」,
  但随后只 meta- deselect 了 s1——**反向取段分支(`a > b` 交换,Sidebar.tsx:576)从未
  被执行**;且注释本身有误:anchor 是初始 meta 点的 s1(shift 路径不移动 anchor),不是
  s3。建议补一条真实 upward shift-click 断言(anchor s3 → shift 点 s2 → s2/s3 选中),
  顺带修正注释。
- **P3-2 计数值未锚定**:`batch-count` 断言为字面 key `"sidebar.batchCount"`(identity
  mock `t:(k)=>k` 丢弃 `{count}`)——「N 已选」的插值输出全仓无断言。与 sibling 测试
  mock 口径一致故不阻塞;建议 mock 升级为 `t:(k,opts)=>插值` 后锚定 `"3"` 类值。
- **P3-3 部分失败重试重放已删 id**:`onConfirmBatchDelete` 循环 confirm 时捕获的完整
  `items`;若第 k 项失败,重试从 0 重放——已删 id 的 `DeleteSession` 大概率 throw →
  弹窗卡在错误态(真凶可能只是瞬时故障)。建议确认点击时按 `allSessionIds` 过滤
  `items`(§5.3:尊重数据源,别对陈旧快照堆重放)。
- **P3-4 select mode 下 kbd Enter 语义不一致**:plain click 在 select mode 是 toggle,
  但 kbd 导航 Enter(Sidebar.tsx:541-547)仍 activate session、Space 无 toggle——键盘
  用户与鼠标用户模态不一致。可在 `onSidebarKeyDown` 对 selMode 分支改 toggle(Enter/
  Space),非阻塞。
- **P3-5 `.selected` 与 `.kbd-active` 的 box-shadow 互斥**:两条均为单一 `box-shadow`
  声明(index.css:264 vs 281),同特异性后者胜 → kbd 光标落在已选行时 accent 左条被
  inset ring 替换。注释称「stackable with .active」对 background 成立、对 box-shadow
  不成立;若需共存,合并为一条 `inset 2.5px 0 0 var(--accent), inset 0 0 0 1.5px
  var(--accent-2)`。

## 下一步

- 可选 fix-forward:P3-1 补 upward shift 断言 + 修注释、P3-3 重试按现存 id 过滤
  (两者都是小改动,可与 coder 下个改动同批);P3-2/4/5 备忘。
