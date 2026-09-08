# #197 fork 翻页补 base 前缀——独立复核(review)

日期:2026-09-09
关联:#197、#29053(被审实现)、316afe4 + 0dced97、#172 Phase 3、#208、#189
结论:**APPROVE**(0 阻塞项,2 非阻塞观察项见文末)

## 方法

反相核实:不信 commit/worklog 叙事,以 main 内容为准逐项重做。两个独立手段:

1. **红绿对照(red-check)**:把新增的 `App.fork-prefix-pagination.mount.test.tsx` 原样拷入父提交 worktree(34e5f2f,补 symlink node_modules + 拷贝生成的 bindings),跑同一测试——自愈测试在 `expect(loadCount(FORK)).toBe(2)` 处**红**(实测 Received 1),walk 测试**绿**。证明测试钉住的是修复本身而非顺带行为,且 walk 是纯回归钉。
2. **基线全量对照**:同一环境分别跑 main(0dced97)与父提交的全量 `bun test`——main 558 pass / 21 fail(579 tests / 82 files),基线 556 pass / 21 fail(577 / 81),**21 条 fail 清单逐字节 diff 完全一致**(clipboard 通道 / KaTeX / 面板布局 / tab 重编号等 happy-dom 既有问题),净增恰为 2 个新通过测试。

## 逐项核查

### ① 单测真实钉死 — 过

- **Go 侧**(`TestForkLineagePageWalkNoDupNoGap`,own=3/base=50/limit=20):本审独立手算游标代数与断言逐一对上——首拉探针窗 `[-18..3]` 恰 21 行;walk 3 页 `[-17..3]` / `[-37..-18]` / `[-50..-38]`,hasMore 位 `[true,true,false]`;末页恰 13 行无 +1;拼装 53 行 = `[-50..-1]∪[1..3]` 无重无漏(仅 `-1→1` 一个合法接缝);base 顶 `-50` 终止。另有 #172 既有三测(5 源消息属性断言 / 水位隔离 / 非 fork 纯路径)仍绿。
- **前端**(`App.fork-prefix-pagination.mount.test.tsx`,mock 逐条移植 forkLineagePage 契约,PAGE_SIZE=30):合并边界页钉死(首拉 31 行探针页显 30 = src-24..50 + own,`src-23` 断言**不在屏**);一次点击无缝续接 base(`calls=[0,-27]`);53 行逐行 `countText===1`(无重无漏,锚定值非存在性断言);base 顶到头按钮消失。**slice(1) 两端覆盖**:hasMore 页切探针、末页无探针(23 行全显)都有断言。
- 「候选 A 合并页/slice(1) 边界」疑点(后端是否 off-by-one)经 Go 测试实证不存在,后端零改动正确。

### ② 修复反相核实 — 过

- **游标缺失路径**:wire 保持 `beforeSeq=0`(0 = 最新合并页契约,#189 首屏懒加载不动),响应 **REPLACE**(fresh-open 语义)不 prepend,且 `page[0].seq` 回填游标、hasMore 回写——一次交互恢复页+游标+hasMore。
- **粘性缺失态的真实路径**(hasMore 也被丢 → load-more 按钮根本不渲染 → loadMore 不可达)由 **turn-end 自愈**兜住:重拉后游标日志 `[0,0,-26]`、`live-tail` 恰 1 次(REPLACE 不重)、base 全量逐行恰 1 次——修复前同一测试红(无重拉)。
- **游标存在路径零回归**:walk 测试在父提交上同样绿(prepend 行为前后一致),红绿对照实证。
- 注:`seed===undefined` 的 REPLACE 分支按现有写者全部成对(oldestSeqRef/hasMore 同 tick 同改,openSession/loadMore/drop/evict 四处逐一核对)属防御性分支,UI 不可达、无 UI 级测试;语义正确,成本 2 行,可接受(见观察项 1)。

### ③ 与 #208 交互 — 过

- 自愈触发条件 = **turn-end push**(idle/error/closed)+ 选中 session + 不在 `loadedSessionsRef`,precisely #208 跳过重拉留下的状态;busy 期间依旧不拉(测试钉:`loadCount` 保持 1、尾巴存活、按钮缺席)。
- `statusBySessionRef` 急写镜像 + `setTimeout(0)` defer,确定性穿过 openSession 的 busy 门(worklog 防坑 2 与代码一致)。
- 快照合并不触发自愈(防坑 1):`SessionStatuses` mock 返回真后端语义,测试钉了快照不清 busy。
- #208 既有 mount 测试无 idle 推送路径,全量套件绿 → 门控零回归。四场景复核见被审 worklog,与代码逐条对上。

### ④ 回归 — 过

- `bun run build`(= `tsc && vite build`)零错误;`go vet ./...` 干净;`go test ./...` 全包 ok(根包 embed 需先有 `frontend/dist`,本审先构建再测,一次通过)。
- #189:walk 测试即 fork 行重开首屏场景;非 fork 首屏懒加载契约(wire 0 + limit+1 探针)未动。
- 全量对照见「方法」:21 fail 与基线同一批,零新增。

### ⑤ worklog — 过

`0dced97` 在 main,内容与本审独立读码结论一致(两段根因、两个防坑、先红后绿、558/21 基线同一批);OPEN 项(openSession 先 add `loadedSessionsRef` 后 await,拉取拒绝会毒化重开)经查代码属实(App.tsx `pullMessages` 分支),非本任务面,留档合理。

## 提交卫生

316afe4 = 修复 + 测试原子提交,0dced97 = 文档独立提交(§6.2);新增注释全英文(§3.7);后端零改动符合「先实证后动手」(§5.3);测试锚定值断言,非存在性断言。

## 观察项(非阻塞,不要求本次处理)

1. **REPLACE 分支为防御性代码**:游标/hasMore 现有写者全部成对变更,`seed===undefined && hasMore=true` 在 UI 上不可达,该分支无测试覆盖。当前作为「缺失游标永不 prepend」的不变量守卫是合理冗余;若未来出现单边写者,它就是承重墙——届时必须补测试。
2. **自愈 × 自动续跑(#126A)的理论竞态**:turn-end push 触发 defer 重拉,若后端立即排空队列开下一 turn(prompting push)且其状态效果尚未刷新镜像,`targetBusy` 可能读到旧 idle → 重拉冲掉新 turn 流式尾巴。概率被 openSession 内先行的 `OpenSession` IPC 往返压低(openSession 先 await 该调用再读镜像),且消息增量落库、内容不丢、下次 idle 重开自愈。出现实际案例再在 §5.4 建条,现在不为它加代码。

## 下一步

- 真机冒烟(桌面 app 实操 fork 会话翻页到 base 头)后可关 #197(与被审 worklog 一致)。
- 本审不关 issue、不 push、不派卡;停在 completed-ready。
