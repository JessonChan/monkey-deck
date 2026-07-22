# 2026-07-23 review:harness 更新感知(定时检查+红点+自动检查开关)端到端验收(Task #22124 / Review #43)

## 起因
Review #43(被审三 commit:Task #22121 后端 `281cd41` 周期 ticker + check_harness_updates 设置开关 /
Task #22122 UI `92b1a9e` 红点 + 自动检查开关(绑定后端)/ Task #22123 `d877338` rebase 调和 worklog)。
Reviewer 职责:不只「编过 + 测过」,要证明**三件事行为真的实现了**,防「改签名/加字段但函数体不变、
build 绿但行为没生效」:
1. **定时检查**:后台周期 ticker 真的周期跑 refreshHarnessesAsync,关掉开关真的停。
2. **红点**:任一 harness 有 upgradeAvailable 时,齿轮入口 + 设置内 models 菜单真亮红点;ticker 刷新后红点真跟着更新。
3. **自动检查开关**:开关真绑后端 SQLite 设置(单一真相源),toggle 实时启停 ticker。

## 验证做了什么

### 1. 环境对齐(全绿)
- `make bindings`(wails3 generate bindings):67 methods,含 `GetCheckHarnessUpdates` /
  `SetCheckHarnessUpdates` —— 前端 binding 真生成了(防「Go 加了方法但前端用旧 binding」)。
- `go build ./internal/...` / `go vet ./internal/...`:干净。
- `gofmt -l internal/chat/*.go`:干净。
- `go test ./internal/...`:全包绿(acp/chat/config/fsview/harness/permissions/store/terminal/titlegen/ui/update/worktree)。
- `bun run build`(tsc + vite production):通过(仅既有 chunk>500kB 旧 warning)。
- `bun test`:**97 pass / 0 fail**(原 92 + 本次新增 5)。

### 2. 设计前提核对(读源码,非盲信 worklog)
- **后端 ticker**(`internal/chat/chat.go`):
  - `harnessRefreshLoop`(stop/ctx.Done/ticker.C 三路 select),`refreshHarnessesAsync` 末尾 `s.emit(EventHarnesses, nil)`(`chat.go:2070`)→ **ticker 每周期真会推事件让前端重拉**。✓
  - `startHarnessRefresh`/`stopHarnessRefresh` 幂等(`s.mu` 保护 stop/done channel,nil 字段守卫;stop close 后等 `<-done` 落定,不泄漏)。✓
  - `SetCheckHarnessUpdates` 写 SQLite 后**立即** start/stop ticker(实时启停,不等重启)。✓
  - 默认 `harnessRefreshEvery: time.Hour`(`NewChatService`),`checkHarnessUpdatesSetting()` 默认 true(开箱即得)。✓
- **前端事件链**(`App.tsx:299-303`):启动 `ListHarnesses` + 订阅 `chat:harnesses` → 重拉 → `setHarnesses` →
  `harnessUpdateAvailable = useMemo(harnesses.some(upgradeAvailable))`(`App.tsx:71-74`)→ prop 传 Sidebar 齿轮 +
  SettingsPanel models 导航项。**端到端链路每一环都核实存在**(§1.6 现实面 = SessionUpdate/事件流;此处是 harness 事件流,同理)。
- **单一真相源**:rebase 调和(commit `92b1a9e`)+ worklog `2026-07-23-restore-22122-…` 确认**删掉**了失败分支的前端重复机制
  (`lib/harnessAutoCheck.ts` localStorage + App.tsx 6h setInterval + settingsStore.harnessAutoCheck 字段),
  HarnessPane 开关直接绑后端 `GetCheckHarnessUpdates`/`SetCheckHarnessUpdates`。✓ 避免「前端开关只控前端定时器、后端 ticker 照跑」的双机制破口(§5.3 Less is More)。

### 3. 后端单测有效性核对(防「测了但没测行为」)
`internal/chat/harness_test.go` 5 测全绿(`-race -v`):
- `TestHarnessRefreshTicker_RunsPeriodically`:**核心**——注入 15ms 短间隔 + emitHook 计数,断言
  `EventHarnesses` 触发 ≥3 次(证明 ticker 真周期跑),`SetCheckHarnessUpdates(false)` 后等 5 个周期不再增长
  (证明关掉真停)。**不是空断言,真验行为。** ✓
- `TestSetCheckHarnessUpdates_PersistsAndReadsBack`:写 false 读回 false、写 true 读回 true(持久化往返)。✓
- `TestGetCheckHarnessUpdates_DefaultTrue`:缺省默认 true + `GetConfig.checkHarnessUpdates == "true"`。✓
- `TestHarnessRefreshToggle_Idempotent`:双 start / 双 stop / 再开再关不 panic。✓
- `TestSettingBool`:解析工具 15 用例。✓

### 4. 前端端到端验收测试(本次新增 `HarnessUpdateAwareness.mount.test.tsx`,5 用例)
真 React 树挂载 + mock 后端 binding(可观测 + 可控),断言前端可观测行为真生效:
- **自动检查开关绑定后端**:mount 调 `GetCheckHarnessUpdates`,`aria-checked` 反映后端值;点开关 → 调
  `SetCheckHarnessUpdates(false)`(翻转值),`aria-checked` 翻转;后端报错 → UI 回滚原值(防「渲染了但不接后端」)。
- **红点条件渲染方向**:`harnessUpdateAvailable=true` → models 导航项有 `.update-dot`(且非 models 分类无);
  `=false` → 无 `.update-dot`(防 className 加了但条件写反)。

(后端「定时检查」周期性由后端单测守卫,前端不重复;前端只覆盖可观测的开关绑定 + 红点渲染。)

## 验收结论
**PASS**。三件事(定时检查 / 红点 / 自动检查开关)行为真实生效,端到端链路完整(ticker→事件→前端重拉→红点刷新),
单一真相源(后端 SQLite + 后台 ticker,无重复机制),无回归。新增 5 前端 mount 测 + 既有 5 后端测作回归守卫。

## 观察(非阻塞,记录供后续判断)
- **`HarnessSettings.tsx` 注释与代码不符(非 bug,代码对)**:`toggleAutoCheck` 上方注释写「失败不回滚 UI」,
  但 catch 块实际 `setAutoCheck(!next)` **会回滚**。代码行为(回滚)更优,我的前端测 #3 据此断言回滚成立;
  注释是 stale/错误,建议择机改成「失败回滚 UI 到原值」。(不阻塞,行为正确且有测守护。)
- **`SettingsPanel.tsx` 红点 className 冗余(非 bug)**:`settings-nav-item has-update-dot` 对**所有**分类导航项
  无条件加 `has-update-dot`(`position:relative`),但只有 models 分类渲染 `.update-dot` span。对非 models 项
  是无副作用冗余;更干净是按 `dot` 条件加 class。不影响功能。

## 改了哪些文件
- `frontend/src/components/HarnessUpdateAwareness.mount.test.tsx`(新增):harness 更新感知前端端到端验收 mount 测(5 用例)。

## 下一步
- (可选)桌面 app 实测(`wails3 dev`):有 upgradeAvailable 的 harness 时齿轮 / models 导航亮红点;
  HarnessPane 开关关掉 → 后端 ticker 停 → 重启 app 开关状态保持(SQLite 持久化)。
- (可选)择机修 `HarnessSettings.tsx` toggleAutoCheck 注释(与代码回滚行为对齐)。
