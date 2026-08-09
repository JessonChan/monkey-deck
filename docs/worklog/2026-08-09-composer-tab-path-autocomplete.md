# 2026-08-09 Composer Tab 路径自动补全

## 起因
Task #24219:Composer 输入框加「Tab 路径自动补全」——光标前若是路径 token,按 Tab 触发
`SessionFuzzyFind`,**单匹配直接内联补全(替换 token)、多匹配/零匹配不补全**,且不能破坏
既有 menu Tab(斜杠命令 / @mention)、IME Enter、历史导航(↑↓)等行为。

此前 Tab 的处理只在两个菜单打开时(斜杠命令菜单 / @mention 菜单)各 commit 一项,菜单关闭时
Tab 直接落到浏览器默认(移焦点)。本次是在「无菜单」分支补一条路径补全路径。

## 设计
- **路径 token 识别**(`detectPathToken`):从光标向前取最大非空白片段;只在该片段**非空、
  不以 `@` 开头(mention 领域)、不以 `/` 开头(斜杠命令 / 绝对路径)、且含 `/` 或 `.`** 时才视为
  路径候选。最后一条(含 `/` 或 `.`)是为了排除普通散文词——「fix this」里 Tab `this` 不会误触发
  补全。文本是唯一事实源,不另存 state(§5.3)。
- **scope/term 复用**:沿用 `splitScopeTerm`(按最后一个 `/` 拆),与 @mention 一致;
  `src/compo` → scope=`src` term=`compo`,`compo` → scope=`""` term=`compo`。
- **单匹配才补全**:`SessionFuzzyFind` 返回恰好 1 条 → 用 `node.path` 原地替换 token(目录项
  追加 `/` 便于继续下钻,文件项不追加);0 条或多条 → 什么都不做(焦点保留,用户继续打字)。
  这是「安静补全」——只在无歧义时出手,不开任何下拉(下拉是 @mention 的事)。
- **不破坏既有键**:Tab 分支排在 slash/mention 菜单块**之后**,仅当 `!slashOpen && !mentionOpen`
  才进;IME composing 早在函数顶部统一 return;历史导航只处理 ↑↓ 不涉 Tab;Enter 发送不变。
  另加守卫:shift/ctrl/cmd/alt+Tab 交给浏览器(OS/窗口快捷键),有选区时跳过(不破坏选区),
  `!sessionId || disabled` 时不触发(无 session 无 cwd 可查)。
- **并发**:Tab 的 fuzzy find 是异步的,keydown 不能 await。用单调递增的 `completeReqId`
  ref 标记最新请求,resolution 时比对 id,过期的丢弃(§5.3 按 identity 而非顺序,防 stale
  回写把后一次 Tab 的结果写到前一次的 token 上)。补全基于「Tab 那一刻」的 value/token 快照
  计算 `value.slice(0,start) + replacement + value.slice(pos)`,与 stale 无关。
- **无路径 token 时 fall through**:光标在空白/普通词后 → 不 preventDefault,Tab 走浏览器默认
  (移焦点),保留原行为。

## 改了哪些文件
- `frontend/src/components/Composer.tsx`:
  - 新增 `detectPathToken(text, pos)` helper(紧挨 `splitScopeTerm`)。
  - 新增 `completeReqId` ref(IME ref 旁)。
  - `onKeyDown` 在 mention 菜单块后插入 Tab 路径补全分支。
- `frontend/src/components/Composer.mount.test.tsx`:新增 `describe("Composer Tab path
  autocomplete (Task #24219)")`,7 个用例(单匹配补全 / 目录追加 `/` / 多匹配不补全 / 普通词
  不触发 / `@` token 不触发 / 无 session 守卫 / 斜杠菜单 Tab 仍 commit 命令)。

## 验证
- `cd frontend && bun test src/components/Composer.mount.test.tsx`:**29 pass / 0 fail**
  (22 旧 + 7 新)。
- 全量 `bun test`:159 pass / 31 fail / 9 err(183 用例)。31 fail 全部是**预存的**全量套件
  隔离问题(ChatView 虚拟化 / HarnessPane / SettingsPanel / QueuePanel / NewSessionModal /
  msg-meta,均与 Composer 无关)。stash 本次改动后基线同样是 152 pass / 31 fail / 9 err
  (少 7 = 本次新增用例)——失败集**完全一致**,本次零新增失败。
- 类型:`npx tsc --noEmit` 对 `Composer.tsx` 无任何报错(全仓 43 个 TS error 全是预存的
  `bindings/...` generated module not found,与本次无关;`frontend/dist` embed / wails
  bindings 生成是 dev 环境前置,非本次引入)。

## 踩坑(测试隔离)
初版「`@foo` 不被 Tab 补全」用例只 `flush()`(≈50ms)后断言「SessionFuzzyFind 未被调用」,
但 `@foo` 同时触发了 @mention 的 150ms 防抖定时器——50ms 内没射出,泄漏到下一个用例
(「无 session」)才射,导致后者误报 `SessionFuzzyFind` 被调一次。修法:用例改为派发 Tab 后
**同步**比对调用计数(Tab 路径补全若触发,是在 keydown 里同步调 `SessionFuzzyFind`,无需等防抖),
随后 `await 200ms` 让 mention 防抖在本用例内 settle,不再泄漏。根因:`mount()` 每次新建 root
不 unmount 旧 Composer,定时器跨用例存活——既有 @mention 用例都靠各自 `await 200ms` 自洽。

## 下一步
无。纯前端增量,后端 `SessionFuzzyFind` 复用现成,无需改 Go。若后续要把多匹配也做成可视化
(下拉),那是 @mention 的领地,不开第二条交互路径。
