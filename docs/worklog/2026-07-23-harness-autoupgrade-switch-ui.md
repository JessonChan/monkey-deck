# 2026-07-23 前端:#53 自动升级子开关 UI(挂 check_harness_updates 下 + tooltip 风险 + GetConfig 接线)

## 起因
Task #22941。后端 `auto_harness_upgrade` 设置 + ticker hook(Task #22385,见
`2026-07-23-auto-harness-upgrade-setting-ticker.md`)已落地:`GetAutoHarnessUpgrade` /
`SetAutoHarnessUpgrade` binding 已生成、`GetConfig["autoHarnessUpgrade"]` 已暴露。本任务补
**前端 UI**:HarnessSettings 面板加「自动升级 harness」子开关,绑后端;并向用户说明这是
「静默跑官方安装脚本」的风险行为(默认关闭的原因)。

## 设计
- **挂在「自动检查」开关下**:新增一个 `.settings-row.is-sub`(缩进 + 左侧 accent 边线)
  放在 `harness-autocheck-row` 之后。两开关**独立**(后端 OR 语义:任一开即跑 ticker),
  不做「关掉 check 就 disable auto」的父子耦合——后端 `refreshTickerNeeded()` 已是 OR。
- **GetConfig 接线(关键)**:HarnessPane mount 时**一次** `GetConfig()` 取回
  `checkHarnessUpdates` + `autoHarnessUpgrade` 两个字段(取代原来单独调
  `GetCheckHarnessUpdates`),把两个开关的初值都接上 GetConfig 这个后端聚合只读快照——
  这正是任务标题里的「GetConfig 接线」。写仍走各自 setter(`SetCheckHarnessUpdates` /
  `SetAutoHarnessUpgrade`),它们实时启停后台 ticker。失败回滚 UI(与既有 autoCheck 一致,
  顺手修了 review #43 指出的 toggleAutoCheck 注释 stale:注释说「不回滚」但代码其实回滚)。
  缺省 / 解析失败兜底 `autoCheck=true / autoUpgrade=false`,与后端默认一致。
- **tooltip 风险**:整行带 `data-tooltip-content=autoUpgradeRiskTip`(react-tooltip `md-tip`,
  §4.5),标题前加 `AlertTriangle`(amber `#ff9f0a`,与 `.harness-badge.warn` 同色)做视觉
  警示。文案(en/zh)明确:「无人值守下运行官方安装脚本(联网 / 写磁盘 / 可能重启服务或改动
  环境),仅在你信任上游安装器时开启」。

## 改了哪些文件
- `frontend/src/components/HarnessSettings.tsx`:
  - mount 初值由 `GetCheckHarnessUpdates` 改为 `GetConfig`(一次取两字段)。
  - 新增 `autoUpgrade` state + `toggleAutoUpgrade`(绑 `SetAutoHarnessUpgrade`,失败回滚)。
  - 新增「自动升级」子开关行(`is-sub` + 风险 tooltip + AlertTriangle)。
  - 修 toggleAutoCheck 注释 stale(实际是回滚)。
- `frontend/src/index.css`:`.settings-row.is-sub`(缩进 + accent 左边线)+ `.harness-risk-icon`。
- `frontend/src/i18n/locales/{en,zh}.json`:`settings.harness.autoUpgrade{Title,Desc,RiskTip}`。
- `frontend/src/components/HarnessUpdateAwareness.mount.test.tsx`:
  - mock 由 `GetCheckHarnessUpdates` 改为 `GetConfig`(返两字段);新增 `SetAutoHarnessUpgrade` mock。
  - 新增 4 用例:GetConfig 接线(两开关初值 / autoUpgrade=true 子开关亮)、自动升级子开关
    toggle / 失败回滚 / 风险 tooltip 存在。原 autoCheck 3 用例保留(改读源)。

## 验证
- `make bindings`:69 methods(含 `GetAutoHarnessUpgrade` / `SetAutoHarnessUpgrade`)。
- `cd frontend && bun run build`(tsc + vite production):通过(仅既有 chunk>500kB 旧 warning)。
- `cd frontend && bun test`:**113 pass / 0 fail**(原 97 + 本次净增 16:扩 harness 用例 +
  其余既有用例)。含新增的 GetConfig 接线 / 自动升级 toggle / 回滚 / 风险 tooltip 断言。
- `go build ./...` / `go vet ./...`:干净(本次无 Go 改动,后端 #22385 已就绪)。

## 下一步
- 实机验证(`wails3 dev`):HarnessSettings 面板「自动检查」下方出现「自动升级」子开关(缩进 +
  警告图标);hover 行弹出风险 tooltip;开关绑后端 SQLite(auto_harness_upgrade),重启 app 状态保持。
- (可选)若后续要让「自动升级」在「自动检查」关闭时也可见地提示「仍会跑」,可在子开关 desc
  补一句;当前 OR 语义已在 desc 说明,先不增复杂度。
