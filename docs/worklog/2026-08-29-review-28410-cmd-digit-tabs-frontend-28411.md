# Review #28410 ⌘1-9 切已开 tab 前端面复审(sessionsRef → openTabsRef)(#28411)

日期:2026-08-29
被审:5600848(feat ⌘1-9 改切已开 tab,2 文件 +291/−12)+ d0d15dc(worklog);基线 main=d0d15dc
结论:**APPROVE**——父 issue #28409 规格六点逐条反向追代码实证全过;本机独立重跑定向 4/0 + 全量 **440 pass / 0 fail(60 文件,7534 expects)** + `build:dev` 与被审声称一致;并自行补做负向敏感性实验(临时回绑旧列表语义 → 恰好且仅语义分界的 2 条 fail),证实新测试钉的是行为边界而非文本巧合。零 P1/P2 findings,无需返工。

## 复审方法

按「类型补丁反模式」反向追踪:从规格六点出发逐条对代码消费端(不经 commit message);handler 从 openTabsRef 定义点追到 TabBar 显示序;测试逐条核对断言锚定值(非字段存在性);「旧测试不存在」声称独立走 git 历史核查(`git log -S sessionsRef` + 父 commit `git grep`),不顺 author 叙事;本机重跑全部 gate。

## 逐件验证(规格六点)

### ① handler 读 openTabsRef,与 tab 点击同款入口;projectIdOf 依赖声称成立 ✅

`App.tsx:1877` `const target = openTabsRef.current[idx]`(openTabsRef 为 `useRef<string[]>`,`:272-273` 每渲染同步 `openTabsRef.current = openTabs`);`:1880` `void openSession(target, projectIdOf(target))`——与 TabBar tab 点击 `:2343` `onSelect={(id) => void openSession(id, projectIdOf(id))}` 完全同构同路径(openSession 签名 `(sessionId: string, projectId?: string)`,:970)。显式传 projectId 不走 `projectId ?? selectedProjectId` 兜底 → 跨项目 tab 数字切换连选中项目一起切。选中即激活:openSession 内 setSelectedSessionId → TabBar `activeId` prop(:2342)→ `.tabbar-tab.active` 类,测试 1 以 `activeTabId()==="s2"` + `OpenSession:s2` 调用日志 + `defaultPrevented=true` 三锚实证。

**projectIdOf「无额外重订阅」声称验证**:`projectIdOf = useCallback(..., [sessionsByProject])`(:1763-1769);openSession 依赖数组含 `sessionsByProject`(:1099)→ sessionsByProject 变引用时两者同步换新身份,projectIdOf 身份变化集合 ⊆ openSession——deps 从 `[isPopout, openSession]` 扩到 `[isPopout, openSession, projectIdOf]` 不引入新的重订阅时机。声称成立。

### ② 数字序 = openTabs 数组序 = TabBar 显示序 ✅

openTabsRef 即 openTabs 原数组;TabBar `tabs={openTabs.filter(...).map(...)}`(:2326-2341)filter/map 保序。静态 1:1 的关键在互斥落实:popoutSession 乐观把 id 从 openTabs 移除(`:1963-1964` `setOpenTabs(prev => prev.filter(id => id !== sessionId))`),故 `!poppedSessionIds.has(id)` 过滤仅是瞬态竞态护栏,静态下数组序与显示序逐位相等。

### ③ 越界静默忽略 ✅

`:1878` `if (!target) return;` 位于 `e.preventDefault()`(:1879)之前 → 不切换、不拦截、按键透传。测试 2 用 60 侧栏 session 只开 3 tab 的夹具钉新旧语义分界:⌘4/⌘9 → `defaultPrevented=false` + activeTabId 保持 s1 + `calls.length` 零增量(旧语义必跳 s4/s9)。

### ④ popout 不挂监听 no-op,注释语义保留 ✅

`:1871` `if (isPopout) return;` effect 顶部直接不注册 keydown;` :1864-1869` 注释整体重写为英文(§3.7),原语义逐条保留(digit 序=tab 序/越界静默/popout 不挂/读 ref 防 stale closure)。测试 4:`#popout=s1` boot → 无 `[data-testid="tabbar"]` 元素 + ⌘2 `defaultPrevented=false` + 零新增 OpenSession。

### ⑤ sessionsRef 死代码零残留,diff 恰为删除无夹带 ✅

`frontend/src` 全量 grep `sessionsRef`:唯一命中是新测试文件第 3 行的**历史叙述注释**(描述旧行为,非代码引用),App.tsx 本体 = 0。diff 全量核对:App.tsx 恰 3 个 hunk——删 sessionsRef 声明+赋值(:297 附近 4 行)/ 注释+handler 体改写 / deps 数组追加 projectIdOf;测试文件纯新增。无夹带、无其它顺手改动。

### ⑥ 新测试 4 条 + 「旧测试不存在」声称独立证实 ✅

`App.cmd-digit-tabs.mount.test.tsx` 4 条断言**全锚定值**(activeTabId 具体值 / defaultPrevented 布尔 / OpenSession 调用日志内容 / calls 增量计数),非字段存在性——符合本轮注入的反模式教训。路径全部走真实用户入口:tab 经 `chat:popout-changed` restore 事件打开、激活经 tab 真实 click、关闭经 × 按钮、按键经 window 真实 dispatchEvent。

「旧列表语义无既有测试」独立核查:`git log -S sessionsRef -- frontend/src/App.tsx` 仅 2 commit(101f315 引入 / 5600848 删除);父 commit 807c2ab 上 `git grep -l "1-9\|digit" -- 'frontend/src/*.test.tsx'` 零命中 → 101f315 确未带测试,「无可改写、新 4 条即第一份回归防线」声称成立。

### Gate 独立重跑(与被审声称逐字一致)✅

本 worktree 补齐 gitignore 依赖,恰好复现被审 worklog 记录的两个环境坑(`bun install` 375 包;worktree 缺 `frontend/bindings/`,`make bindings` 按 alpha2.106 重生成 297 包/126 方法/26 模型——与 worklog §验证/踩坑记录互证):

- `bun test src/App.cmd-digit-tabs.mount.test.tsx` → **4 pass / 0 fail**(18 expect);
- `bun run test`(repo 脚本 = `bun test --isolate`)全量 → **440 pass / 0 fail**(60 文件,7534 expects,67.9s),与声称 440/0 一致(maxSize/minSize React 告警为 react-resizable-panels mock 的既有噪音,#28405/#28408 复审同判);
- `bun run build:dev`(tsc + vite development build)→ 零类型错误、构建通过。

**负向敏感性实验(复审自做)**:临时把 `:1877` 回绑旧列表语义 `Object.values(sessionsByProject).flat()[idx]?.id`(忠实于旧代码取 `.id` 的形态)→ 定向套件 **2 pass / 2 fail**,且恰为语义分界的两条:「out-of-range digit is a silent passthrough」(⌘4 落侧栏 s4,`defaultPrevented` 期望 false 实得 true)与「closing a tab renumbers」(⌘2 落侧栏 s2 而非 tab 位 s3);另 2 条(3-tab ⌘2、popout no-op)在新旧语义下行为天然重合(s1,s2,s3 恰为 p1 列表头部)双过,符合预期。`git checkout` 还原后复跑 4/0。证明套件钉的是行为契约。

### worklog 检查 ✅

`docs/worklog/2026-08-29-cmd-digit-tabs-87.md` 存在:含「行为变更」对照表(§行为变更,五维度新旧对照)、旧测试处置清单(§旧测试改写清单,如实记「无旧测试可改写」并定位新防线)、gate 数字与实测一致、范围口径如实(纯前端 window keydown,三端矩阵无新增差异格)。

## Findings 汇总

零 P1/P2。1 条 **P3 非阻塞观察**(不要求返工):刷新途中 `sessionById` 缓存未命中而 `evictSessionCache` 未及清理的瞬态窗口里,数字可能指向 TabBar 暂时隐藏的条目——但 openSession 按 id 打开属自愈路径,与 tab 点击同构,不新增风险面;静态下不可达(evictSessionCache 是 openTabs 清理 choke point,App.tsx:1809)。

## 下一步

本卡 APPROVE 收口,停 completed-ready,不关 issue、不 push(硬纪律)。#87 由上游按流程关闭。
