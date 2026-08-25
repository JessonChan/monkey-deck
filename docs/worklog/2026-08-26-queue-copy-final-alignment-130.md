# 2026-08-26 #130 文案终对齐:scheduleCap 与 chip 格式两键字面替换(Task #24303)

## 起因
#130 累加式定时预设多轮落地(累加 #24298 → 拒绝语义 #24300 → ✕ 重置+tip 对齐 #24301)过程中,
两处用户可见文案与 issue #130 **钉死的原始字面**发生了漂移。本轮终对齐:只做这两键的
精确 old→new 替换,不改行为、不碰其它键。

GitHub issue 评论在执行环境不可达(API 凭据失效,与前几轮 worklog 记载一致),钉死文案以
issue #130 正文(环境内 `issue130.txt`)为准:

- §2:「累计 chip:schedule 编辑行内显示 `+Xm → HH:MM`(累计时长 + 到点时刻,X = 累计分钟,
  到点 = 当前累计结果的绝对时刻)」
- §3/§5:「行内提示『最长 24 小时』」/ "Up to 24 hours"

## 替换(精确 old→new)
| 键 | 旧 | 新 |
|---|---|---|
| `queue.schedulePending`(zh) | `⏱ {{remaining}}后 · {{time}}` | `+{{mins}}分 → {{time}}` |
| `queue.schedulePending`(en) | `⏱ in {{remaining}} · {{time}}` | `+{{mins}}m → {{time}}` |
| `queue.scheduleCap`(zh) | `超出 24 小时上限,已忽略` | `最长 24 小时` |
| `queue.scheduleCap`(en) | `Exceeds the 24h cap — ignored` | `Up to 24 hours` |

## 改法
- `frontend/src/i18n/locales/zh.json` / `en.json`:上表四条字面替换,插值参
  `{{remaining}}` → `{{mins}}`、`{{time}}` 不变,zh/en 成对同参(`locales.test.ts` 过)。
- `frontend/src/components/QueuePanel.tsx`:chip 的 `t()` 调用改传
  `mins: Math.round((pendingAt - now) / 60_000)`(替换字面后模板引用 `{{mins}}`,必须喂参,
  这是字面替换的组成部分,非行为改动)。`{{remaining}}` 的其它消费方(queue-countdown 徽标)
  不动,`formatRemaining` 仍有真实消费端,无死代码。
- **X 的口径**:chip 底层量不变——暂存时刻相对 now 的时长(与旧「剩余倒计时」同一来源,
  统一覆盖预设叠加 / 手动 pick / seed 三条路径),按 `+Xm` 格式取整分钟。
  用 `Math.round` 而非 `ceil`:issue DoD「+5 点两下 → 显示 +10m」要求点击后立即精确显示
  累计值(round 在 10m+ε 时仍显示 10,ceil 会显示 11)。
- `scheduleCap` 换成「最长 24 小时」后与 `schedulePendingTip`(「最多 24 小时,超出不生效」/
  "at most 24h ahead — beyond that is ignored")仍同口径(拒绝语义、上限 24h),tip 不动(勿做其它)。
- 组件内 chip 注释随格式改一字("remaining + clock" → "+mins → clock")。

## 改了哪些文件
- `frontend/src/i18n/locales/zh.json` / `en.json`(各 2 键)
- `frontend/src/components/QueuePanel.tsx`(1 处 t() 参数 + 相邻注释)

## 验证
- 环境:worktree 补 `bun install` + `wails3 generate bindings`(与前几轮口径)。
- `bun test src/components/QueuePanel src/i18n`:**32/32 过**(mount 测试只锚 chip/cap 的
  存在性,不锚文案,替换零破坏)。
- `bunx tsc --noEmit`:0 错误。`bun run build`:过(chunk 体积警告既有)。
- 全量 `bun test`:**269 pass / 6 fail / 1 error = 最新 review 基线完全同集**
  (NewSessionModal 5 个 `mcpServerIDs` pre-existing + HarnessUpdateAwareness ESM mock 边缘),
  与本改动零交集。无 lint script(不存在)。
- Go 门禁 `go build ./...` + `go vet ./...`:退出码 0(本任务零 Go 改动;macOS ld warning 为
  环境噪音,既有记载)。
- 三端(§4.7/§5.6):纯前端 i18n 文案 + 同构 t() 参数小改,无 CSS/DOM/断点/远程分支触及,
  三端行为一致,无需另验。与前几轮同口径:未做真机/浏览器手动冒烟(mount 测试 + 构建为实证)。

## 下一步
- 沿 #24299 review OPEN:onChange 手选 / ✕ 重置 / chip 新格式 `+Xm → HH:MM` 的真浏览器
  E2E / 真机冒烟(一次覆盖全部新路径)。
- 既有:NewSessionModal.mount 5 个 pre-existing 失败(`mcpServerIDs`)另任务处理;
  QueuePanel 原生 title → react-tooltip 迁移(§4.5)仍是队列级清理任务。
