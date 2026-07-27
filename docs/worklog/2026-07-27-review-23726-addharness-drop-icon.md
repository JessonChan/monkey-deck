# 2026-07-27 Review #23726 AddHarness 去 icon 端到端验收 + i18n 同步回归

## 起因

Task #23728。Review #23726(`refactor(chat): AddHarness 去 icon 参数 + modal 删 Icon 字段 + i18n 删 addIcon*`)。
作者叙述「三层清了 + regen bindings + rg 扫无残留」。前序 review #23725(Task #23727)已 PASS
并修了一处 CSS 章节头注释漂移;本任务做独立逐跳复核,并按 reviewer playbook
(「把不可重复的人肉验证固化成回归测试」)补一条 i18n 同步回归,锁死本 PR 依赖的不变量。

## 验证项(逐跳手验,非断言字段存在)

1. **Go 签名对齐**(上游事实,前端调用对齐用):`internal/chat/chat.go` `AddHarness(id, name, command string)`,
   `icon = strings.TrimSpace(icon)` 与字面量 `Icon: icon` 均删,append 仅 3 字段。✅(后端不在本 reviewer 职责)
2. **前端调用点**(`AddHarnessModal.tsx:71`):`ChatService.AddHarness(id.trim(), name.trim(), command.trim())`
   3 实参;`icon`/`setIcon` state、Icon 输入框 JSX、`addIcon*` i18n 引用全消失。✅
3. **Binding 对齐**(bindings 是 .gitignore 中间产物,worktree checkout 为空,看不见就验不了):
   本 worktree 自跑 `wails3 generate bindings`(alpha2.117)→
   `frontend/bindings/.../chatservice.js:50` 导出 `AddHarness(id, name, command)`,
   Go 签名 / 前端调用实参 / binding 三方一致。✅
4. **tsc**:本 worktree `bun install` 后 `tsc` exit 0,无类型残留。✅
5. **i18n 同步**:zh/en 两份 `settings.harness.*` 各 42 条 key,无 zh-only / en-only;
   4 条 `addIcon*` 对称删除,JSON 合法。✅(已固化为回归测试,见下)
6. **testid / 键盘导航**:残留 testid `ah-id/ah-name/ah-command/ah-err/ah-cancel/ah-confirm`;
   `ah-icon` 已删;Esc(全局 keydown)+ Enter(每 input onKeyDown)都在;无前端测试引用被删 testid。✅
7. **Icon 字段保留的副作用确认**:`Harness.icon`(静态注册表填充)与 `UserHarness.Icon`(结构体字段,
   本次保留以兼容历史持久化)均**不被前端任何组件读取**——`HarnessIcon` 按 `harnessId` 取
   `/harness-icons/<id>.<ext>`,用户自建 harness 无品牌图 → 自然落 lucide `Bot` 兜底。
   `rg "\.icon\b" frontend/src` 仅命中 `.icon-btn`(无关按钮类)。零值无害,保留不影响前端。✅
8. **无残留扫描**:`rg "addIcon|setIcon|ah-icon" frontend/src` 无命中;CSS 无 `.ah-icon` 孤儿规则
   (`.ah-field`/`.ah-hint` 等共享类仍被 ID/Name/Command 三字段使用)。✅

## 不可重复的人肉验证 → 回归测试(本次新增)

reviewer playbook:「Reviewer 的最高价值不是发 PASS,是把一次性、不可 CI 的人肉验证固化成回归测试」。
本 PR 验证 #5 的 i18n 同步此前靠一次性 `node -e` 脚本肉眼比对 zh/en key 数,没有 CI 守护——
下次有人单边改 zh 忘 en,会静默回退到 key 串。新增 `frontend/src/i18n/locales.test.ts`(bun test):

- **不变量**:递归收集两份 locale 的全部 leaf key 路径,断言集合完全一致(zh-only / en-only 均为空)。
- **锚定值**:显式断言已删的 4 条 `addIconLabel/addIconPlaceholder/addIconHint/addIconTip` 不复活
  (Task #23726 regression anchor)。
- **negative control 验证守卫生效**:临时往 zh 注入 `addBogusKey` → 测试 FAIL 报
  `zh-only: ["settings.harness.addBogusKey"]`;还原后 PASS。确认它真守卫不变量,而非断言「字段存在」。

## 改了哪些文件

- `frontend/src/i18n/locales.test.ts`(新增,2 个 test / 12 个 expect)
- `docs/worklog/2026-07-27-review-23726-addharness-drop-icon.md`(本条)

## 验证

- `bun test ./src/i18n/locales.test.ts`:2 pass / 0 fail。
- 全量 `bun test`:140 pass / 7 fail——7 fail 全在 `HarnessPane.*mount` 测试,报
  `ChatService.GetConfig is not a function`(mock 漏 mock GetConfig),**与本次 AddHarness/icon 改动无关**;
  把新测试文件移走后仍 138 pass / 7 fail(同一组失败),证明是 pre-existing,非本任务引入。

## 结论

PASS。前端三层(modal 组件 / i18n / binding 对齐)端到端清干净,tsc 绿,i18n 同步且已固化回归,
testid + 键盘导航无回归,`Harness.icon` / `UserHarness.Icon` 保留字段与本次删除正交、前端零消费、零值无害。

## 下一步

- HarnessPane mount 测试的 `GetConfig` mock 缺失是 pre-existing 问题,建议另起 task 修
  (不在本 review 范围;已在此标注,留待下个 reviewer / 作者认领)。
- `UserHarness.Icon` 结构体字段与 `effectiveSupported` 的 `Icon: u.Icon` 透传保留(零值无害,
  兼容历史持久化);若将来确认彻底不需要,可另起 task 连历史持久化迁移一起清(原 worklog 已标注)。
