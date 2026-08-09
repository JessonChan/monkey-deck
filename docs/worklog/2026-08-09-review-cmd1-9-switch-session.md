# 2026-08-09 Review #87 ⌘1-9 切 session Tab (APPROVE, Task #24224)

**起因**:fe-reviewer 复审 coder 产出 #24223(已合 main `101f315`)。单文件改动
`frontend/src/App.tsx`(+24 行):新增 `sessionsRef`(防 stale closure)+ 顶层 window
keydown listener 实现 ⌘/Ctrl+1-9 切到当前选中项目的第 N 个 session。

对照 issue #24221 八条 DoD + 反模式排查,结论 **APPROVE**,无 NEEDS CHANGES。

## 逐点核验(DoD 1–8)

1. **⌘/Ctrl+1-9 切第 N 个 session** ✅
   `App.tsx:1630-1639`:`idx = Number(key) - 1`;`target = sessionsRef.current[idx]`;
   命中后 `openSession(target.id, target.projectId)`。idx/key 映射正确(⌘1→idx 0)。

2. **N > session 数量静默** ✅
   `if (!target) return;`(`:1636`)。无报错、无 UI 噪声。

3. **preventDefault 生效** ✅ —— 见下「决策点」,coder 选择合理。

4. **与 ⌘W / ⌘J / ⌘F 不冲突** ✅
   grep 全文件 metaKey/ctrlKey listener 仅三处:`⌘J`(`:1267` 切终端)、`⌘W`(`:1609`
   关 tab)、`⌘1-9`(本次)。键域不相交(字母 vs 数字 `1-9`),listener 互不误触发。

5. **popout 窗口不挂 listener** ✅
   `if (isPopout) return;`(`:1629`),与 `⌘W` effect(`:1607`)同一 popout 门控约定。

6. **ref 防 stale closure,deps 合理** ✅
   `sessionsRef`(`:204-205`)每次 render 同步写 `current = sessions`,handler 在 keypress
   时读最新值。effect deps `[isPopout, openSession]` —— 与紧邻的 `⌘W` effect
   (deps `[isPopout, closeTab, closeFileTab]` + 读 `selectedSessionIdRef`/
   `activeFileTabBySessionRef`)同一套「ref 读最新、deps 只放稳定身份」模式,一致、
   正确。`openSession` 是 `useCallback`(`:789`),身份稳定,不会高频重订阅。

7. **session 排序与侧栏一致** ✅
   `sessions`(`:177`)= `sessionsByProject[selectedProjectId] ?? []`;Sidebar
   (`Sidebar.tsx:303`)读的是**同一份** `props.sessionsByProject[p.id]`(同源数组,
   切片分页只影响展示条数,不影响顺序)。⌘1-9 与侧栏取同一数组,排序天然一致
   (pinned 优先 + updatedAt 降序的真相在后端 `ListSessions`,两侧都继承,无需前端
   再排)。**「同源 = 一致」是这里的不变量,不是巧合。**

8. **现有 session 选择 / 侧栏 / ⌘W 无回归** ✅
   新 listener 是**纯增量**(只挂一个新 window keydown,不动任何既有 state/effect)。
   作用域仅 ⌘/Ctrl + 数字 `1-9`,不触碰 session 选择、tab、侧栏、⌘W/⌘J 任何共享状态。

## 决策点:不足 N 时是否 preventDefault

issue 倾向「不足时仍 preventDefault(避免 ⌘9 触发浏览器行为)」;coder 选「不足时放行
默认(不 preventDefault)」。**核:coder 选择合理,非阻塞。** 理由:

1. **桌面 webview 无浏览器 tab 默认行为**:Wails3 webview(Win=WebView2 /
   macOS=WKWebView / Linux=WebKitGTK)是 app 自己的窗口,**没有浏览器 tab 概念**,
   ⌘1-9 / Ctrl+1-9 在这些引擎里**没有需拦截的系统默认行为**(浏览器里的「切浏览器 tab」
   只存在于真浏览器,不在嵌入式 webview)。issue 作者的担忧基于「真浏览器」心智模型,
   不适用于桌面 webview。放行默认 = 什么都不发生 = 与静默 no-op 等价。
2. **与本文件既有约定一致**:`⌘W` effect(`:1611-1612`)就是 `if (!sid) return;` 在
   `preventDefault()` **之前** —— 「只在真要行动时才 preventDefault」是本文件既有约定,
   ⌘1-9 跟随同一约定,一致 > 局部更「严」。

(注:macOS 原生 ⌘W = 关窗口,所以 ⌘W 在 `!sid` 时不 preventDefault 是**有意放行原生关窗**;
⌘1-9 无对应原生语义,放行只是「无默认可拦」。两者动机不同但落点相同:行动才拦截。)

## 类型安全 / Wails binding 对齐

- `sessionsRef = useRef<Session[]>([])`,`sessionsRef.current[idx]` 经 `if (!target)` 收窄
  到 `Session`;`target.id` / `target.projectId` 调用安全。
- **binding 端 `Session` 模型确认有 `id: string` 与 `projectId: string`**
  (`frontend/bindings/.../store/models.js:390-408`,本审 `wails3 generate bindings` 重生成
  后 grep 复核)。`openSession(target.id, target.projectId)` 与签名
  `openSession(sessionId: string, projectId?: string)`(`:789-790`)对齐。
- `Session` 在 `App.tsx:6` 已有 import,本次未新增任何 module 依赖。

## 反模式排查(learning checklist)

- **类型补丁反模式**(字段加了没人消费):无新字段。`sessionsRef` 立即被 `:1635` 的 handler
  消费;`target.id` / `target.projectId` 被 `openSession` 消费。全链路有消费端。✅
- **测试断言锚定值**:本次为纯键盘交互,无新增前端测试(与既有 ⌘W/⌘J 一致,无 jsdom
  模拟 keydown 的先例);行为核验靠静态逻辑 + tsc。✅

## 可访问性 / 主题 / i18n

- **data-testid / 键盘导航**:keydown listener 不涉及 DOM 元素,无 testid 需求;不改动
  任何 focus/Esc 行为。✅
- **CSS / 主题**:纯逻辑改动,零 CSS。✅
- **i18n**:无新增用户可见文案(silent no-op,无 UI 文本),无 i18n key 需求。✅

## Verdict:APPROVE

八条 DoD 全过、类型安全、binding 对齐、无键冲突、无回归。决策点(coder 选不足时不
preventDefault)经核合理且与既有 ⌘W 约定一致。**无 NEEDS CHANGES,无微修。**

## 验证(acceptance gate)

- `wails3 generate bindings`:293 packages / 2 services / 105 methods / 19 models(本审重生成,
  用于 tsc 与 Session 字段复核;产物 gitignored 不入库)。
- `cd frontend && bunx tsc --noEmit`:**exit 0**(clean,零 TS 错误)。
- 静态核验:grep 全文件 metaKey/ctrlKey listener 确认键域不相交;`sessions` 数据源 ==
  Sidebar 数据源(同 `sessionsByProject[selectedProjectId]`)。

## 下一步

- 桌面 app 实测:macOS WebKit 下 ⌘1-9 切 session、不足时静默、与 ⌘W/⌘J 并存。
- Win WebView2 抽检 Ctrl+1-9(Ctrl 在 Win 是主修饰键)。
