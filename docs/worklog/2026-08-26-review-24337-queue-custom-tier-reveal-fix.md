# 2026-08-26 Review #24337 快审 #24336:自定义档 reveal + Apply tooltip + wrap —— 缺口闭合复验

## 起因

Task #24337:复验修复 commit `c511e93`(Task #24336)是否真实闭合 review #24335
(`docs/worklog/2026-08-26-review-24335-queue-repeat-frontend.md`,REQUEST_CHANGES)的缺口。
审查范围**仅限缺口闭合核对**,不做全量重审(binding/wire/i18n/触控等 #24335 已 PASS 的门槛
不重复)。方法:反向追踪——不顺着修复 commit 的叙事走,从 review 点名的每个缺口出发,在
当前代码逐点确认接线 + 亲自跑测试/类型门。

## 缺口逐项核对

### P1 自定义档不可达(阻塞)—— 闭合,实证

按 review 指定修法逐点核对(当前文件行号):

- `customTierOpen` 本地 reveal state 存在(QueuePanel.tsx:73);
- `applyRepeatTier("custom")` → `setCustomTierOpen(true)` 后 return(:229);**选预设档先
  `setCustomTierOpen(false)` 再提交**(:230)——review 文字没明写但必要(否则从 custom 切
  预设后 select 永显 custom、输入框藏不掉),修复方正确识别并补上;
- 复位点齐全:`startSchedule`(:135,覆盖开行/换行目标)、`resetStaging`(:145,被
  cancel :147 / staged-chip ✕ :152 / save 路径 :180/:187 调用)——reveal 不泄漏出关闭的行,
  与 pendingAt/scheduleCapped/repeatError 同一套 staging 纪律;单 flag 配单 `schedulingId`
  (同时只开一行)作用域正确;
- select 显示值 `customVisible ? "custom" : tierValue`(:449)、输入框渲染条件 `customVisible`
  (:461),`customVisible = customTierOpen || tierValue === "custom"`(:271)——**OR 上镜像的
  奇数间隔判定,legacy 奇数间隔项不加 flag 也保持输入框可见 + 分钟预填**(seeding 不回归);
  同时解决 review 点名的「旁路重渲染(ticker/快照)把 select 弹回不重复」——受控值不再纯读镜像。

**测试锚定质量(本次复验重点,反模式清单「断言锚定可达性」)**:新增 3 例 mount 用例锚的
是**生产可达状态**——普通项(`repeatEveryMs: 0` 的 `item("q1")`,非注入奇数镜像)→ 选 custom
→ select 显示 "custom" + `queue-repeat-custom` 非 null + **`calls` 长度 0**(提交前零提交)→
输入 7 → Apply → `onSetRepeat("q1", 7*60_000)` 锚定奇数毫秒值。这正是 #24335 点名的漏报形态
(旧测试注入不可达状态 `repeatEveryMs: 7*60_000` 掩盖死路径)的反面。另 2 例:reveal 不泄漏
出关闭的行(cancel → 重开 → select 回 "0"、输入框消失、零提交,props 未变证明是本地 reset)、
预设切换清 reveal(提交 `5*60_000` 锚定值 + 输入框消失)。

**亲跑**:`bun install`(worktree 缺 node_modules)后 `bun test src/components/QueuePanel`
→ **40 pass / 0 fail**(178 expect),与 commit message 声称一致。

### P2 Apply 按钮原生 title(阻塞)—— 闭合

- `title` 已移除,react-tooltip 三件套齐:`data-tooltip-id="md-tip"` +
  `data-tooltip-content={t("queue.repeatApplyTip")}` + `aria-label`(QueuePanel.tsx:484-486),
  与同特性徽标 ✕ 同形;
- anchor 实证存在:`<Tooltip id="md-tip" …hidden={coarsePointer}>`(App.tsx:2477),触屏隐藏
  行为与全局一致;
- 文件内残留 11 处原生 `title`(:310-:617)全部为 #24335 明确裁定「历史欠账、不属本 diff」的
  旧代码——P2 仅要求清除**本次新增**实例,该实例已清;
- i18n:无新键;所用 `queue.repeatApplyTip` zh/en 双侧存在(zh.json:412 / en.json:412),同步。

### P3 桌面自定义行 wrap(非阻塞备查)—— 顺手闭合

- `.queue-item-edit` 基础规则加 `flex-wrap: wrap; row-gap: 6px`(index.css ~:1525):宽窗口
  无溢出 → 无 wrap 渲染不变,窄桌面窗口换行不溢出卡片;
- ≤768px 断点内冗余的 `.queue-item-edit { flex-wrap: wrap; }` 删除(Less is More),移动端净
  计算值不变;断点块内其余规则(flex-basis 100% 家族)完好仍在 `@media (max-width: 768px)`
  块内。

## 验证(本次亲跑)

- `bun test src/components/QueuePanel`:40/40 全绿。
- `wails3 generate bindings` 重新生成(worktree 缺 gitignore 中间产物,298 包/133 方法/26 模型)
  → `bunx tsc --noEmit` **干净**(生成前 3 个 TS2307 均为 bindings 缺失的 worktree 环境问题,
  与 c511e93 无关;生成后清零,证明无类型回归)。
- CSS media 块完整性目检:改动行仍处断点块内,选择器/花括号配对无误。
- #24336 修复 worklog(`2026-08-26-review-24335-fix-custom-tier-reveal-apply-tooltip.md`)
  的叙述与代码实测一致,无超claim。

## 结论

**APPROVE**——#24335 的两个阻塞项(P1 自定义档不可达、P2 原生 title)真实闭合,测试以
可达状态 + 锚定值(7*60_000 / 5*60_000 / 零提交)钉住修复;P3 亦顺手处理。非阻塞小记:

1. **P4(nit,纯空白)**:≤768px 断点块内被删行下方的两行(`.queue-item-actions` /
   `.queue-schedule-error` 家族)缩进从 2 空格变 3 空格——疑为删行时编辑器残留,无功能影响,
   后续碰到该块顺手对齐即可。
2. 沿袭 #24335 的 FYI(i18n `repeatSent` 复数、原 commit 键数勘误)继续备查,无需动作。

## 下一步

- 无阻塞项;队列循环发送(#111 前端)链路至此 review 通过,可随整体功能收尾。
