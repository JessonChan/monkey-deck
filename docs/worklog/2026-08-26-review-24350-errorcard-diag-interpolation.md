# 2026-08-26 Review #24351 审 #24350:ErrorCard 分类插值前端呈现 —— APPROVE(P3×2,无 P1/P2)

## 起因

Task #24351:审查 #24350(commits `48b2266` 功能 + `60d4fcd` worklog)是否闭合
review #24347 P3-3——`emitErrorDiag` payload(rootCause/resetAt/attempts)在
types.ts 镜像后前端零消费,GUI 只显通用配额文案不含重置时刻。这是 #46 关闭前提。

方法:反向追踪消费链(反类型补丁)——从 StatusPayload 三个镜像字段出发逐调用点
确认真实消费,不顺着 commit 叙事走;两处 i18next 外部行为假设(显式 `_other` key
的复数解析、模块级 `language` 捕获的时序)**用探针脚本实证**,不凭记忆;门禁亲跑
(worktree 自建 `bun install` + `wails3 generate bindings` 补 gitignored 中间产物)。

## 逐点核对(任务清单)

### 1. 消费链真实通电(反类型补丁)—— 过

- **接线全链**:`emitErrorDiag`(chat.go:540)→ Go json tag `rootCause/resetAt/
  attempts`(chat.go:70-78,与 types.ts 镜像逐字一致)→ App.tsx:587
  `setError(renderChatError(s, errorDiagL10n))`(单点,error/notice 门控逐字未动)
  → ChatView `error` prop(App.tsx:2233)→ ErrorCard(ChatView.tsx:815)。App 内
  其余 ~30 处 `setError` 全部走 `setErrorMessage` 装箱,无裸字符串残留(grep 实证
  仅剩 587 一处结构化调用)。
- **resetAt**:quota 分支插值进 `provider_quota_exhausted_reset`,单测 + mount 测试
  双锚定「将于 2026年8月26日 16:32 重置」(探针 §A 事件 1 时刻);quota 显式
  `.not.toContain("重试")`——attempts 永不进 quota 文案(零重试语义,设计如此)。
- **attempts**:transient 分支 `retries = attempts-1` 插值「已自动重试 3 次」,
  mount 断言锚定具体文本 + 复制按钮拼两行(`\n` + 503 原文)。
- **rootCause**:transient 次要行(11px/75% 小字)、未知类前缀+原文、key 缺失回落
  原文,三处消费都有锚定测试。

### 2. 兜底链三层完整 —— 过

- key 命中→插值文案;key 缺失→rootCause 原文(errorDiag.ts:91);皆无→
  `detail || app.errorFallback`(errorDiag.ts:96)——与旧 App 逻辑语义一致。
- **顺带修了一个潜伏 bug**:旧代码对「有 code 但 key 缺失」会 `t(missingKey)`
  把裸 key 串显给用户(i18next missing-key 行为);新链路永不 t 缺失 key(worklog
  踩坑小节如实记录,测试先行抓到)。
- `agent_turn_incomplete` 无诊断路径逐字节不变(单测断言 `toBe(zh.json 原文)`)。

### 3. i18n zh/en 同步 + §4.4 —— 过

- 4 个新 key(`provider_quota_exhausted_reset` / `provider_transient_error_retried_
  one` / `_other` / `rootCausePrefix`)zh/en 双语同步;leaf-key 奇偶测试
  (locales.test.ts)锁死不会单侧漂移。
- 既有 `provider_quota_exhausted` / `provider_transient_error` 两 key 逐字未动
  (diff 上下文行实证)。文案人话、无裸字段名、无 JSON。

### 4. mount 测试锚定值 —— 过

- 4 例全部断言具体文本(见 §1),非「字段存在/节点存在」;复制按钮经
  Clipboard.SetText mock 断言两行拼接。15 例单测跑真 i18next 实例 + 真 zh/en JSON,
  连 shipped 文案一起锚定(en-US「Aug 26, 2026」「4:32」)。

### 5. 时间格式本地化 —— 过

- `formatResetAt` 正则只认 `YYYY-MM-DD[ T]HH:MM[:SS]`,按 naive provider 墙钟
  构造 Date(无 TZ 换算——后端透传原文的语义保持),`toLocaleString(locale)`
  重排格式;NaN guard + try/catch 双兜底,不存在 Invalid Date 路径;非数字文本
  (「9am tomorrow」)原样透传不猜语义。月 13 滚动等畸形输入走 never-worse 契约
  (测试注释如实声明)。

### 6. 只改呈现层 —— 过

- types.ts 对 parent 的 diff 为 0 行;commit 只触 frontend/ 九个文件,后端零改动。

### 7. 门禁亲跑 —— 过

- `bun test --isolate` **381/381**(基线 362 + 新增 19);`tsc --noEmit` 零错。
  首跑 8 fail 全是 worktree 缺 gitignored 中间产物(bindings/node_modules),
  `bun install` + `wails3 generate bindings` 补齐后全绿——与 #24347 review 同款
  环境步骤,非代码问题。

## 实证探针(两处外部行为假设)

1. **显式 `_other` key + `{count:1}` 在 en 的解析**:探针实测
   `t("..._retried_other", {lng:"en", count:1})` → **"auto-retried 1 times"**
   (i18next 不回退到 `_one` 变体;`_one` 后缀只在对 base key 传 count 时参与解析)。
   → P3-1 的实证依据。
2. **模块级 `language` 捕获时序**:`i18n.language` 在 init 时同步置位(import 时
   即 "zh"),启动期格式化 locale 正确;但 `changeLanguage("en")` 后模块级捕获值
   不随动。→ P3-2 的实证依据。

## 发现汇总

| 级别 | 发现 | 位置 | 建议 |
|---|---|---|---|
| P3-1 | en `provider_transient_error_retried_one` 是死 key:渲染器硬编码 `_other` 后缀,i18next 对显式 `_one`/`_other` key 传 count 不做复数回退(探针实证),`_one` 永不被解析;若未来 retries==1 可渲染(promptRetryLimit 调小时)会显「1 times」语法瑕疵。当前不可达:transient 只在全 3 次重试耗尽后发射(attempts 恒 4),重试途中撞 quota 发的是 quota 码 | errorDiag.ts:50 + en.json | 改传 base key 让 i18next 按 count 解析 `_one/_other`,或删两侧 `_one` key(YAGNI) |
| P3-2 | `errorDiagL10n.language` 模块级一次捕获:运行时切语言(SettingsPanel setLanguage)后,resetAt 日期格式仍用启动 locale(中英混排,仅格式不匹配,信息无损);worklog「随 UI 语言」的说法在切语言后不成立 | App.tsx:51-56 | 改 `get language() { return i18n.language; }` 一行修复 |

两条均为呈现打磨,不影响任何可达路径的正确性,不阻塞 #46 关闭。

## 结论

**APPROVE**。P3-3 闭合:三个 payload 字段全链通电(接线单点、锚定测试双覆盖)、
兜底链三层完整且顺带修了裸 key 串显用户的潜伏 bug、zh/en 同步有奇偶测试锁死、
时间格式无 TZ 漂移无 Invalid Date、呈现层零契约改动、门禁亲跑全绿。P3×2 记录
在案,下次触及顺带修即可。

## 验证

- 门禁输出见 §7;探针脚本见「实证探针」(跑后即删,未入库)。
- 本 review 未改任何产品代码;worktree 生成的 bindings/node_modules 为 gitignored
  中间产物,`git status` clean。

## 下一步

- orchestrator:#46 全链(探针 → #24346 后端 → #24350 前端)已闭合,可复核关闭。
- coder(顺带,不阻塞):P3-1 复数 key 解析方式、P3-2 language getter,下次触及
  errorDiag/App 接线时一并处理。
