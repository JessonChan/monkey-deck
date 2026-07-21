# 2026-07-22 Review #21330 记住上次 harness 端到端验收结论(NEEDS CHANGES)

## 起因

Task #21332(Review):验收「新建对话记住上次 harness」改动(issue #21330)。
实现落在 Task #21331 的两个 commit:

- `18c3f93`(feat(chat): CreateSession 持久化 lastHarness + GetLastHarness + 前端默认选中,纯代码)
- `4b5b2a6`(docs(worklog): 同名 worklog,纯文档)

issue #21330 原文:**「新建对话默认记住上次 harness(没选过则不设默认,要求显式选择)」**——
含两条要求:① 记住上次;② **没选过则不设默认、要求显式选择**。

验收重点(Reviewer 职责):**拒收「build 绿但行为没改对」的空壳改动**——尤其核对
「没选过则无默认(null + confirm 禁用 + 请选择提示)」这条是否真落地,而非只看 lastHarness
持久化。

## 验收点逐条核对

### ① 持久化(✅ PASS)

`internal/chat/chat.go:515`:`CreateSession` 在 `hid := harness.Normalize(harnessID)` 后
`SetSetting(ctx,"lastHarness",hid)`(失败仅 Warn);新增 `GetLastHarness() string`(`:2092`)
读回。复用既有 GetSetting/SetSetting 通道(defaultModel 同范式,§5.3)。跨新建 / 跨重启(SQLite
本地落盘)默认选中上次确认用的 harness。后端单测 `TestCreateSessionPersistsLastHarness`
覆盖 空/opencode/未知→Normalize 三路径。✅

### ② 未选过则无默认(❌ FAIL —— 核心缺失)

issue 明文要求「没选过则不设默认,要求显式选择」。验收点 #2 进一步细化:
「harness state 为 null 时无默认选中,confirm 按钮禁用(canConfirm 加 && harness !== null),
UI 提示「请选择」(复用 worktree 同款 .ns-required 样式)」。

实际实现 `NewSessionModal.tsx:22-24`:

```ts
const [harness, setHarness] = useState(
  lastHarness && harnesses.some((h) => h.id === lastHarness) ? lastHarness : (harnesses[0]?.id || "omp"),
);
```

**harness state 永不为 null**——没选过(lastHarness 空)时硬选 `harnesses[0]?.id`(恒为 omp)。
这是「不设默认」要求的**反面**。具体三处全部缺失:

- harness state 类型是 `string`(初值恒非空),不是 `string | null`。❌
- `canConfirm`(`:37`)= `!isGit || worktree !== null`——**没有 `&& harness !== null`**,
  confirm 按钮永远不会因 harness 未选而禁用。❌
- harness 字段 label(`:45`)无 `<span className="ns-required">`「请选择」提示,
  没复用 worktree 同款样式(`:67` 的 `ns-required`)。❌

coder 的 commit message / worklog 甚至明文写了「未安装/未知回退列表首个」「未安装/未知回退首个」——
**自觉选择了与 issue 相反的硬选首个**,把 #2 整条漏掉。

### ③ 两个 guard(❌ FAIL)

验收点 #3「单 harness / lastHarness 失效回退两个 guard」:

- **sub 2(lastHarness 对应 harness 已被移除 → 回退未选而非硬选第一个)**:实现落
  `harnesses[0]?.id`(硬选第一个),不是 null。❌ 与 #2 同根:harness state 不允许 null。
- **sub 1(单 harness 是否自动选中)**:此项语义上是「是否」可接受——单 harness 自动选中
  无歧义、合 KISS,可不阻塞;但当前实现对**多 harness** 也硬选首个,这才是核心违反。

### ④ 后端 setting 接口 + 单测(✅ PASS)

`GetLastHarness()` 经 Wails binding 暴露(`wails3 task build` 重新生成 bindings,
`App.tsx:597` `ChatService.GetLastHarness()` 调用通)。单测 `last_harness_test.go` 覆盖
持久化 + Normalize 回退。后端侧无问题。✅

### ⑤ 对照 worktree null 范式一致性(❌ FAIL)

验收点 #5 要求「对照同弹窗 worktree null 范式一致性(:29 canConfirm、:58 未选提示)」。
worktree 字段是本项目「必须显式选择」的现成范式:

- `:26` `useState<boolean | null>(isGit ? null : false)`——null 表未选;
- `:37` canConfirm 含 `worktree !== null`——未选禁用 confirm;
- `:67` `{worktree === null && <span className="ns-required">{t("newSession.required")}</span>}`
  ——未选时 label 旁出「请选择」红字。

coder 声称「照抄 worktree null 范式」,但**只抄了「弹窗打开时预取依赖值塞进 newSession 状态、
作 prop 传给 modal」这层(数据预取),没抄「null + canConfirm 禁用 + ns-required 提示」这层
(显式选择)**——而后者才是 issue #21330 的核心。harness 字段与 worktree 字段在同弹窗里行为
不一致:worktree 必须显式选,harness 永远有默认。❌

### ⑥ 未把 RAK 运行时文件或 AGENTS.md commit(✅ PASS)

`git diff b1c3a05..4b5b2a6 --name-only` 仅 5 文件(App.tsx / NewSessionModal.tsx / chat.go /
last_harness_test.go + worklog),无 AGENTS.md、无 RAK 运行时文件;工作树干净。
✅

## gate

- `go build ./... && go vet ./internal/chat/ ./internal/store/`:CLEAN(仅 macOS SDK ld 告警,
  非错误)。
- `go test ./internal/chat/ -run TestCreateSessionPersistsLastHarness`:PASS。
- `wails3 task build`(含 `wails3 generate bindings` + `tsc && vite build` + go 二进制):
  零 TS 错误,build 成功。

**gate 全绿**——但这正是 Reviewer 要警惕的「build 绿 ≠ 行为对」:编译 / 测试通过,但 issue
要求的「没选过则无默认」行为完全未实现(且做了反面)。

## 结论

**NEEDS CHANGES**。① 持久化 / ④ 后端接口+单测 / ⑥ 无夹带 三条 PASS,gate 全绿;但 issue 的
**第二条核心要求「没选过则不设默认,要求显式选择」整条未落地**——② / ③-sub2 / ⑤ 三条 FAIL,
且实现主动做了相反行为(硬选首个、harness state 永不为 null、canConfirm 无 harness 守卫、
无「请选择」提示)。这是典型的「改了类型 / 加了 prop 但目标行为没变」空壳:前端多了
lastHarness 预取与传参,但「显式选择」这一行为变更缺席。

## 修复建议(给 coder)

聚焦 `frontend/src/components/NewSessionModal.tsx`,照抄同弹窗 worktree null 范式:

1. **harness state 改 `string | null`**,初值只在「lastHarness 命中可选列表」时取 lastHarness,
   否则 `null`(去掉 `harnesses[0]?.id || "omp"` 回退):
   ```ts
   const [harness, setHarness] = useState<string | null>(
     lastHarness && harnesses.some((h) => h.id === lastHarness) ? lastHarness : null,
   );
   ```
2. **canConfirm 加 harness 守卫**:`const canConfirm = harness !== null && (!isGit || worktree !== null);`
3. **harness label 加未选提示**(对照 `:67`):
   ```tsx
   <div className="ns-label">
     {t("newSession.selectAgent")}
     {harness === null && <span className="ns-required">{t("newSession.required")}</span>}
   </div>
   ```
4. **onConfirm 传参**:已在 `canConfirm && onConfirm(...)` 守卫内,harness 此时非 null;
   TS 可能需 `harness!` 或在守卫分支内取值。
5. **单 harness(可选,KISS)**:若 `harnesses.length === 1`,可自动选中那唯一项(无歧义、免
   纯摩擦);多 harness 必须显式选。是否做单 harness 自动选中由 issue 方裁定,但不影响多
   harness 必须显式选这一核心。
6. harness 按钮 `active` 判定 / radio `on` 判定已用 `harness === h.id`,null 时全不亮,天然
   正确,无需额外改。

修完重跑 gate(`go build/vet/test` + `wails3 task build` 零 TS 错误)。

## 改了哪些文件

- `docs/worklog/2026-07-22-review-remember-last-harness.md`(本文件)。
