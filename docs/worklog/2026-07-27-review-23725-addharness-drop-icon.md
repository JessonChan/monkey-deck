# 2026-07-27 Review #23725 去掉 AddHarness icon 字段端到端验收

## 起因

Task #23727。Review #23726(去掉 AddHarness 入口的 `icon` 字段:modal 输入框 +
后端签名 + i18n 四条 key)。作者叙述「三层都清了 + regen bindings + rg 扫无残留」,
按 reviewer playbook(「类型补丁」反模式 / 顺着作者叙事走会直接判 PASS)反向逐跳
验证字段真的从入口到末端全部消失,而不是「字段不存在」。

## 验证项(逐跳手验,非断言字段存在)

1. **Go 签名**(`internal/chat/chat.go`):`AddHarness(id, name, command string)`,
   `icon = strings.TrimSpace(icon)` 行与字面量 `Icon: icon` 均删,append 仅 3 字段。✅
   (后端不在本 reviewer 职责,仅作前端调用对齐的上游事实确认。)
2. **前端调用点**(`AddHarnessModal.tsx:71`):
   `ChatService.AddHarness(id.trim(), name.trim(), command.trim())` —— 3 实参,
   与新签名对齐;`icon`/`setIcon` state、Icon 输入框 JSX、`addIcon*` i18n 引用全部消失。✅
3. **Binding 对齐**(关键:worklog 声称 regen,但 `frontend/bindings/` 是 .gitignore
   中间产物,worktree 里根本不存在,看不见就验不了):
   本 worktree 自跑 `wails3 generate bindings`(alpha2.117)→
   `frontend/bindings/.../chatservice.js` 导出 `AddHarness(id, name, command)`,
   与 Go 签名 / 前端调用实参三方一致。✅
   - **坑提醒**:bindings 不入库,worktree checkout 后是空的,review 想验 binding 对齐
     必须自己 regen 一遍(或读主检出),不能信 diff stat。
4. **tsc**:本 worktree `bun install` 后 `./node_modules/.bin/tsc` exit 0,无类型残留。✅
5. **i18n 同步**:zh/en 两份 `settings.harness.*` 各 42 条 key(脚本对比,无 zh-only /
   en-only),4 条 `addIcon*` 对称删除,JSON 均合法。✅
6. **testid / 键盘导航**:残留 testid `ah-id/ah-name/ah-command/ah-err/ah-cancel/ah-confirm`;
   `ah-icon` 已删;Esc(全局 keydown)+ Enter(每 input onKeyDown)都在;无前端测试
   引用被删 testid。✅
7. **Icon 字段保留的副作用确认**:`Harness.icon`(公开 model 字段,静态注册表填充)
   与本次删除的「用户输入 icon」是两回事,`HarnessIcon` 组件按 `harnessId` 取
   `/harness-icons/<id>.<ext>`,用户自建 harness 无品牌图 → 自然落 lucide `Bot` 兜底,
   即 worklog 所述「空 = 前端兜底图标」。零值无害,保留 `UserHarness.Icon` 不影响前端。✅
8. **无残留扫描**:`rg "addIcon|setIcon|ah-icon"` 在 `frontend/src` 无命中。✅

## 发现的端到端缺口(已修)

作者 worklog 的 `rg` 用 `addIcon|setIcon|ah-icon|, icon\b|icon\.trim`,**漏了 CSS
注释里的 `Icon` 字样**:`frontend/src/index.css:1724`
`/* ─── 添加 harness 弹窗(文本表单:ID/Name/Command/Icon) ─── */` 仍列 Icon。
CSS 规则本身无 `.ah-icon` 孤儿(共享 `.ah-field` / `.ah-hint` 仍在用),仅注释漂移。
已改注释为 `ID/Name/Command`。

> 教训:review 时的「无残留扫描」要扩到注释 / 文档串,不只代码标识符;作者自报的
> grep 模式可能漏一类匹配(这里漏的是「出现在注释里的字段名」)。

## 改了哪些文件

- `frontend/src/index.css`(CSS 章节头注释去 Icon)
- `docs/worklog/2026-07-27-review-23725-addharness-drop-icon.md`(本条)

## 结论

PASS。前端三层(modal 组件 / i18n / binding 对齐)端到端清干净,tsc 绿,i18n 同步,
testid + 键盘导航无回归,`Harness.icon` 公开字段与本次删除正交、保留无害。仅一处 CSS
注释漂移已修。

## 下一步

无。`UserHarness.Icon` 结构体字段与 `effectiveSupported` 的 `Icon: u.Icon` 透传保留
(零值无害,兼容历史持久化);若将来确认彻底不需要,可另起 task 连历史持久化迁移
一起清(已在原 worklog 标注)。
