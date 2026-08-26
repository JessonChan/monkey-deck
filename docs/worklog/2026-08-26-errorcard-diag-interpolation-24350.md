# 2026-08-26 #46 步骤 3 前端:ErrorCard 按分类码插值 ResetAt/RootCause/Attempts + 兜底链(Task #24350)

## 起因

闭合 review #24347 P3-3:#46 步骤 2(后端分类器 + `emitErrorDiag` payload)已入 main,
`types.ts` 也镜像了 `rootCause/resetAt/attempts`,但**前端零消费**——GUI 只显通用配额文案
(`t(\`chat.error.${code}\)`),不含重置时刻。这是探针 §C-3「用户丢信息」的另一半,
也是 #46 关闭前提。

## 改动(纯呈现层,不动 types.ts 契约与后端)

### 1. `frontend/src/lib/errorDiag.ts`(新,纯函数)

- `renderChatError(s: StatusPayload, l10n: DiagL10n) → {message, secondary}`:按稳定
  code 前缀分流(前缀匹配,未来同族新 code 同路径):
  - **quota 族(`provider_quota*`)**:插值 resetAt(人话「将于 … 重置」);
    **attempts 永不展示**(配额零重试,重试只会再撞墙)。
  - **transient 族(`provider_transient*`)**:重试次数 = attempts-1(attempts 含首发,
    如 4 = 3 次自动重试),≥1 次才用 retried 变体文案;rootCause 作**次要行**。
  - **未知类(有诊断的已知 code)**:i18n 前缀「本轮发送失败:」+ rootCause 原文
    (不翻译——供应商自己的措辞)。
  - 已知 code 无诊断(如 `agent_turn_incomplete`):原样 `t(key)`,逐字不动。
- **兜底链**:key 命中→插值文案;key 缺失→rootCause 原文;两者皆无→detail →
  `app.errorFallback`(既有链保留)。**坑**:i18next 缺 key 时 `t()` 返回 key 串本身,
  末环绝不能 `t(missingKey)`(测试抓到:期望 detail「boom」拿到裸 key)。
- `formatResetAt(raw, locale)`:数字日期时间(bigmodel 实测形态 `2026-08-26 16:32:32`)
  按 naive provider 本地墙钟解析 → 用户 locale 重排格式,**不做时区换算**(后端刻意
  透传原文的原因);非数字文本(en 尾捕「9am tomorrow」)原样透传,不猜语义。
  locale 由 `l10n.language` 驱动(随 UI 语言,不随 OS locale 漂移)。
- `DiagL10n` 为最小 i18n 面(`t/exists/language`),保持纯函数可测;App 侧用
  i18next 单例做模块级适配器(`errorDiagL10n`)。

### 2. `frontend/src/components/ErrorCard.tsx`(新)+ ChatView/App 接线

- ErrorCard:主行(message)+ 次要行(secondary,11px/75% 小字)堆叠;复制按钮
  **复制两行**(`message\nsecondary`),用户可把完整诊断贴走。
- ChatView:`error: string|null` → `error: ChatErrorView|null`,error-bar 渲染替换为
  `<ErrorCard view={...}/>`;`data-testid`:error-bar-card / error-bar-msg /
  error-bar-secondary。CSS 仅新增 `.error-bar-main/.error-bar-secondary`
  (flex column 堆叠),原 `.error-bar` 视觉不动。
- App:`error` state 改持 `ChatErrorView`;~30 处纯文本 `setError(msg)`(binding 失败
  路径,无诊断)经机械重命名为 `setErrorMessage`(useCallback 包装,装箱成
  `{message, secondary:null}`,语义不变);`chat:status` error 分支单点改走
  `renderChatError(s, errorDiagL10n)`——session/popout 门控、notice 对称清零等
  周边逻辑逐字未动。

### 3. i18n zh/en 同步新增(§4.4 人话,无裸字段名)

- `chat.error.provider_quota_exhausted_reset`(插 `{{resetAt}}`)、
  `chat.error.provider_transient_error_retried_one/_other`(插 `{{count}}`,复数形态
  占位保持 zh/en leaf-key 奇偶测试通过)、`chat.error.rootCausePrefix`。
- **既有 `provider_quota_exhausted` / `provider_transient_error` 兜底 key 原样不动**
  (覆盖无 resetAt/attempts 的 payload)。

### 4. 测试

- `lib/errorDiag.test.ts`(15 例,真 i18next 实例 + 真 zh/en JSON):三路插值
  (quota 显「将于 2026年8月26日 16:32 重置」/transient 显「已自动重试 3 次」+
  secondary=503 文本/未知显前缀+原文)、兜底链四环(key 缺→rootCause 原文→detail→
  errorFallback)、agent_turn_incomplete 无诊断逐字节不变、attempts=1 无计数、
  formatResetAt 边界(ISO T 形态/非数字透传)。
- `components/ErrorCard.mount.test.tsx`(4 例,happy-dom):payload→view→DOM 端到端
  ——quota 显 resetAt 且无 secondary、transient 显次数 + rootCause 次要行 +
  **复制拼两行**(捕获 Clipboard.SetText 断言)、未知 code 回落 rootCause 原文、
  quota 无 resetAt 用既有通用文案。mini-l10n 用真 zh.json 子树 + i18next 风格插值。

## 验证

- `bun test --isolate` **381/381**(基线 362 + 新增 19);`npx tsc` 零错;
  `npm run build`(tsc + vite production)通过;`go build ./...` / `go vet ./...`
  干净(本条零 Go 改动,构建仅为确认 embed/dist 就绪)。
- 回归:notice 路径、mergeResult/error-bar 其余视觉、locales zh/en leaf-key 奇偶
  测试全过(新增 key 双语同步)。
- 三端(§4.7/§5.6):改动是同一份 React 呈现层,无端特定分支(无 isRemoteClient /
  coarsePointer / PWA 门控触及);error-bar 在三端同一渲染路径,桌面 GUI 冒烟由
  mount 测试 + build 覆盖,浏览器/PWA 端共享同一组件与 event payload(后端未动),
  无需逐端手工冒烟。

## 踩坑

- 执行中 worktree 再次被外部重置一次(与 #24346 同款中断),全部改动丢失;按上下文
  完整重建后**立即 `git add` 落暂存区**再跑门禁,防再次丢失。
- i18next 缺 key 时 `t()` 返回 key 本身:兜底链末环如果 `t(缺失key)` 会把裸 key
  显给用户(测试先行抓到),修正为 detail→errorFallback 直取。

## 下一步

- #46 可关:探针(§C-3 用户丢信息)→ 后端分类/重试/payload(#24346)→ 前端呈现
  (本条)全链闭合,待 orchestrator 复核关闭。
- 观察:真实 en 形态 provider(Anthropic/OpenAI 系)的 resetAt 尾捕文本在 UI 的
  透传效果;发现新形态再补 `resetTimePatterns` 锚点(后端侧)。
