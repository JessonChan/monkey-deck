# 2026-08-26 Review #24353: 侧栏展开态持久化(Sidebar lazy init + useEffect 写回 + mount 测试)— APPROVE

Task #24354(review)。审查对象:commit `5265355`(feat(frontend): sidebar 展开态持久化
localStorage,#57),改动 `frontend/src/components/Sidebar.tsx`(+59/-6)+ 新增
`Sidebar.expanded.mount.test.tsx`(189 行)。

## 结论

**APPROVE**。无 P1/P2;2×P3(非阻塞,建议 fix-forward)+ 2 条 P4 备忘。

## 审查过程(反向追踪,不顺着 commit message 走)

按 reviewer 反模式清单(类型补丁 / 断言锚定值)从字段定义点出发逐端确认消费:

1. **读路径**:`EXPANDED_KEY`(Sidebar.tsx:103)→ `loadExpanded`(try/catch + 非数组/
   非字符串过滤兜底空集)→ `useState<Set<string>>(loadExpanded)` lazy init → `expanded`
   → `isOpen`(L466)→ session-list 渲染分支。**消费端闭环**,测试锚定 DOM 输出
   (`session-s1` 在 / `session-s2` 不在 + caret `.open` class),非「字段存在」断言。
2. **写路径**:`useEffect([expanded])` → `localStorage.setItem(JSON.stringify([...expanded]))`,
   挂载即写一次幂等回写(顺带自愈坏值)。测试锚定**具体值**:`"[]"`、`["p1"]`、`["p2"]`,
   覆盖「挂载回写→展开→折叠」与「坏 JSON/非数组/非字符串元素」三路兜底。双向都是锚定值,
   通过反模式检查。
3. **draggingRef 守卫正确性**:dragStart 置 true + `setExpanded(new Set())`(瞬态空集,
   effect 被 guard 跳过 → 不落盘);dragEnd/dragCancel **先**置 false **再**
   `setExpanded(expandedBeforeDrag.current)`(新 Set 引用,Object.is 必不等 → effect 必触发
   → 拖拽前集合重新落盘)。时序无竞态:dragEnd 是独立事件循环任务,guard 读取发生在 effect
   执行时(渲染后),彼时已复位。拖拽中途崩溃 → 最后落盘的就是拖拽前集合,不丢用户展开态
   ——与注释声明一致,逻辑成立。
4. **引用恒变性**:`toggle`/`handleProject`/三个 drag handler 全部产新 Set,effect 必触发,
   无 Object.is bailout 陷阱;`loadExpanded` 纯读,无 StrictMode 双调风险(main.tsx 未开
   StrictMode,开了也安全)。
5. **模式一致性**:与 `md:plan-open:<sessionId>`(ChatView.tsx:190-206)同一
   lazy-init + 持久化家族;Sidebar 无 session 切换重读需求(集合全局唯一),effect 写回
   比在-callback 写更集中,成立。`md:sidebar-expanded` 全仓仅 Sidebar.tsx + 测试引用,
   单一写者,popout 模式卸载不写(effect 无 cleanup)不丢状态。
6. **不剪枝 stale ID 的决策**:注释说明项目异步加载、挂载即剪枝会清空——符合 §5.3
   (不在异步数据上堆启发式),接受。

## 验证

- `bun test src/components/Sidebar.expanded.mount.test.tsx`:3 pass / 15 expect。
- 全量 `bun test --isolate`:**384 pass / 0 fail**(本 worktree 首跑前需 `make bindings` +
  `bun install`, bindings 为 gitignore 生成物)。
- `bun run build:dev`(tsc + vite):绿。
- i18n:无新增 key,无 zh/en 同步问题;无 CSS/布局改动;无 a11y 回归(纯持久化)。
- 三端(§4.7):改动不触布局 / `isRemoteClient()` / WS。localStorage 三宿主(webview/
  浏览器/PWA standalone)均可用;浏览器+PWA 同源共享一份,桌面 webview 独立一份——按端
  持久化与 `md:plan-open` 既有语义一致,非回归。桌面 GUI 冒烟未在本环境启动(webview 需
  真机),风险面为零(渲染分支不变,仅初始集合来源变化,已被 mount 测试钉住)。

## 发现(非阻塞)

- **P3-1**:caret 按钮无 `data-testid`,测试经
  `[data-testid="project-<id>"] → closest(".project-item") → querySelector("button.caret")`
  类名链路点击——耦合 CSS 类名,§4.2 建议交互元素直接挂 `data-testid={`caret-${p.id}`}`。
- **P3-2**:测试文件头注释尾部混中文片段(「挂载期不触发真后端调用」)——逐字照抄
  sibling 脚手架,但 §3.7 新注释一律英文,建议下次顺手转英文。
- **P4-a**:stale project ID 永不清理(集合无界增长,短字符串量级可忽略;注释已声明)。
- **P4-b**:实现侧 worklog(#24353)尚未见 docs/worklog 条目——流程观察,由 coder 侧补。

## 下一步

- 可选 fix-forward:P3-1 caret testid、P3-2 注释英文化(可与 coder 下个改动同批)。
